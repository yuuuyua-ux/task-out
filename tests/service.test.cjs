const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = Date.now();
const stamp = n => new Date(NOW + n).toISOString();
const lines = values => values.map(value => JSON.stringify(value)).join('\n') + '\n';
const meta = (id = ID, timestamp = stamp(-3000)) => ({ type: 'session_meta', timestamp, payload: { id, timestamp, originator: 'codex_cli_rs' } });
const user = (message, timestamp = stamp(-2000)) => ({ type: 'event_msg', timestamp, payload: { type: 'user_message', message } });
const assistant = (message, timestamp = stamp(-1000)) => ({ type: 'event_msg', timestamp, payload: { type: 'agent_message', message } });
async function temp(t) { const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'task-out-test-'))); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
async function folder(dir, suffix = 'sessions') { const root = path.join(dir, suffix); await fs.mkdir(root, { recursive: true }); return root; }
function connection(root, connectorId = 'codex-rollout', extra = {}) { return { id: 'test-connection', connectorId, root, storageId: root, historyDays: 30, allowAI: false, includeSummary: false, ...extra }; }
async function parser() { return import('../service/connectors/registry.mjs'); }

test('Codex uses filename-matched metadata; inherited and session_id metadata cannot alter identity or creation', async t => {
  const root = await folder(await temp(t)); const { scan } = await parser();
  await fs.writeFile(path.join(root, `rollout-${ID}.jsonl`), lines([meta(), user('真正的任务'), meta(OTHER, stamp(-100000)), { type: 'session_meta', payload: { session_id: OTHER, timestamp: stamp(0) } }, assistant('已完成检查')]));
  const result = await scan(connection(root));
  assert.equal(result.records.length, 1);
  const record = result.records[0];
  assert.equal(record.originId, ID); assert.equal(record.createdAt, Date.parse(stamp(-3000))); assert.equal(record.title, '真正的任务');
  assert.equal(record.status, 'unknown'); assert.equal(record.capabilities.open, false); assert.equal(record.summary, '已完成检查');
  assert.equal(record.createdAtBasis, 'session_meta.timestamp');
  await fs.writeFile(path.join(root, `rollout-${OTHER}.jsonl`), lines([meta(ID), user('继承记录')]));
  const next = await scan(connection(root)); assert.equal(next.records.length, 1); assert.ok(next.warnings.some(value => value.includes('metadata')));
});

test('Claude SDK remains generic, explicit client identity works, and subagents associate to parent', async t => {
  const root = await folder(await temp(t), 'projects'); const { scan } = await parser();
  const entry = { type: 'user', sessionId: ID, entrypoint: 'sdk-ts', timestamp: stamp(-2000), message: { role: 'user', content: '研究任务' } };
  await fs.writeFile(path.join(root, `${ID}.jsonl`), lines([entry, { ...entry, type: 'assistant', timestamp: stamp(-1000), message: { role: 'assistant', content: [{ type: 'text', text: '研究结果' }] } }]));
  const sub = await folder(root, `${ID}/subagents`);
  await fs.writeFile(path.join(sub, 'agent-a12b.jsonl'), lines([entry]));
  await fs.writeFile(path.join(root, 'agent-oldformat.jsonl'), lines([{ ...entry, isSidechain: true }]));
  const records = (await scan(connection(root, 'claude-jsonl'))).records;
  assert.equal(records.length, 3);
  const main = records.find(value => !value.parentId), child = records.find(value => value.parentId);
  assert.equal(main.source.id, 'claude-sdk'); assert.ok(!main.source.label.includes('Mana'));
  assert.equal(child.parentId, main.id); assert.notEqual(child.id, main.id);
  assert.equal(records.filter(value => value.parentId === main.id).length, 2);
  assert.equal(main.createdAt, null); assert.equal(main.createdAtBasis, 'unknown'); assert.equal(main.earliestActivityAt, Date.parse(stamp(-2000)));
  const custom = (await scan(connection(root, 'claude-jsonl', { identity: { id: 'my-client', label: '我的客户端', icon: 'message' } }))).records;
  assert.equal(custom[0].source.id, 'my-client'); assert.ok(custom[0].source.evidence.startsWith('user-confirmed'));
});

