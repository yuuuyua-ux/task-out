const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const NOW = Date.now(), DAY = 86400000;
const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const jsonl = entries => entries.map(value => JSON.stringify(value)).join('\n') + '\n';
const codex = (n, at = NOW - 1000, parent) => jsonl([
  {type: 'session_meta', timestamp: new Date(at - 1000).toISOString(), payload: {id: id(n), originator: 'codex_cli_rs', ...(parent ? {parent_thread_id: id(parent)} : {})}},
  {type: 'event_msg', timestamp: new Date(at).toISOString(), payload: {type: 'user_message', message: `Fictional task ${n}`}}
]);
async function temp(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'task-out-onboarding-')));
  t.after(() => fs.rm(dir, {recursive: true, force: true})); return dir;
}
async function folder(root, name) {const dir = path.join(root, name); await fs.mkdir(dir, {recursive: true}); return dir;}
async function service(t, extra = {}) {
  const dir = await temp(t), {startServer} = await import('../service/server.mjs');
  const running = await startServer({port: 0, dataDir: path.join(dir, 'state'), polling: false, pairingCode: '12345678', ...extra});
  t.after(() => running.close());
  async function request(route, {token, body, origin = ORIGIN, method = body === undefined ? 'GET' : 'POST'} = {}) {
    const response = await fetch(`http://127.0.0.1:${running.port}${route}`, {method, headers: {
      Origin: origin, ...(token ? {Authorization: `Bearer ${token}`} : {}), ...(body !== undefined ? {'Content-Type': 'application/json'} : {})
    }, ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
    return {status: response.status, value: await response.json()};
  }
  const pair = async () => (await request('/pair', {body: {code: '12345678'}})).value.token;
  return {dir, running, request, pair};
}

test('discovery checks real name-file positions without reading bodies and deduplicates canonical shared roots', async t => {
  const dir = await temp(t), home = await folder(dir, 'agent-home'), root = await folder(home, 'sessions');
  await fs.writeFile(path.join(home, 'session_index.jsonl'), 'not parsed during discovery');
  const linked = path.join(dir, 'same-folder'); await fs.symlink(root, linked);
  t.mock.method(fs, 'open', async () => {throw Error('Discovery must not open session or metadata contents');});
  t.mock.method(fs, 'readFile', async () => {throw Error('Discovery must not read contents');});
  const {discover} = await import('../service/connectors/registry.mjs');
  const candidates = await discover({connectorId: 'codex-rollout', roots: [root, linked, root]});
  assert.equal(candidates.length, 1); assert.equal(candidates[0].root, root);
  assert.equal(candidates[0].displayName, 'Codex 会话'); assert.ok(Array.isArray(candidates[0].evidence));
  assert.ok(candidates[0].metadataRootSuggestions.includes(home)); assert.equal(candidates[0].metadataRoot, undefined);
  assert.ok(candidates[0].recognition.includes('尚未读取'));
  await fs.rm(path.join(home, 'session_index.jsonl'));
  await fs.symlink(path.join(dir, 'unrelated-private-file'), path.join(home, 'state_5.sqlite'));
  const absent = await discover({connectorId: 'codex-rollout', roots: [root]});
  assert.ok(!absent[0].metadataRootSuggestions.includes(home), 'symlink/nonexistent files are not name-file evidence');
  const shared = await folder(dir, 'projects');
  const sdk = await discover({connectorId: 'claude-jsonl', roots: [shared, shared]});
  assert.equal(sdk.length, 1); assert.equal(sdk[0].displayName, 'Claude 兼容会话'); assert.ok(!JSON.stringify(sdk).includes('Mana'));
});

test('discovery distinguishes missing and unreadable directories with actions instead of silently dropping them', async t => {
  const dir = await temp(t), denied = await folder(dir, 'denied');
  const original = fs.access;
  t.mock.method(fs, 'access', async (file, mode) => {if (file === denied) throw Object.assign(Error('private'), {code: 'EACCES'}); return original(file, mode);});
  const {discover} = await import('../service/connectors/registry.mjs');
  const result = await discover({connectorId: 'claude-jsonl', roots: [path.join(dir, 'missing'), denied]});
  assert.equal(result.length, 0);
  assert.deepEqual(result.diagnostics.map(value => value.code), ['DIRECTORY_NOT_FOUND', 'READ_PERMISSION']);
  assert.ok(result.diagnostics.every(value => value.message && value.action));
});

test('preview counts all unique main and child sessions in the activity window while returning ten main-first samples without writes', async t => {
  const app = await service(t), root = await folder(app.dir, 'sessions'), token = await app.pair();
  for (let n = 1; n <= 12; n++) await fs.writeFile(path.join(root, `rollout-${id(n)}.jsonl`), codex(n));
  for (let n = 13; n <= 15; n++) await fs.writeFile(path.join(root, `rollout-${id(n)}.jsonl`), codex(n, NOW - 500, 1));
  await fs.writeFile(path.join(root, `duplicate-${id(1)}.jsonl`), codex(1));
  await fs.writeFile(path.join(root, `old-${id(16)}.jsonl`), codex(16, NOW - 5 * DAY));
  await fs.writeFile(path.join(root, `future-${id(17)}.jsonl`), codex(17, NOW + DAY));
  const reply = await app.request('/v1/test', {token, body: {connectorId: 'codex-rollout', root, historyDays: 3}});
  assert.equal(reply.status, 200); assert.equal(reply.value.records.length, 10);
  assert.ok(reply.value.records.every(record => !record.parentId));
  assert.equal(reply.value.summary.mainCount, 12); assert.equal(reply.value.summary.childCount, 3); assert.equal(reply.value.summary.totalCount, 15);
  assert.equal(reply.value.summary.sampleLimited, true); assert.equal(reply.value.summary.truncated, false);
  assert.equal(reply.value.summary.identity.label, 'Codex'); assert.equal(reply.value.canEnable, true);
  assert.equal(app.running.store.all('records').length, 0); assert.equal(app.running.store.all('connections').length, 0); assert.equal(app.running.store.all('cursors').length, 0);
});

test('recent-empty and empty directories can be enabled; unsupported formats cannot bypass preview on save', async t => {
  const app = await service(t), token = await app.pair(), root = await folder(app.dir, 'sessions');
  await fs.writeFile(path.join(root, `rollout-${id(1)}.jsonl`), codex(1, NOW - 5 * DAY));
  const config = {connectorId: 'codex-rollout', root, historyDays: 3};
  const emptyWindow = await app.request('/v1/test', {token, body: config});
  assert.equal(emptyWindow.status, 200); assert.equal(emptyWindow.value.summary.totalCount, 0);
  assert.equal(emptyWindow.value.canEnable, true); assert.equal(emptyWindow.value.diagnostics[0].code, 'NO_RECENT_SESSIONS');
  assert.equal((await app.request('/v1/test', {token, body: {...config, historyDays: 7}})).value.summary.totalCount, 1);
  assert.equal((await app.request('/v1/connections', {token, body: {...config, enabled: true}})).status, 201);
  const empty = await folder(app.dir, 'empty');
  assert.equal((await app.request('/v1/test', {token, body: {...config, root: empty}})).value.canEnable, true);
  const unsupported = await folder(app.dir, 'unsupported');
  await fs.writeFile(path.join(unsupported, `${id(9)}.jsonl`), jsonl([{kind: 'some-other-format', text: 'fictional'}]));
  for (const route of ['/v1/test', '/v1/connections']) {
    const result = await app.request(route, {token, body: {...config, root: unsupported, enabled: true}});
    assert.equal(result.status, 400); assert.equal(result.value.code, 'UNSUPPORTED_FORMAT');
  }
  const textOnly = await folder(app.dir, 'plain-files'); await fs.writeFile(path.join(textOnly, 'notes.txt'), 'not a session directory');
  assert.equal((await app.request('/v1/test', {token, body: {...config, root: textOnly}})).value.code, 'UNSUPPORTED_FORMAT');
  const claude = await folder(app.dir, 'projects');
  await fs.writeFile(path.join(claude, `${id(1)}.jsonl`), jsonl([{type: 'session-start', sessionId: id(1), timestamp: new Date(NOW - 1000).toISOString()}]));
  const started = await app.request('/v1/test', {token, body: {...config, connectorId: 'claude-jsonl', root: claude}});
  assert.equal(started.status, 200); assert.equal(started.value.canEnable, true); assert.equal(started.value.summary.totalCount, 0);
  const saved = (await app.request('/v1/connections', {token, body: {...config, root: empty, enabled: false}})).value.connection;
  assert.equal((await app.request(`/v1/connections/${saved.id}`, {token, method: 'PATCH', body: {root: unsupported, enabled: true}})).value.code, 'UNSUPPORTED_FORMAT');
  assert.equal(app.running.store.get('connections', saved.id).root, empty);
  const linked = path.join(app.dir, 'same-existing-source'); await fs.symlink(root, linked);
  const duplicate = await app.request(`/v1/connections/${saved.id}`, {token, method: 'PATCH', body: {root: linked}});
  assert.equal(duplicate.status, 409); assert.equal(duplicate.value.code, 'CONNECTION_EXISTS');
  assert.equal(app.running.store.get('connections', saved.id).root, empty);
});

test('directory failures have distinct codes and unreadable files do not masquerade as empty recent history', async t => {
  const app = await service(t), token = await app.pair(), root = await folder(app.dir, 'sessions');
  const config = {connectorId: 'codex-rollout', root};
  assert.equal((await app.request('/v1/test', {token, body: {...config, root: path.join(app.dir, 'missing')}})).value.code, 'DIRECTORY_NOT_FOUND');
  const file = path.join(root, `rollout-${id(1)}.jsonl`); await fs.writeFile(file, codex(1));
  const original = fs.open;
  t.mock.method(fs, 'open', async (...args) => {if (args[0] === file) throw Object.assign(Error('private file'), {code: 'EACCES'}); return original(...args);});
  const denied = await app.request('/v1/test', {token, body: config});
  assert.equal(denied.status, 403); assert.equal(denied.value.code, 'READ_PERMISSION');
  assert.ok(!JSON.stringify(denied.value).includes('private file'));
});

test('pairing reports invalid, used and expired launch codes and invalid stored credentials without echoing secrets', async t => {
  const app = await service(t);
  const wrong = await app.request('/pair', {body: {code: '87654321'}});
  assert.equal(wrong.value.code, 'PAIR_CODE_INVALID'); assert.ok(!JSON.stringify(wrong.value).includes('87654321'));
  const token = await app.pair(); assert.ok(token);
  const used = await app.request('/pair', {body: {code: '12345678'}});
  assert.equal(used.value.code, 'PAIR_CODE_USED'); assert.ok(!JSON.stringify(used.value).includes('12345678'));
  assert.equal((await app.request('/v1/connections', {token: 'b'.repeat(64)})).value.code, 'CONNECTION_EXPIRED');
  const expired = await service(t, {pairingTtlMs: -1});
  assert.equal((await expired.request('/pair', {body: {code: '12345678'}})).value.code, 'PAIR_CODE_EXPIRED');
});

test('native directory picker requires pairing, preserves cancellation and rejects injected arguments', async t => {
  let calls = 0;
  const app = await service(t, {directoryPicker: async () => (++calls === 1 ? {path: '/example/sessions', cancelled: false} : {path: '', cancelled: true})});
  assert.equal((await app.request('/v1/directories/select', {body: {}})).value.code, 'CONNECTION_EXPIRED'); assert.equal(calls, 0);
  const token = await app.pair();
  assert.equal((await app.request('/v1/directories/select', {token, body: {}, origin: 'https://example.com'})).status, 403); assert.equal(calls, 0);
  assert.equal((await app.request('/v1/directories/select', {token, body: {script: 'arbitrary'}})).status, 400); assert.equal(calls, 0);
  assert.deepEqual((await app.request('/v1/directories/select', {token, body: {}})).value, {path: '/example/sessions', cancelled: false});
  assert.deepEqual((await app.request('/v1/directories/select', {token, body: {}})).value, {path: '', cancelled: true});
});
