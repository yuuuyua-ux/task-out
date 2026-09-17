const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const DAY = 86400000;
const NOW = Date.parse('2026-09-17T12:00:00Z');
const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const jsonl = entries => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'task-out-history-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'sessions'); await fs.mkdir(root);
  return { dir, root };
}
function log(identity, at) {
  const timestamp = typeof at === 'number' ? new Date(at).toISOString() : at;
  return jsonl([
    { type: 'session_meta', timestamp, payload: { id: identity, timestamp, originator: 'codex_cli_rs' } },
    { type: 'event_msg', timestamp, payload: { type: 'user_message', message: `Fictional task ${identity.slice(-2)}` } },
  ]);
}
const connection = (root, extra = {}) => ({ id: 'history-source', connectorId: 'codex-rollout', root, canonicalRoot: root, storageId: 'fictional-store', historyDays: 30, allowAI: false, ...extra });

test('history windows include exact boundaries and exclude future, invalid and unknown activity', async () => {
  const { inHistory, historyDays, currentRecords } = await import('../service/history.mjs');
  for (const days of [3, 7, 30]) {
    assert.equal(inHistory(NOW - days * DAY, days, NOW), true);
    assert.equal(inHistory(NOW, days, NOW), true);
    assert.equal(inHistory(NOW - days * DAY - 1, days, NOW), false);
    for (const at of [NOW + 1, null, undefined, '2026-09-17', NaN, Infinity, 0]) assert.equal(inHistory(at, days, NOW), false);
  }
  assert.equal(historyDays(0), 30); assert.equal(historyDays(undefined), 30);
  const records = [{ id: 'recent', updatedAt: NOW - 5 * DAY, observations: [{ connectionId: 'narrow', allowAI: false }, { connectionId: 'wide', allowAI: true }] }];
  const connections = [{ id: 'narrow', historyDays: 3, enabled: true }, { id: 'wide', historyDays: 7, enabled: false, status: 'offline' }];
  const visible = currentRecords(records, connections, NOW);
  assert.equal(visible.length, 1); assert.equal(visible[0].observations.length, 2);
  assert.equal(currentRecords(records, connections.slice(0, 1), NOW).length, 0);
  assert.equal(currentRecords(records, connections, NOW + 3 * DAY).length, 0, 'cached records expire as the window rolls');
});

test('scan uses source activity for 3/7/30 days, not mtime, and rereads changed expired logs', async t => {
  const { root } = await fixture(t), { scan, connectorCatalog } = await import('../service/connectors/registry.mjs');
  const ages = [0, 3 * DAY, 3 * DAY + 1, 7 * DAY, 7 * DAY + 1, 30 * DAY, 30 * DAY + 1, -1, null];
  for (let n = 0; n < ages.length; n++) await fs.writeFile(path.join(root, `rollout-${id(n)}.jsonl`), log(id(n), ages[n] === null ? null : NOW - ages[n]));
  const cursors = new Map(); let saved = 0;
  const options = { now: NOW, loadCursor: key => cursors.get(key), saveCursor: (key, cursor) => { saved++; cursors.set(key, structuredClone(cursor)); } };
  for (const [days, count] of [[3, 2], [7, 4], [30, 6]]) {
    const result = await scan(connection(root, { historyDays: days }), options);
    assert.equal(result.records.length, count);
    assert.ok(result.records.every(record => record.observations[0].historyDays === days));
    assert.ok(result.warnings.some(warning => warning.includes('缺少可靠活动时间')));
    assert.ok(result.warnings.some(warning => warning.includes('活动时间在未来')));
  }
  const before = saved;
  await scan(connection(root), options);
  assert.equal(saved - before, 8, 'unchanged expired file is skipped without rewriting the cursor');
  const expired = path.join(root, `rollout-${id(6)}.jsonl`);
  await fs.appendFile(expired, jsonl([{ type: 'event_msg', timestamp: new Date(NOW).toISOString(), payload: { type: 'user_message', message: 'A newly resumed task' } }]));
  const resumed = await scan(connection(root, { historyDays: 3 }), options);
  assert.ok(resumed.records.some(record => record.originId === id(6)));
  // Replacing the same path with a different past task must also reset cursor.
  await fs.writeFile(expired, log(id(6), NOW - 2 * DAY));
  const replaced = await scan(connection(root, { historyDays: 3 }), options);
  assert.equal(replaced.records.find(record => record.originId === id(6)).updatedAt, NOW - 2 * DAY);
  for (const connector of connectorCatalog()) {
    const field = connector.configFields.find(field => field.key === 'historyDays');
    assert.deepEqual(field.options.map(option => option.value), [3, 7, 30]); assert.equal(field.default, 30);
  }
});