test('incremental JSONL preserves split UTF-8 and incomplete tails, skips malformed lines, and resets truncation/replacement', async t => {
  const root = await folder(await temp(t)); const file = path.join(root, 'raw.jsonl');
  const { readJSONL } = await import('../service/connectors/jsonl.mjs');
  const bytes = Buffer.from('{"text":"中🙂文"}\n');
  const split = bytes.indexOf(Buffer.from('🙂')) + 2;
  await fs.writeFile(file, bytes.subarray(0, split));
  const make = () => ({ values: [] }); const reduce = (state, line) => state.values.push(line.text);
  const a = await readJSONL(file, root, null, make, reduce); assert.deepEqual(a.cursor.state.values, []);
  await fs.appendFile(file, Buffer.concat([bytes.subarray(split), Buffer.from('bad line\n{"text":"next"}\n{"text":"tail') ]));
  const b = await readJSONL(file, root, a.cursor, make, reduce);
  assert.deepEqual(b.cursor.state.values, ['中🙂文', 'next']); assert.equal(b.cursor.badLines, 1);
  await fs.appendFile(file, '"}\n');
  const c = await readJSONL(file, root, b.cursor, make, reduce); assert.deepEqual(c.cursor.state.values, ['中🙂文', 'next', 'tail']);
  await fs.writeFile(file, '{"text":"reset"}\n');
  const d = await readJSONL(file, root, c.cursor, make, reduce); assert.deepEqual(d.cursor.state.values, ['reset']); assert.equal(d.cursor.badLines, 0);
  await fs.rename(file, `${file}.old`); await fs.writeFile(file, '{"text":"replacement"}\n');
  const e = await readJSONL(file, root, d.cursor, make, reduce); assert.deepEqual(e.cursor.state.values, ['replacement']);
  await fs.writeFile(file, '{"text":"longer replacement in the same inode"}\n');
  const f = await readJSONL(file, root, e.cursor, make, reduce); assert.deepEqual(f.cursor.state.values, ['longer replacement in the same inode']);
});

test('oversized JSONL lines wholly inside one read are skipped without losing surrounding valid messages', async t => {
  const root = await folder(await temp(t)), file = path.join(root, 'oversized.jsonl');
  const { readJSONL } = await import('../service/connectors/jsonl.mjs');
  await fs.writeFile(file, lines([{ text: 'before' }, { text: 'x'.repeat(200) }, { text: 'after' }]));
  const result = await readJSONL(file, root, null, () => ({ values: [] }), (state, entry) => state.values.push(entry.text), { maxLineBytes: 64 });
  assert.deepEqual(result.cursor.state.values, ['before', 'after']);
  assert.equal(result.cursor.oversizedLines, 1); assert.equal(result.cursor.badLines, 0);
  assert.equal(result.cursor.line, 3); assert.equal(result.cursor.droppingOversizedLine, false); assert.equal(result.cursor.tail, '');
  assert.ok(result.warnings.some(warning => warning.includes('64 字节') && warning.includes('继续')));
});

test('oversized JSONL lines continue across maxBytes budgets while persisting no dropped body', async t => {
  const root = await folder(await temp(t)), file = path.join(root, 'oversized-budgets.jsonl');
  const { readJSONL } = await import('../service/connectors/jsonl.mjs');
  const bytes = Buffer.from(lines([{ text: 'before' }, { text: 'OVERSIZED_BODY'.repeat(40) }, { text: 'after' }]));
  await fs.writeFile(file, bytes);
  let cursor = null, droppingReads = 0, reads = 0;
  while (!cursor || cursor.offset < bytes.length) {
    const result = await readJSONL(file, root, cursor, () => ({ values: [] }), (state, entry) => state.values.push(entry.text), { maxLineBytes: 64, maxBytes: 50 });
    assert.ok(result.cursor.offset > (cursor?.offset || 0));
    if (result.cursor.droppingOversizedLine) {
      droppingReads++;
      assert.equal(result.cursor.tail, '');
      assert.equal(JSON.stringify(result.cursor).includes('OVERSIZED_BODY'), false);
      assert.ok(result.warnings.some(warning => warning.includes('下次同步继续')));
    }
    cursor = result.cursor;
    assert.ok(++reads < 30);
  }
  assert.ok(droppingReads > 1);
  assert.deepEqual(cursor.state.values, ['before', 'after']);
  assert.equal(cursor.oversizedLines, 1); assert.equal(cursor.badLines, 0); assert.equal(cursor.line, 3);
  assert.equal(cursor.droppingOversizedLine, false); assert.equal(cursor.tail, '');
});

