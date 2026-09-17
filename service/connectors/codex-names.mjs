import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readJSONL, within } from './jsonl.mjs';

const short = value => typeof value === 'string' ? value.trim().slice(0, 500) : '';
const timestamp = (value, seconds = false) => {
  const number = typeof value === 'number' ? value * (seconds ? 1000 : 1) : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(number) && number > 0 && number <= 8640000000000000 ? number : null;
};

// Names are a separately authorized source. Never derive authority to read
// the sibling SQLite/index files from permission to read the rollout folder.
export async function readCodexNames(connection, requestedIds, firstMessages = new Map()) {
  const result = { names: new Map(), firstMessages: new Map(), checked: false, warnings: [] };
  if (!connection.metadataRoot || !requestedIds.length) return result;
  const allowedRoot = connection.canonicalMetadataRoot || connection.metadataRoot;
  let root;
  try {
    root = await fs.realpath(connection.metadataRoot);
    if (root !== path.resolve(allowedRoot)) throw new Error();
  } catch { result.warnings.push('名称元数据目录不可用或已被重定向，保留已有名称'); return result; }
  const safeFile = async filename => {
    const file = path.join(root, filename);
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || !within(root, await fs.realpath(file)) || await fs.realpath(root) !== root) throw new Error('名称元数据文件超出授权范围');
    return file;
  };
  const requested = new Set(requestedIds);
  const index = new Map(), database = new Map();
  try {
    const file = await safeFile('session_index.jsonl');
    const parsed = await readJSONL(file, root, null, () => ({}), (_state, entry) => {
      if (!requested.has(entry.id) || typeof entry.thread_name !== 'string' || !entry.thread_name.trim()) return;
      const candidate = { sourceTitle: short(entry.thread_name), titleBasis: 'codex-index', sourceTitleUpdatedAt: timestamp(entry.updated_at) };
      const previous = index.get(entry.id);
      if (!previous || (candidate.sourceTitleUpdatedAt ?? 0) >= (previous.sourceTitleUpdatedAt ?? 0)) index.set(entry.id, candidate);
    }, { maxBytes: 16 * 1024 * 1024, maxLineBytes: 64 * 1024, expectedRoot: root });
    result.checked = parsed.cursor.offset >= parsed.cursor.size && !parsed.cursor.badLines && !parsed.cursor.oversizedLines && !parsed.cursor.tail;
    result.warnings.push(...parsed.warnings.map(w => `名称索引：${w === '大文件尚未读完，下次同步继续' ? '超过 16 MB，只检查已读取部分；其余名称需兼容数据库提供，未读取部分保留原缓存' : w}`));
  } catch (error) {
    if (error.code !== 'ENOENT') result.warnings.push('名称索引不可读取，已继续其他元数据来源');
  }
  try {
    const files = (await fs.readdir(root)).filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    for (const filename of files) {
      let db;
      try {
        const file = await safeFile(filename);
        db = new DatabaseSync(file, { readOnly: true });
        if (await fs.realpath(root) !== root || !within(root, await fs.realpath(file))) throw new Error('名称元数据文件超出授权范围');
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
        const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => row.name));
        if (!columns.has('id') || (!columns.has('name') && !columns.has('title'))) continue;
        const select = [
          columns.has('name') ? 'substr(name,1,500) AS name' : 'NULL AS name',
          columns.has('title') ? 'substr(title,1,500) AS title' : 'NULL AS title',
          columns.has('first_user_message') ? 'substr(first_user_message,1,1200) AS first_message' : 'NULL AS first_message',
          columns.has('updated_at_ms') ? 'updated_at_ms' : 'NULL AS updated_at_ms',
          columns.has('updated_at') ? 'updated_at' : 'NULL AS updated_at',
        ].join(',');
        const query = db.prepare(`SELECT ${select} FROM threads WHERE id=?`);
        for (const id of requested) {
          const row = query.get(id);
          if (!row) continue;
          const first = typeof row.first_message === 'string' ? row.first_message.trim().slice(0, 1200) : '';
          if (first) result.firstMessages.set(id, first);
          const sourceTitleUpdatedAt = timestamp(row.updated_at_ms) || timestamp(row.updated_at, true);
          const name = short(row.name);
          if (name) database.set(id, { sourceTitle: name, titleBasis: 'codex-db-name', sourceTitleUpdatedAt });
          else if (!columns.has('name')) {
            // Old schemas sometimes stored the raw prompt as title. Only a
            // distinct single-line value is admitted as a source name.
            const oldTitle = short(row.title), knownFirst = first || firstMessages.get(id) || '';
            if (oldTitle && !/[\r\n]/.test(oldTitle) && knownFirst && oldTitle !== knownFirst && !knownFirst.startsWith(oldTitle))
              database.set(id, { sourceTitle: oldTitle, titleBasis: 'codex-db-title', sourceTitleUpdatedAt });
          }
        }
        result.checked = true;
        break; // The newest compatible database is the authoritative snapshot.
      } catch { result.warnings.push('会话名称数据库不可读取或格式不兼容，已继续其他元数据来源'); }
      finally { db?.close(); }
    }
  } catch { result.warnings.push('名称元数据目录暂时不可读取'); }
  for (const id of requested) {
    const fromDB = database.get(id), fromIndex = index.get(id);
    // An index event newer than the database snapshot must not be overwritten
    // by an older name. On equal/missing clocks prefer the live DB name.
    const chosen = fromDB && (!fromIndex || !(fromIndex.sourceTitleUpdatedAt > (fromDB.sourceTitleUpdatedAt ?? 0))) ? fromDB : fromIndex;
    if (chosen) result.names.set(id, chosen);
  }
  if (result.warnings.length) result.checked = false; // Partial catalogs cannot prove a previously known name disappeared.
  return result;
}
