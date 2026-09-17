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
  assert.equal(record.namingVersion, 3);
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
  assert.equal(repaired.updatedAt, original.updatedAt); assert.equal(repaired.namingVersion, 3);
  const { Store } = await import('../service/store.mjs');
  const store = new Store(path.join(fixture.root, 'cache')); t.after(() => store.close());
  store.mergeRecord({ ...original, namingVersion: 1, firstMessage: wrapper, latestMessage: wrapper, title: wrapper, timeline: [...original.timeline, { role: 'user', text: wrapper, at: NOW - 500 }] });
  const merged = store.mergeRecord(repaired);
  assert.equal(merged.firstMessage, '真正的首条请求'); assert.equal(merged.latestMessage, '最近的结果');
  assert.equal(merged.title, '真正的首条请求'); assert.equal(merged.namingVersion, 3);
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
  const appended = (await fixture.read()).records[0];
  assert.equal(appended.firstMessage, ''); assert.equal(appended.title, '未命名会话');
  const { Store } = await import('../service/store.mjs');
  const store = new Store(path.join(fixture.root, 'cache')); t.after(() => store.close());
  store.mergeRecord({ ...original, namingVersion: 1, firstMessage: wrapper, title: wrapper });
  const merged = store.mergeRecord(repaired);
  assert.equal(merged.firstMessage, ''); assert.equal(merged.title, '未命名会话');
});

test('request envelopes unwrap while nested context, empty and incomplete envelopes stay out of naming', async () => {
  const { meaningfulMessage } = await import('../service/connectors/message-text.mjs');
  const examples = [
    ['<current_user_request>比较虚构方案</current_user_request>', '比较虚构方案'],
    ['<command-name>/fixture</command-name><command-message>上下文</command-message><command-args>比较虚构方案</command-args>', '比较虚构方案'],
    ['<interrupted_turn_context>旧内容<interrupted_turn_context>内层</interrupted_turn_context>旧补充</interrupted_turn_context><current_user_request>新请求</current_user_request>', '新请求'],
    ['<current_user_request><interrupted_turn_context>忽略</interrupted_turn_context><command-args>真实请求</command-args></current_user_request>', '真实请求'],
    ['<current_user_request><current_user_request>嵌套请求</current_user_request></current_user_request>', '嵌套请求'],
    ['<current_user_request mode="fixture">请求一</current_user_request><interrupted_turn_context>上下文</interrupted_turn_context><command-args>请求二</command-args>', '请求一 请求二'],
    ['<interrupted_turn_context/><current_user_request></current_user_request><command-args/>', ''],
    ['<interrupted_turn_context>未闭合的上下文', ''],
    ['<current_user_request>未闭合的请求', ''],
    ['<current_user_request><command-args>内层缺少结尾</current_user_request>', ''],
    ['<current_user_request><current_user_request>只有内层闭合</current_user_request>', ''],
  ];
  for (const [input, expected] of examples) assert.equal(meaningfulMessage('user', input), expected);
});

test('request-like tags in prose, quoted examples, fenced code and assistant messages remain content', async () => {
  const { meaningfulMessage } = await import('../service/connectors/message-text.mjs');
  for (const input of [
    '请解释 <current_user_request>示例</current_user_request> 与 <command-args>参数</command-args>',
    '> <current_user_request>引用请求</current_user_request>',
    '```xml\n<command-args>代码示例</command-args>\n```',
    '<unknown_wrapper><current_user_request>普通内容</current_user_request></unknown_wrapper>',
  ]) assert.equal(meaningfulMessage('user', input), input.replace(/\s+/g, ' '));
  const code = '```xml\n</current_user_request>\n```';
  assert.equal(meaningfulMessage('user', `<current_user_request>${code}</current_user_request>`), code.replace(/\s+/g, ' '));
  for (const tag of ['interrupted_turn_context', 'current_user_request', 'command-args']) {
    const input = `<${tag}>助手正文</${tag}>`;
    assert.equal(meaningfulMessage('assistant', input), input);
  }
});