test('legacy history migration preserves pairing, cache, cursors and saved connection settings', async t => {
  const { dir, root } = await fixture(t), { Store } = await import('../service/store.mjs');
  const dataDir = path.join(dir, 'db'); let store = new Store(dataDir);
  store.put('connections', { ...connection(root), historyDays: 0, name: 'Existing connection', enabled: false });
  store.put('records', { id: 'cached-old', updatedAt: NOW - 90 * DAY, observations: [{ connectionId: 'history-source', allowAI: true, historyDays: 0 }] });
  store.put('cursors', { id: 'existing-cursor', offset: 42 });
  const tokenHash = createHash('sha256').update('synthetic-token').digest('hex'); store.addToken(tokenHash, ORIGIN);
  const instance = store.instanceId; store.close(); store = new Store(dataDir); t.after(() => store.close());
  assert.equal(store.get('connections', 'history-source').historyDays, 30);
  assert.equal(store.get('connections', 'history-source').enabled, false);
  assert.equal(store.get('records', 'cached-old').observations[0].historyDays, 30);
  assert.equal(store.get('records', 'cached-old').updatedAt, NOW - 90 * DAY);
  assert.equal(store.get('cursors', 'existing-cursor').offset, 42);
  assert.equal(store.authenticate(tokenHash, ORIGIN), true); assert.equal(store.instanceId, instance);
  store.updatePermissions('history-source', { historyDays: 7, allowAI: false });
  assert.equal(store.get('records', 'cached-old').observations[0].historyDays, 7);
  store.updatePermissions('history-source');
  assert.equal(store.get('records', 'cached-old').observations[0].historyDays, 7);
});

test('HTTP filters cached results, widening restores cache, and overlapping windows retain strict grants', async t => {
  const { dir, root } = await fixture(t), { startServer } = await import('../service/server.mjs');
  const nested = path.join(root, 'nested'); await fs.mkdir(nested);
  const at = Date.now() - 5 * DAY;
  await fs.writeFile(path.join(nested, `rollout-${id(1)}.jsonl`), log(id(1), at));
  const running = await startServer({ port: 0, dataDir: path.join(dir, 'db'), pairingCode: '12345678', polling: false });
  t.after(() => running.close());
  let token;
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${running.port}${url}`, { method, headers: { Origin: ORIGIN, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, value: await response.json() };
  };
  token = (await request('/pair', 'POST', { code: '12345678' })).value.token;
  // Narrow connection scans first; its hidden record still contributes denial.
  const narrow = (await request('/v1/connections', 'POST', { connectorId: 'codex-rollout', root, historyDays: 3, enabled: true, allowAI: false })).value.connection;
  const wide = (await request('/v1/connections', 'POST', { connectorId: 'codex-rollout', root: nested, historyDays: 7, enabled: true, allowAI: true })).value.connection;
  let result = (await request('/v1/sync', 'POST', {})).value;
  assert.equal(result.records.length, 1);
  const recordId = result.records[0].id;
  assert.equal(result.records[0].observations.length, 2);
  assert.equal(result.records[0].observations.find(item => item.connectionId === narrow.id).allowAI, false);
  for (const invalid of [0, -1, 4, 31, '7']) assert.equal((await request(`/v1/connections/${wide.id}`, 'PATCH', { historyDays: invalid })).status, 400);
  await request(`/v1/connections/${wide.id}`, 'PATCH', { historyDays: 3, enabled: false });
  assert.equal((await request('/v1/sync', 'POST', {})).value.records.length, 0);
  assert.equal(running.store.all('records').length, 1);
  assert.equal((await request(`/v1/records/${encodeURIComponent(recordId)}`)).status, 200);
  // Offline widening admits cached content without another read or changed id.
  await fs.rename(root, root + '-offline');
  await request(`/v1/connections/${wide.id}`, 'PATCH', { historyDays: 30 });
  result = (await request('/v1/sync', 'POST', {})).value;
  assert.equal(result.records[0].id, recordId); assert.equal(result.records[0].updatedAt, at);
  assert.equal(result.connections.find(item => item.id === narrow.id).status, 'offline');
  assert.equal(result.records[0].observations.find(item => item.connectionId === wide.id).historyDays, 30);
  await request(`/v1/connections/${wide.id}`, 'DELETE');
  assert.equal((await request('/v1/sync', 'POST', {})).value.records.length, 0);
  assert.equal((await request(`/v1/records/${encodeURIComponent(recordId)}`)).status, 200);
});
