const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ID = '55555555-5555-4555-8555-555555555555';
const NOW = Date.now();
const stamp = offset => new Date(NOW + offset).toISOString();
const meta = { type: 'session_meta', timestamp: stamp(-5000), payload: { id: ID, timestamp: stamp(-5000), originator: 'codex_cli_rs' } };
const user = (message, offset = -4000) => ({ type: 'event_msg', timestamp: stamp(offset), payload: { type: 'user_message', message } });
const assistant = (message, offset = -1000) => ({ type: 'event_msg', timestamp: stamp(offset), payload: { type: 'agent_message', message } });
const lines = entries => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
async function setup(t, entries, connectorId = 'codex-rollout') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'task-out-name-cleanup-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, `${connectorId === 'codex-rollout' ? 'rollout-' : ''}${ID}.jsonl`);
  await fs.writeFile(file, lines(entries));
  const connection = { id: 'cleanup-fixture', root, storageId: root, connectorId, historyDays: 30 };
  const cursors = new Map();
  const options = { now: NOW, loadCursor: key => cursors.get(key), saveCursor: (key, value) => cursors.set(key, structuredClone(value)) };
  const { scan } = await import('../service/connectors/registry.mjs');
  return { root, file, connection, cursors, read: () => scan(connection, options) };
}

test('session naming skips known leading envelopes and retains the real request after them', async t => {
  const fixture = await setup(t, [meta,
    user('<recommended_plugins>installed context</recommended_plugins>'),
    user('<app_instructions>tool context</app_instructions><environment_context>runtime</environment_context>\n比较任务看板方案', -3000),
    user('<codex_delegation>delegation context</codex_delegation>', -2000),
    assistant('比较完成，已整理差异'),
    user('<recommended_plugins>later context only</recommended_plugins>', -500),
  ]);
  const record = (await fixture.read()).records[0];
  assert.equal(record.firstMessage, '比较任务看板方案');
  assert.equal(record.latestMessage, '比较完成，已整理差异');
  assert.equal(record.title, '比较任务看板方案');
  assert.equal(record.namingVersion, 2);
});

test('naming cleanup preserves quoted tags and code instead of interpreting ordinary documentation as an envelope', async () => {
  const { meaningfulMessage } = await import('../service/connectors/message-text.mjs');
  for (const example of [
    '解释 <recommended_plugins> 示例的用途',
    '```xml\n<app_instructions>代码示例</app_instructions>\n```',
    '> <environment_context>引用说明</environment_context>',
  ]) assert.equal(meaningfulMessage('user', example), example.replace(/\s+/g, ' '));
  assert.equal(meaningfulMessage('assistant', '<recommended_plugins>正文示例</recommended_plugins>'), '<recommended_plugins>正文示例</recommended_plugins>');
  assert.equal(meaningfulMessage('user', '<recommended_plugins>truncated transport context'), '');
});

test('Claude recovery context does not become the name and custom names remain authoritative', async t => {
  const entry = (text, offset) => ({ type: 'user', sessionId: ID, timestamp: stamp(offset), message: { role: 'user', content: text } });
  const fixture = await setup(t, [
    entry('<recovered_conversation_context>旧历史</recovered_conversation_context>', -4000),
    entry('<recovered_conversation_context>补充历史</recovered_conversation_context>\n整理需求', -3000),
    { type: 'custom-title', sessionId: ID, customTitle: '需求整理', timestamp: stamp(-2000) },
    entry('补充验收标准', -1000),
  ], 'claude-jsonl');
  const record = (await fixture.read()).records[0];
  assert.equal(record.firstMessage, '整理需求'); assert.equal(record.latestMessage, '补充验收标准');
  assert.equal(record.sourceTitle, '需求整理'); assert.equal(record.title, '需求整理');
});