test('an incomplete first request never gives a later message its first-message identity or fallback title', async t => {
  const fixture = await setup(t, [meta, user('<current_user_request>首条请求缺少闭合'), user('后续请求', -3000), assistant('最近结果')]);
  const record = (await fixture.read()).records[0];
  assert.equal(record.firstMessage, ''); assert.equal(record.title, '未命名会话');
  assert.equal(record.latestMessage, '最近结果');
  await fs.appendFile(fixture.file, lines([user('再次追加', -500)]));
  const next = (await fixture.read()).records[0];
  assert.equal(next.firstMessage, ''); assert.equal(next.title, '未命名会话');
});

test('version 2 cursors and cached records repair wrapped first/latest requests without appends, preserving identity and native names', async t => {
  const { Store } = await import('../service/store.mjs');
  for (const connectorId of ['codex-rollout', 'claude-jsonl']) for (const named of [false, true]) {
    const firstRaw = '<interrupted_turn_context>中断上下文</interrupted_turn_context><current_user_request>真正的首条任务</current_user_request>';
    const latestRaw = '<command-name>/fixture</command-name><command-args>任务最新补充</command-args>';
    const entry = (text, offset) => connectorId === 'codex-rollout' ? user(text, offset) : {type: 'user', sessionId: ID, timestamp: stamp(offset), message: {role: 'user', content: text}};
    const entries = [...(connectorId === 'codex-rollout' ? [meta] : []), entry(firstRaw, -4000), entry(latestRaw, -1000)];
    if (named && connectorId === 'claude-jsonl') entries.push({type: 'custom-title', sessionId: ID, customTitle: '原应用固定名称', timestamp: stamp(-500)});
    const fixture = await setup(t, entries, connectorId);
    if (named && connectorId === 'codex-rollout') {
      const metadataRoot = path.join(fixture.root, 'metadata'); await fs.mkdir(metadataRoot);
      await fs.writeFile(path.join(metadataRoot, 'session_index.jsonl'), lines([{id: ID, thread_name: '原应用固定名称', updated_at: stamp(-500)}]));
      Object.assign(fixture.connection, {metadataRoot, canonicalMetadataRoot: metadataRoot});
    }
    const original = (await fixture.read()).records[0], beforeFile = await fs.stat(fixture.file);
    const cursor = [...fixture.cursors.values()][0], offset = cursor.offset;
    Object.assign(cursor.state, {namingVersion: 2, firstMessage: firstRaw, title: named ? original.title : firstRaw, latestMessage: latestRaw});
    cursor.state.timeline = [{role: 'user', at: NOW - 4000, text: firstRaw}, {role: 'user', at: NOW - 1000, text: latestRaw}];
    const store = new Store(path.join(fixture.root, 'cache')); t.after(() => store.close());
    store.mergeRecord({...original, namingVersion: 2, firstMessage: firstRaw, title: named ? original.title : firstRaw, latestMessage: latestRaw});
    const repaired = (await fixture.read()).records[0], merged = store.mergeRecord(repaired);
    for (const record of [repaired, merged]) {
      assert.equal(record.firstMessage, '真正的首条任务'); assert.equal(record.latestMessage, '任务最新补充');
      assert.equal(record.title, named ? '原应用固定名称' : '真正的首条任务');
      assert.equal(record.sourceTitle, original.sourceTitle); assert.equal(record.namingVersion, 3);
      assert.equal(record.id, original.id); assert.equal(record.updatedAt, original.updatedAt); assert.equal(record.createdAt, original.createdAt);
    }
    assert.equal([...fixture.cursors.values()][0].offset, offset);
    assert.equal((await fs.stat(fixture.file)).mtimeMs, beforeFile.mtimeMs);
    assert.equal((await fixture.read()).records[0].title, merged.title);
  }
});
