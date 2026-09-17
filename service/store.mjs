import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { historyDays } from './history.mjs';
import { meaningfulMessage } from './connectors/message-text.mjs';

const parse = row => row ? JSON.parse(row.data) : null;
const observedSource = (observations, connectorId, fallback) => {
  const observed = observations.map(item => item.source).filter(Boolean);
  const confirmed = observed.filter(item => item.evidence?.startsWith('user-confirmed'));
  const unique = new Map((confirmed.length ? confirmed : observed).map(item => [item.id, item]));
  if (unique.size === 1) return [...unique.values()][0];
  if (unique.size > 1) return { id: `${connectorId}-unknown`, label: '来源待识别', icon: 'message', evidence: 'conflicting observations' };
  return fallback;
};

export class Store {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, 'task-out.sqlite');
    this.db = new DatabaseSync(filename);
    fs.chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, origin TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1;`);
    if (!this.db.prepare('SELECT value FROM metadata WHERE id=?').get('instanceId'))
      this.db.prepare('INSERT INTO metadata VALUES (?,?)').run('instanceId', randomUUID());
    this.instanceId = this.db.prepare('SELECT value FROM metadata WHERE id=?').get('instanceId').value;
    // Legacy "all history" becomes 30 days. Retain identity, pairing and all
    // cached records so changing a window never destroys user work.
    for (const connection of this.all('connections')) {
      const normalized = historyDays(connection.historyDays);
      if (connection.historyDays !== normalized) this.put('connections', { ...connection, historyDays: normalized });
    }
    const connections = new Map(this.all('connections').map(connection => [connection.id, connection]));
    for (const record of this.all('records')) {
      let changed = false;
      record.observations = (record.observations || []).map(observation => {
        const normalized = historyDays(connections.get(observation.connectionId)?.historyDays ?? observation.historyDays);
        if (observation.historyDays === normalized) return observation;
        changed = true; return { ...observation, historyDays: normalized };
      });
      if (changed) this.put('records', record);
    }
  }
  get(table, id) { return parse(this.db.prepare(`SELECT data FROM ${this.table(table)} WHERE id=?`).get(id)); }
  all(table) { return this.db.prepare(`SELECT data FROM ${this.table(table)}`).all().map(parse); }
  put(table, value, id = value.id) { this.db.prepare(`INSERT OR REPLACE INTO ${this.table(table)} (id,data) VALUES (?,?)`).run(id, JSON.stringify(value)); return value; }
  remove(table, id) { this.db.prepare(`DELETE FROM ${this.table(table)} WHERE id=?`).run(id); }
  table(table) { if (!['connections', 'cursors', 'records'].includes(table)) throw new Error('Unknown table'); return table; }
  tokenCount() { return this.db.prepare('SELECT COUNT(*) AS count FROM tokens').get().count; }
  addToken(hash, origin) { this.db.prepare('INSERT INTO tokens VALUES (?,?,?)').run(hash, origin, Date.now()); }
  authenticate(hash, origin) { return !!this.db.prepare('SELECT hash FROM tokens WHERE hash=? AND origin=?').get(hash, origin); }
  revokeToken(hash) { this.db.prepare('DELETE FROM tokens WHERE hash=?').run(hash); }
  close() { this.db.close(); }

  mergeRecord(incoming) {
    const current = this.get('records', incoming.id);
    if (!current) return this.put('records', incoming);
    const observations = new Map(current.observations.map(item => [item.connectionId, item]));
    for (const observation of incoming.observations) observations.set(observation.connectionId, observation);
    const latest = (incoming.updatedAt ?? -1) > (current.updatedAt ?? -1) ||
      (incoming.updatedAt === current.updatedAt && incoming.timeline.length >= current.timeline.length) ? incoming : current;
    const timeline = [...current.timeline, ...incoming.timeline];
    const deduped = [...new Map(timeline.map(item => [`${item.role || ''}:${item.at}:${item.text}`, item])).values()];
    deduped.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const merged = { ...current, ...latest, locator: incoming.locator, syncedAt: incoming.syncedAt, observations: [...observations.values()], timeline: deduped.slice(-60) };
    // A shorter or older replica must not erase a previously explicit creation date.
    if (merged.createdAt == null && current.createdAt != null) {
      merged.createdAt = current.createdAt; merged.createdAtBasis = current.createdAtBasis;
    }
    const times = [current.earliestActivityAt, incoming.earliestActivityAt].filter(v => v != null);
    merged.earliestActivityAt = times.length ? Math.min(...times) : null;
    const namingUpgrade = (incoming.namingVersion || 0) > (current.namingVersion || 0);
    merged.namingVersion = Math.max(current.namingVersion || 0, incoming.namingVersion || 0);
    // A repaired prefix is authoritative even when the source has no new
    // activity. Empty means the bounded replay could not establish a first
    // request; retaining an old wrapper would fabricate a naming basis.
    merged.firstMessage = namingUpgrade ? incoming.firstMessage || '' : meaningfulMessage('user', current.firstMessage) || incoming.firstMessage || '';
    const namingLatest = namingUpgrade && (incoming.updatedAt ?? -1) >= (current.updatedAt ?? -1) ? incoming : latest;
    merged.latestMessage = namingLatest.latestMessage || '';
    // Catalog-only renames must propagate even when activity/timeline have not
    // changed, but an older replica must not overwrite a newer known name.
    const olderName = incoming.sourceTitle && current.sourceTitle && incoming.sourceTitleUpdatedAt != null && current.sourceTitleUpdatedAt != null && incoming.sourceTitleUpdatedAt < current.sourceTitleUpdatedAt;
    if ((incoming.sourceNameChecked || incoming.sourceTitle) && !olderName) {
      merged.sourceTitle = incoming.sourceTitle || '';
      merged.sourceTitleUpdatedAt = incoming.sourceTitleUpdatedAt ?? null;
      merged.sourceNameChecked = incoming.sourceNameChecked === true;
      merged.titleBasis = incoming.titleBasis || (merged.firstMessage ? 'first-message' : 'unknown');
      merged.title = merged.sourceTitle || merged.firstMessage.slice(0, 120) || incoming.title;
    } else if (current.sourceTitle) {
      merged.sourceTitle = current.sourceTitle; merged.sourceTitleUpdatedAt = current.sourceTitleUpdatedAt ?? null;
      merged.sourceNameChecked = current.sourceNameChecked === true; merged.titleBasis = current.titleBasis; merged.title = current.sourceTitle;
    } else if (merged.firstMessage) { merged.title = merged.firstMessage.slice(0, 120); merged.titleBasis = 'first-message'; }
    else if (namingUpgrade) { merged.title = incoming.title || '未命名会话'; merged.titleBasis = incoming.titleBasis || 'unknown'; }
    merged.source = observedSource(merged.observations, incoming.connectorId, merged.source);
    return this.put('records', merged);
  }

  updatePermissions(connectionId, connection = null) {
    for (const record of this.all('records')) {
      if (!record.observations.some(item => item.connectionId === connectionId)) continue;
      record.observations = record.observations.map(item => item.connectionId !== connectionId ? item : {
        ...item, allowAI: connection?.allowAI === true, includeSummary: connection?.allowAI === true && connection?.includeSummary === true, includeNaming: connection?.allowAI === true && connection?.includeNaming === true,
        historyDays: historyDays(connection?.historyDays ?? item.historyDays),
        disconnected: !connection,
      });
      this.put('records', record);
    }
  }

  mergeObservations(observedRecords) {
    for (const { id, observation } of observedRecords) {
      const record = this.get('records', id);
      if (!record) continue;
      const observations = new Map((record.observations || []).map(item => [item.connectionId, item]));
      if (JSON.stringify(observations.get(observation.connectionId)) === JSON.stringify(observation)) continue;
      observations.set(observation.connectionId, observation);
      const merged = [...observations.values()];
      this.put('records', { ...record, observations: merged, source: observedSource(merged, record.connectorId, record.source) });
    }
  }
}