test('version 1 cursor and stored record are repaired without new activity or loss of a source name', async t => {
  const wrapper = '<recommended_plugins>context only</recommended_plugins>';
  const fixture = await setup(t, [meta, user(wrapper), user('真正的首条请求', -3000), assistant('最近的结果')]);
  const original = (await fixture.read()).records[0];
  const cursor = [...fixture.cursors.values()][0];
  Object.assign(cursor.state, { namingVersion: 1, firstMessage: wrapper, title: wrapper, latestMessage: wrapper });
  cursor.state.timeline.push({ role: 'user', text: wrapper, at: NOW - 500 });
  const repaired = (await fixture.read()).records[0];
  assert.equal(repaired.firstMessage, '真正的首条请求'); assert.equal(repaired.latestMessage, '最近的结果');
  assert.equal(repaired.updatedAt, original.updatedAt); assert.equal(repaired.namingVersion, 2);
  const { Store } = await import('../service/store.mjs');
  const store = new Store(path.join(fixture.root, 'cache')); t.after(() => store.close());
  store.mergeRecord({ ...original, namingVersion: 1, firstMessage: wrapper, latestMessage: wrapper, title: wrapper, timeline: [...original.timeline, { role: 'user', text: wrapper, at: NOW - 500 }] });
  const merged = store.mergeRecord(repaired);
  assert.equal(merged.firstMessage, '真正的首条请求'); assert.equal(merged.latestMessage, '最近的结果');
  assert.equal(merged.title, '真正的首条请求'); assert.equal(merged.namingVersion, 2);
  store.put('records', { ...merged, sourceTitle: '保留正式名称', title: '保留正式名称', titleBasis: 'codex-index' });
  assert.equal(store.mergeRecord(repaired).title, '保留正式名称');
});

test('a polluted database first message falls back to a bounded rollout prefix', async t => {
  const fixture = await setup(t, [meta, user('<recommended_plugins>context</recommended_plugins>'), user('真实请求', -3000), assistant('已检查')]);
  await fixture.read();
  const cursor = [...fixture.cursors.values()][0]; cursor.state.namingVersion = 1;
  const metadataRoot = path.join(fixture.root, 'metadata'); await fs.mkdir(metadataRoot);
  const db = new DatabaseSync(path.join(metadataRoot, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT, name TEXT, first_user_message TEXT)');
  db.prepare('INSERT INTO threads VALUES(?,?,?)').run(ID, '正式会话名', '<recommended_plugins>context only</recommended_plugins>');
  db.close(); Object.assign(fixture.connection, { metadataRoot, canonicalMetadataRoot: metadataRoot });
  const repaired = (await fixture.read()).records[0];
  assert.equal(repaired.firstMessage, '真实请求'); assert.equal(repaired.title, '正式会话名');
});

test('a bounded prefix that cannot reach the first message clears old wrappers and never promotes a later turn', async t => {
  const wrapper = '<recommended_plugins>context only</recommended_plugins>';
  const fixture = await setup(t, [meta,
    { type: 'response_item', timestamp: stamp(-4500), payload: { type: 'message', role: 'developer', content: 'x'.repeat(1100 * 1024) } },
    user('预算之外的首条请求', -3000), assistant('最近的结果'),
  ]);
  const original = (await fixture.read()).records[0];
  Object.assign([...fixture.cursors.values()][0].state, { namingVersion: 1, firstMessage: wrapper, title: wrapper });
  const repaired = (await fixture.read()).records[0];
  assert.equal(repaired.firstMessage, ''); assert.equal(repaired.title, '未命名会话');
  assert.equal([...fixture.cursors.values()][0].state.preventFirstMessageCapture, true);
  await fs.appendFile(fixture.file, lines([user('后来追加的请求', -500)]));
  assert.equal((await fixture.read()).records[0].firstMessage, '');
  const { Store } = await import('../service/store.mjs');
  const store = new Store(path.join(fixture.root, 'cache')); t.after(() => store.close());
  store.mergeRecord({ ...original, namingVersion: 1, firstMessage: wrapper, title: wrapper });
  const merged = store.mergeRecord(repaired);
  assert.equal(merged.firstMessage, ''); assert.equal(merged.title, '未命名会话');
});