test('an oversized unfinished line resumes at its later newline and truncation resets dropping state', async t => {
  const root = await folder(await temp(t)), file = path.join(root, 'oversized-append.jsonl');
  const { readJSONL } = await import('../service/connectors/jsonl.mjs');
  const make = () => ({ values: [] }), reduce = (state, entry) => state.values.push(entry.text), options = { maxLineBytes: 64 };
  await fs.writeFile(file, '{"text":"' + 'x'.repeat(300));
  const first = await readJSONL(file, root, null, make, reduce, options);
  assert.equal(first.cursor.droppingOversizedLine, true); assert.equal(first.cursor.tail, '');
  const unchanged = await readJSONL(file, root, first.cursor, make, reduce, options);
  assert.equal(unchanged.cursor.droppingOversizedLine, true); assert.equal(unchanged.cursor.oversizedLines, 1);
  await fs.appendFile(file, 'continued"}\n{"text":"after append"}\n');
  const appended = await readJSONL(file, root, unchanged.cursor, make, reduce, options);
  assert.deepEqual(appended.cursor.state.values, ['after append']); assert.equal(appended.cursor.oversizedLines, 1);
  assert.equal(appended.cursor.droppingOversizedLine, false);
  await fs.writeFile(file, '{"text":"' + 'y'.repeat(300));
  const dropping = await readJSONL(file, root, appended.cursor, make, reduce, options);
  assert.equal(dropping.cursor.droppingOversizedLine, true);
  await fs.writeFile(file, '{"text":"reset"}\n');
  const reset = await readJSONL(file, root, dropping.cursor, make, reduce, options);
  assert.deepEqual(reset.cursor.state.values, ['reset']); assert.equal(reset.cursor.oversizedLines, 0);
  assert.equal(reset.cursor.droppingOversizedLine, false); assert.equal(reset.cursor.badLines, 0);
});

test('scope skips escaped symlinks and unknown timestamps cannot enter a recent history window', async t => {
  const dir = await temp(t); const root = await folder(dir, 'projects'); const external = await folder(dir, 'outside'); const { scan } = await parser();
  await fs.writeFile(path.join(external, `${OTHER}.jsonl`), lines([{ type: 'user', sessionId: OTHER, message: { content: 'outside secret' } }]));
  await fs.symlink(external, path.join(root, 'linked-folder'));
  await fs.symlink(path.join(external, `${OTHER}.jsonl`), path.join(root, `${OTHER}.jsonl`));
  await fs.writeFile(path.join(root, `${ID}.jsonl`), lines([{ type: 'user', sessionId: ID, message: { content: '时间未知' } }]));
  const result = await scan(connection(root, 'claude-jsonl'));
  assert.equal(result.records.length, 0);
  assert.ok(result.warnings.some(value => value.includes('缺少可靠活动时间')));
  assert.ok(result.warnings.some(value => value.includes('符号链接')));
});

test('history selection uses actual activity, and storage identity is stable across active/archive and nested roots', async t => {
  const root = await folder(await temp(t)); const { scan, storageRoot } = await parser();
  const old = new Date(NOW - 60 * 86400000).toISOString();
  await fs.writeFile(path.join(root, `rollout-${ID}.jsonl`), lines([meta(ID, old), user('旧任务', old)]));
  assert.equal((await scan(connection(root))).records.length, 0);
  assert.equal((await scan(connection(root, 'codex-rollout', { historyDays: 0 }))).records.length, 0, 'legacy all-history config is normalized to 30 days');
  const parent = path.dirname(root);
  assert.equal(storageRoot(path.join(root, '2026', '09'), 'codex-rollout'), parent);
  assert.equal(storageRoot(path.join(parent, 'archived_sessions'), 'codex-rollout'), parent);
  assert.equal(storageRoot('/example/.claude/projects/some-project', 'claude-jsonl'), '/example/.claude');
});

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`, OTHER_ORIGIN = `chrome-extension://${'b'.repeat(32)}`;
async function setupServer(t, options = {}) {
  const dir = await temp(t); const { startServer } = await import('../service/server.mjs');
  const running = await startServer({ port: 0, dataDir: path.join(dir, 'db'), pairingCode: '12345678', polling: false, ...options });
  t.after(() => running.close());
  const request = async (url, { method = 'GET', body, token, origin = ORIGIN, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${running.port}${url}`, { method, headers: { ...(origin ? { Origin: origin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, headers: response.headers, value: response.status === 204 ? null : await response.json() };
  };
  return { dir, running, request, pair: async () => (await request('/pair', { method: 'POST', body: { code: '12345678' } })).value.token };
}

test('HTTP requires loopback Host, extension origin, one-use pairing and an origin-bound bearer token', async t => {
  const { running, request, pair } = await setupServer(t);
  const health = await request('/health', { origin: null }); assert.equal(health.value.name, 'Task Out'); assert.equal(health.value.paired, false);
  assert.equal((await request('/health', { origin: 'https://example.com' })).status, 403);
  assert.equal((await request('/v1/connectors', { origin: null })).status, 403);
  assert.equal((await request('/v1/connectors')).status, 401);
  assert.equal((await request('/pair', { method: 'POST', body: { code: 'wrong' } })).status, 401);
  const token = await pair(); assert.equal(token.length, 64);
  assert.equal((await request('/pair', { method: 'POST', body: { code: '12345678' } })).status, 429);
  assert.equal((await request('/v1/connectors', { token, origin: OTHER_ORIGIN })).status, 401);
  assert.equal((await request('/v1/connectors', { token })).value.connectors.length, 2);
  assert.equal((await request('/v1/discover', { method: 'POST', token, body: { roots: ['not-absolute'] } })).status, 400);
  assert.equal((await request('/v1/sync', { method: 'POST', token, body: { text: 'x'.repeat(129 * 1024) } })).status, 413);
  const badHost = await new Promise(resolve => { const req = http.get({ host: '127.0.0.1', port: running.port, path: '/health', headers: { Host: `attacker.example:${running.port}` } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', () => resolve('error')); });
  assert.equal(badHost, 403);
  assert.equal((await request('/v1/pair', { method: 'DELETE', token })).value.revoked, true);
  assert.equal((await request('/v1/connectors', { token })).status, 401);
});

test('privileged MV3 requests may omit Origin, but real web/null origins and identity mismatches cannot use the fallback', async t => {
  const { request } = await setupServer(t);
  const headers = { 'X-Task-Out-Extension': 'a'.repeat(32) };
  const paired = await request('/pair', { method: 'POST', origin: null, headers, body: { code: '12345678' } });
  assert.equal(paired.status, 200);
  const token = paired.value.token;
  assert.equal((await request('/v1/connectors', { origin: null, headers, token })).status, 200);
  assert.equal((await request('/v1/connectors', { origin: ORIGIN, headers, token })).status, 200);
  assert.equal((await request('/v1/connectors', { origin: null, headers: { 'X-Task-Out-Extension': 'b'.repeat(32) }, token })).status, 401);
  assert.equal((await request('/v1/connectors', { origin: OTHER_ORIGIN, headers, token })).status, 403);
  assert.equal((await request('/v1/connectors', { origin: null, headers: { 'X-Task-Out-Extension': 'invalid-id' }, token })).status, 403);
  assert.equal((await request('/v1/connectors', { origin: null, headers: { 'X-Task-Out-Extension': 'a'.repeat(31) + 'q' }, token })).status, 403);
  for (const origin of ['https://example.com', 'http://localhost:4518', 'null']) {
    const denied = await request('/v1/connectors', { origin, headers, token });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    const preflight = await request('/v1/connectors', { method: 'OPTIONS', origin, headers: { 'Access-Control-Request-Headers': 'X-Task-Out-Extension,Authorization' } });
    assert.equal(preflight.status, 403);
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  }
  const legitimatePreflight = await request('/v1/connectors', { method: 'OPTIONS', origin: ORIGIN, headers: { 'Access-Control-Request-Headers': 'X-Task-Out-Extension,Authorization' } });
  assert.equal(legitimatePreflight.status, 204);
  assert.equal(legitimatePreflight.headers.get('access-control-allow-origin'), ORIGIN);
  assert.ok(legitimatePreflight.headers.get('access-control-allow-headers').includes('X-Task-Out-Extension'));
});

test('API naming consent is independent and explicitly configured metadata can rename without new activity',async t=>{
  const {dir,request,pair}=await setupServer(t),token=await pair();
  const root=await folder(dir,'sessions'),metadataRoot=await folder(dir,'metadata');
  await fs.writeFile(path.join(root,`rollout-${ID}.jsonl`),lines([meta(),user('First actual task'),assistant('Latest activity')]));
  const indexFile=path.join(metadataRoot,'session_index.jsonl');
  await fs.writeFile(indexFile,lines([{id:ID,thread_name:'Source supplied title',updated_at:stamp(-1000)}]));
  const created=(await request('/v1/connections',{method:'POST',token,body:{connectorId:'codex-rollout',root,metadataRoot,enabled:true,allowAI:true,includeSummary:true}})).value.connection;
  assert.equal(created.includeNaming,false);assert.equal(created.canonicalMetadataRoot,metadataRoot);
  const first=(await request('/v1/sync',{method:'POST',token,body:{}})).value.records[0];
  assert.equal(first.sourceTitle,'Source supplied title');assert.equal(first.titleBasis,'codex-index');
  assert.equal(first.observations[0].includeNaming,false);
  await fs.appendFile(indexFile,lines([{id:ID,thread_name:'New source title',updated_at:stamp(0)}]));
  await request(`/v1/connections/${created.id}`,{method:'PATCH',token,body:{includeNaming:true}});
  const renamed=(await request('/v1/sync',{method:'POST',token,body:{}})).value.records[0];
  assert.equal(renamed.sourceTitle,'New source title');assert.equal(renamed.updatedAt,first.updatedAt);
  assert.equal(renamed.firstMessage,first.firstMessage);assert.equal(renamed.observations[0].includeNaming,true);
  assert.equal((await request(`/v1/connections/${created.id}`,{method:'PATCH',token,body:{metadataRoot:'relative/path'}})).status,400);
  const outside=await folder(dir,'outside-metadata');
  await fs.writeFile(path.join(outside,'session_index.jsonl'),lines([{id:ID,thread_name:'Outside title',updated_at:stamp(1000)}]));
  await fs.rename(metadataRoot,metadataRoot+'-saved');await fs.symlink(outside,metadataRoot);
  const limited=(await request(`/v1/connections/${created.id}`,{method:'PATCH',token,body:{includeNaming:false}})).value.connection;
  assert.equal(limited.metadataRoot,metadataRoot);assert.equal(limited.canonicalMetadataRoot,metadataRoot);
  const disconnected=(await request('/v1/sync',{method:'POST',token,body:{}})).value;
  assert.equal(disconnected.records[0].sourceTitle,'New source title');
  assert.equal(disconnected.records[0].observations[0].includeNaming,false);assert.ok(disconnected.errors.length);
});

test('connection preview is read-only; duplicate/overlap dedup, strict permissions, pause/offline/removal retain records', async t => {
  const { dir, running, request, pair } = await setupServer(t); const token = await pair();
  const root = await folder(dir, 'agent-home/sessions'); const sub = await folder(root, '2026');
  const file = path.join(sub, `rollout-${ID}.jsonl`); await fs.writeFile(file, lines([meta(), user('连接任务'), assistant('首次结果')]));
  const input = { connectorId: 'codex-rollout', root, name: 'First', historyDays: 30, enabled: true, allowAI: true, includeSummary: true };
  const preview = await request('/v1/test', { method: 'POST', token, body: input }); assert.equal(preview.value.records.length, 1);
  assert.equal(running.store.all('records').length, 0); assert.equal(running.store.all('connections').length, 0);
  const first = (await request('/v1/connections', { method: 'POST', token, body: input })).value.connection;
  assert.equal((await request('/v1/connections', { method: 'POST', token, body: input })).status, 409);
  const second = (await request('/v1/connections', { method: 'POST', token, body: { ...input, root: sub, name: 'Second', allowAI: false } })).value.connection;
  assert.equal(first.storageId, second.storageId);
  const result = await request('/v1/sync', { method: 'POST', token, body: {} });
  assert.equal(result.value.records.length, 1); assert.equal(result.value.records[0].observations.length, 2);
  assert.ok(result.value.records[0].observations.some(observation => !observation.allowAI));
  const recordId = result.value.records[0].id;
  assert.equal((await request(`/v1/records/${encodeURIComponent(recordId)}`, { token })).value.record.title, '连接任务');
  assert.equal((await request('/v1/records/..%2F..%2Fsecrets', { token })).status, 404);
  await request(`/v1/connections/${first.id}`, { method: 'PATCH', token, body: { enabled: false } });
  await fs.rename(root, `${root}-offline`);
  const offline = await request('/v1/sync', { method: 'POST', token, body: {} });
  assert.equal(offline.value.records.length, 1); assert.equal(offline.value.connections.find(c => c.id === second.id).status, 'offline');
  assert.equal((await request(`/v1/connections/${second.id}`, { method: 'PATCH', token, body: { enabled: false, allowAI: false } })).value.connection.status, 'paused');
  assert.equal((await request(`/v1/connections/${second.id}`, { method: 'PATCH', token, body: { historyDays: -4 } })).status, 400);
  await request(`/v1/connections/${first.id}`, { method: 'DELETE', token });
  assert.equal(running.store.all('records').length, 1);
  assert.ok(running.store.all('records')[0].observations.find(item => item.connectionId === first.id).disconnected);
  const redirected = await folder(dir, 'redirected/2026');
  await fs.writeFile(path.join(redirected, `rollout-${OTHER}.jsonl`), lines([meta(OTHER), user('Outside configured scope')]));
  await fs.symlink(path.dirname(redirected), root);
  const resumed = (await request(`/v1/connections/${second.id}`, { method: 'PATCH', token, body: { enabled: true } })).value.connection;
  assert.equal(resumed.root, second.root); assert.equal(resumed.canonicalRoot, second.canonicalRoot);
  const redirectedSync = (await request('/v1/sync', { method: 'POST', token, body: {} })).value;
  assert.equal(redirectedSync.records.length, 1);
  assert.equal(redirectedSync.connections[0].status, 'offline');
});

test('moving a rollout to archive keeps id and merges recent history, permissions change without rescanning', async t => {
  const { dir, running, request, pair } = await setupServer(t); const token = await pair();
  const active = await folder(dir, 'codex/sessions'), archived = await folder(dir, 'codex/archived_sessions');
  const file = `rollout-${ID}.jsonl`; await fs.writeFile(path.join(active, file), lines([meta(), user('移动任务'), assistant('近况')]));
  const create = root => request('/v1/connections', { method: 'POST', token, body: { connectorId: 'codex-rollout', root, name: 'Test', enabled: true, allowAI: true, includeSummary: true } });
  const a = (await create(active)).value.connection, b = (await create(archived)).value.connection;
  assert.equal(a.storageId, b.storageId);
  const initial = (await request('/v1/sync', { method: 'POST', token, body: {} })).value.records[0];
  await fs.rename(path.join(active, file), path.join(archived, file));
  const next = (await request('/v1/sync', { method: 'POST', token, body: {} })).value.records;
  assert.equal(next.length, 1); assert.equal(next[0].id, initial.id); assert.ok(next[0].locator.includes('archived_sessions'));
  await request(`/v1/connections/${a.id}`, { method: 'PATCH', token, body: { allowAI: false } });
  assert.equal(running.store.get('records', initial.id).observations.find(item => item.connectionId === a.id).allowAI, false);
});

test('service restart persists paired origin and cached records; repeat launcher reuses live service', async t => {
  const { running, dir, request, pair } = await setupServer(t); const token = await pair();
  const instanceId = (await request('/health')).value.instanceId;
  const root = await folder(dir);
  await fs.writeFile(path.join(root, `rollout-${ID}.jsonl`), lines([meta(), user('跨重启保留的任务')]));
  await request('/v1/connections', { method: 'POST', token, body: { connectorId: 'codex-rollout', root, enabled: true } });
  const before = (await request('/v1/sync', { method: 'POST', token, body: {} })).value.records;
  assert.equal(before.length, 1);
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/start.mjs'], { cwd: path.join(__dirname, '..'), env: { ...process.env, TASK_OUT_PORT: String(running.port), TASK_OUT_DATA_DIR: path.join(dir, 'db') } });
    let text = ''; child.stdout.on('data', chunk => text += chunk); child.stderr.on('data', chunk => text += chunk);
    child.on('error', reject); child.on('close', code => resolve({ code, text }));
  });
  assert.equal(output.code, 0); assert.ok(output.text.includes('继续使用现有服务'));
  await running.close();
  const { startServer } = await import('../service/server.mjs');
  const restarted = await startServer({ port: 0, dataDir: path.join(dir, 'db'), pairingCode: '87654321', polling: false });
  t.after(() => restarted.close());
  assert.equal(restarted.store.instanceId, instanceId);
  assert.equal(restarted.store.all('records')[0].id, before[0].id);
  assert.equal(restarted.store.all('records')[0].title, '跨重启保留的任务');
  const response = await fetch(`http://127.0.0.1:${restarted.port}/v1/connections`, { headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
});

test('new sources default to 60 seconds; scheduled reads respect due/manual-only/paused settings while manual refresh forces enabled sources', async t => {
  const {dir,request,pair}=await setupServer(t), token=await pair();
  const root=await folder(dir,'cadence'), file=path.join(root,`rollout-${ID}.jsonl`);
  await fs.writeFile(file,lines([meta(),user('第一次活动'),assistant('原始近况')]));
  const created=await request('/v1/connections',{method:'POST',token,body:{connectorId:'codex-rollout',root,enabled:true}});
  assert.equal(created.status,201);assert.equal(created.value.connection.pollIntervalMs,60000);
  const id=created.value.connection.id, edit=body=>request('/v1/connections/'+id,{method:'PATCH',token,body});
  const sync=body=>request('/v1/sync',{method:'POST',token,body});
  let result=await sync({dueOnly:true});assert.equal(result.value.records[0].summary,'原始近况');
  const firstAt=result.value.connections[0].lastAttemptAt;
  await fs.appendFile(file,lines([assistant('新近况',stamp(-500))]));
  result=await sync({dueOnly:true});assert.equal(result.value.records[0].summary,'原始近况');assert.equal(result.value.connections[0].lastAttemptAt,firstAt);
  result=await sync({});assert.equal(result.value.records[0].summary,'新近况');
  await edit({pollIntervalMs:0});await fs.appendFile(file,lines([assistant('手动模式的新近况',stamp(-400))]));
  result=await sync({dueOnly:true});assert.equal(result.value.records[0].summary,'新近况');
  result=await sync({dueOnly:false});assert.equal(result.value.records[0].summary,'手动模式的新近况');
  await edit({enabled:false});await fs.appendFile(file,lines([assistant('暂停期间不读取',stamp(-300))]));
  result=await sync({});assert.notEqual(result.value.records[0]?.summary,'暂停期间不读取');
  await edit({enabled:true});result=await sync({});assert.equal(result.value.records[0].summary,'暂停期间不读取');
  assert.equal((await sync({dueOnly:'true'})).status,400);
  const catalog=await request('/v1/connectors',{token});
  assert.equal(catalog.value.connectors.find(c=>c.id==='codex-rollout').configFields.find(f=>f.key==='pollIntervalMs').default,60000);
});
