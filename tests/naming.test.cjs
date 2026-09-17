const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('../extension/core.js');
const S = require('../extension/suggestions.js');

const base = Date.now() - 10000;
const at = offset => base + offset;
const config = { baseUrl: 'https://model.example/v1', model: 'fixture-model', rules: '' };
const FIRST = 'FIRST_MESSAGE_AUTHORIZED_FOR_NAMING';
const LATEST = 'LATEST_MESSAGE_AUTHORIZED_FOR_NAMING';
const MIDDLE = 'MIDDLE_HISTORY_MUST_REMAIN_LOCAL';
const clone = value => structuredClone(value);
const observation = changes => ({ connectionId: 'source-fixture', allowAI: true, includeNaming: true, includeSummary: false, ...changes });
function unnamed(id = 'session:fixture', changes = {}) {
  return C.normalizeRecord({ id, kind: 'session', connectorId: 'fixture', title: FIRST, sourceTitle: '', titleBasis: 'first-message',
    firstMessage: FIRST, latestMessage: LATEST, updatedAt: at(2000), syncedAt: at(3000),
    summary: 'SUMMARY_REQUIRES_SEPARATE_PERMISSION', timeline: [{ at: at(1500), text: MIDDLE }],
    observations: [observation()], ...changes });
}
function reply(suggestions) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ suggestions }) } }] }) };
}
const proposal = (recordId, name = '示例研究计划') => ({ recordId, patch: { sessionName: name }, reason: '根据已许可的首尾消息' });
const modelInput = options => JSON.parse(JSON.parse(options.body).messages[1].content);
function stateFor(record) { const state = C.initial(); state.records.push(record); return state; }
async function generate(state, name = '示例研究计划') {
  const record = state.records[0];
  const result = await S.run({ config, projects: state.projects, items: [C.publicItem(record)], fetchImpl: async () => reply([proposal(record.id, name)]) });
  const suggestions = result.suggestions.map(item => ({ ...item, observedUpdatedAt: record.updatedAt,
    contentRevision: record.contentRevision, policyRevision: state.policyRevision }));
  state.suggestions.push(...suggestions);
  return suggestions;
}

test('naming eligibility requires a session with no source, manual or fixed name and both excerpts', () => {
  const record = unnamed();
  assert.equal(C.publicItem(record).needsSessionName, true);
  assert.equal(C.publicItem(unnamed('source', { sourceTitle: '来源原名', titleBasis: 'source-title' })).needsSessionName, false);
  for (const field of ['alias', 'sessionName']) {
    const named = unnamed(field); named.user[field] = '已有名称';
    assert.equal(C.publicItem(named).needsSessionName, false);
  }
  for (const field of ['firstMessage', 'latestMessage']) assert.equal(C.publicItem(unnamed(field, { [field]: '' })).needsSessionName, false);
  assert.equal(C.publicItem(C.normalizeRecord({ id: 'web', kind: 'web', title: '网页名称', url: 'https://example.test/' })).needsSessionName, false);
});

test('naming sends only separately authorized first and latest excerpts, never the middle history', async () => {
  const record = unnamed(); let outbound;
  const result = await S.run({ config, items: [C.publicItem(record)], fetchImpl: async (_url, options) => {
    outbound = options.body; return reply([proposal(record.id)]);
  } });
  const sent = modelInput({ body: outbound }).records[0];
  assert.deepEqual(sent.namingContext, { firstMessage: FIRST, latestMessage: LATEST });
  assert.ok(sent.editableFields.includes('sessionName'));
  assert.equal(sent.summary, undefined);
  assert.equal(sent.timeline, undefined); assert.equal(sent.firstMessage, undefined); assert.equal(sent.latestMessage, undefined);
  assert.equal(outbound.includes(MIDDLE), false);
  assert.equal(outbound.includes('SUMMARY_REQUIRES_SEPARATE_PERMISSION'), false);
  assert.equal(result.suggestions[0].patch.sessionName, '示例研究计划');
  assert.equal(record.user.sessionName, '');
});

test('denied naming cannot leak a first-message fallback through the title field', async () => {
  const record = unnamed('denied', { observations: [observation({ includeNaming: false })] });
  let outbound;
  await S.run({ config, items: [C.publicItem(record)], fetchImpl: async (_url, options) => { outbound = options.body; return reply([]); } });
  const sent = modelInput({ body: outbound }).records[0];
  assert.equal(sent.title, '未命名会话');
  assert.equal(sent.namingContext, undefined);
  assert.equal(sent.editableFields.includes('sessionName'), false);
  assert.equal(outbound.includes(FIRST), false); assert.equal(outbound.includes(LATEST), false); assert.equal(outbound.includes(MIDDLE), false);
});

test('naming consent is independent of summary consent and every observing connection must allow it', () => {
  const onlyNaming = S.prepare([C.publicItem(unnamed())]).included[0];
  assert.ok(onlyNaming.namingContext); assert.equal(onlyNaming.summary, undefined);
  const onlySummary = S.prepare([C.publicItem(unnamed('summary', { observations: [observation({ includeNaming: false, includeSummary: true })] }))]).included[0];
  assert.equal(onlySummary.namingContext, undefined); assert.equal(onlySummary.summary, 'SUMMARY_REQUIRES_SEPARATE_PERMISSION');
  for (const restriction of [{ includeNaming: false }, { includeNaming: undefined }]) {
    const mixed = unnamed('mixed', { observations: [observation(), observation({ connectionId: 'other', ...restriction })] });
    assert.equal(S.prepare([C.publicItem(mixed)]).included[0].namingContext, undefined);
  }
  const denied = unnamed('all-ai-denied', { observations: [observation(), observation({ connectionId: 'other', allowAI: false })] });
  assert.equal(S.prepare([C.publicItem(denied)]).included.length, 0);
});

test('existing source, manual and generated names never send naming excerpts', () => {
  const source = unnamed('source', { sourceTitle: '来源名称', titleBasis: 'source-title' });
  const manual = unnamed('manual'); manual.user.alias = '人工名称';
  const fixed = unnamed('fixed'); fixed.user.sessionName = '固定名称';
  const prepared = S.prepare([source, manual, fixed].map(item => C.publicItem(item)));
  assert.deepEqual(prepared.included.map(item => item.title), ['来源名称', '人工名称', '固定名称']);
  for (const item of prepared.included) {
    assert.equal(item.namingContext, undefined);
    assert.equal(item.editableFields.includes('sessionName'), false);
  }
  assert.equal(JSON.stringify(prepared.included).includes(FIRST), false);
  assert.equal(JSON.stringify(prepared.included).includes(LATEST), false);
});

test('naming can still be proposed when project, tags and summary have all been manually protected', () => {
  const record = unnamed(); record.user.manual = { projectId: true, tags: true, summary: true };
  const prepared = S.prepare([C.publicItem(record)]);
  assert.equal(prepared.excluded.length, 0);
  assert.deepEqual(prepared.included[0].editableFields, ['sessionName']);
});

test('model validation cannot gain naming permission from a mutated in-flight input object', async () => {
  const item = C.publicItem(unnamed('initial-denial', { observations: [observation({ includeNaming: false })] }));
  await assert.rejects(() => S.run({ config, items: [item], fetchImpl: async (_url, options) => {
    assert.equal(modelInput(options).records[0].namingContext, undefined);
    item.observations[0].includeNaming = true;
    item.firstMessage = 'LATE_FIRST_MESSAGE'; item.latestMessage = 'LATE_LAST_MESSAGE';
    return reply([proposal(item.id)]);
  } }));
});

test('naming inputs and validation remain a request snapshot while live objects change', async () => {
  const record = unnamed(), item = C.publicItem(record); let sent;
  const result = await S.run({ config, items: [item], fetchImpl: async (_url, options) => {
    sent = modelInput(options).records[0];
    item.user.alias = '后续人工命名'; item.firstMessage = 'NEW_FIRST'; item.latestMessage = 'NEW_LAST';
    return reply([proposal(item.id)]);
  } });
  assert.deepEqual(sent.namingContext, { firstMessage: FIRST, latestMessage: LATEST });
  assert.equal(result.suggestions[0].patch.sessionName, '示例研究计划');
  assert.equal(record.user.alias, '');
});

test('names require nonempty text within 80 characters and cannot rename already named records or webpages', async () => {
  for (const name of ['', '   ', '名'.repeat(81), 123, ['名称']]) {
    const record = unnamed();
    await assert.rejects(() => S.run({ config, items: [C.publicItem(record)], fetchImpl: async () => reply([proposal(record.id, name)]) }));
  }
  const valid = stateFor(unnamed());
  assert.equal((await generate(valid, '名'.repeat(80)))[0].patch.sessionName.length, 80);
  const named = unnamed('named', { sourceTitle: '来源已有名' });
  const web = C.normalizeRecord({ id: 'web', kind: 'web', title: '网页', url: 'https://example.test/' });
  for (const record of [named, web]) await assert.rejects(() => S.run({ config, items: [C.publicItem(record)], fetchImpl: async () => reply([proposal(record.id)]) }));
});

test('applied name is stable across later syncs and source titles, while a manual alias has priority', async () => {
  const record = unnamed(), state = stateFor(record), suggestions = await generate(state);
  assert.equal(C.applySuggestions(state, suggestions).applied, 1);
  assert.equal(record.user.sessionName, '示例研究计划');
  const namedUser = clone(record.user);
  C.upsert(state, [unnamed(record.id, { latestMessage: '后续执行进展', updatedAt: at(4000) })]);
  assert.deepEqual(record.user, namedUser); assert.equal(C.publicItem(record).title, '示例研究计划');
  C.upsert(state, [unnamed(record.id, { sourceTitle: '来源后续名称', titleBasis: 'source-title', latestMessage: '又有进展', updatedAt: at(5000) })]);
  assert.equal(C.publicItem(record).title, '示例研究计划'); assert.equal(C.publicItem(record).titleBasis, 'generated-name');
  C.userPatch(state, record.id, { alias: '用户优先名称' });
  assert.equal(C.publicItem(record).title, '用户优先名称');
  assert.equal(C.publicItem(record).titleBasis, 'manual-alias');
  assert.equal(record.user.sessionName, '示例研究计划');
  assert.equal(S.prepare([C.publicItem(record)]).included[0].namingContext, undefined);
});

test('applying and undoing a generated name works, but subsequent manual edits block stale apply and undo', async () => {
  const record = unnamed(), state = stateFor(record), suggestions = await generate(state);
  C.applySuggestions(state, suggestions);
  assert.equal(C.undo(state).restored, 1); assert.equal(record.user.sessionName, '');
  const again = await generate(state); C.userPatch(state, record.id, { alias: '预览后人工命名' });
  assert.equal(C.applySuggestions(state, again).applied, 0); assert.equal(record.user.sessionName, '');
  const otherRecord = unnamed('undo-conflict'), other = stateFor(otherRecord), accepted = await generate(other);
  C.applySuggestions(other, accepted); C.userPatch(other, otherRecord.id, { alias: '应用后人工命名' });
  const undo = C.undo(other); assert.equal(undo.restored, 0); assert.equal(undo.conflicts, 1);
  assert.equal(C.publicItem(otherRecord).title, '应用后人工命名');
});

test('revoking naming on any observation blocks an existing proposal at apply time', async () => {
  const record = unnamed(), state = stateFor(record), suggestions = await generate(state);
  record.observations.push(observation({ connectionId: 'now-restricted', includeNaming: false }));
  assert.equal(C.applySuggestions(state, suggestions).applied, 0);
  assert.equal(record.user.sessionName, '');
});

test('source title appearance and changes invalidate naming proposals without a newer activity timestamp', async () => {
  for (const activity of [at(2000), null]) {
    const record = unnamed('source-change-' + activity, { updatedAt: activity, ...(activity === null ? {connectorId: 'standard-import'} : {}) }), state = stateFor(record), suggestions = await generate(state);
    const before = record.contentRevision;
    C.upsert(state, [unnamed(record.id, { sourceTitle: '新出现的来源原名', titleBasis: 'source-title', updatedAt: activity })]);
    assert.ok(record.contentRevision > before); assert.equal(record.updatedAt, activity);
    assert.equal(C.applySuggestions(state, suggestions).applied, 0);
    assert.equal(C.publicItem(record).title, '新出现的来源原名');
    const firstVersion = record.contentRevision;
    C.upsert(state, [unnamed(record.id, { sourceTitle: '修改后的来源原名', titleBasis: 'source-title', updatedAt: activity })]);
    assert.ok(record.contentRevision > firstVersion); assert.equal(record.updatedAt, activity);
    assert.equal(C.publicItem(record).title, '修改后的来源原名');
  }
});

async function boot(initial) {
  let disk = clone(initial);
  const local = {}, session = {}, event = () => ({ addListener() {} });
  const storage = value => ({ get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, clone(value[key])])),
    set: async patch => Object.assign(value, clone(patch)), remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete value[key]; }, setAccessLevel: async () => {} });
  const context = { URL, crypto, structuredClone, AbortController, AbortSignal, DOMException, console, setTimeout: () => 0, clearTimeout() {},
    TaskOutCore: C, TaskOutSuggestions: S, TaskOutStore: { read: async () => clone(disk), write: async state => { disk = clone(state); } }, importScripts() {},
    fetch: async () => { throw Error('No network in naming persistence test'); },
    chrome: { storage: { local: storage(local), session: storage(session) }, permissions: { contains: async () => true },
      runtime: { id: 'a'.repeat(32), getURL: p => 'chrome-extension://' + 'a'.repeat(32) + '/' + p, sendMessage: async () => {}, onMessage: event(), onStartup: event(), onInstalled: event() },
      tabs: { query: async () => [], onCreated: event(), onUpdated: event(), onRemoved: event(), onActivated: event() }, windows: { onFocusChanged: event() },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: event() }, alarms: { create() {}, onAlarm: event() } }
  };
  vm.createContext(context); vm.runInContext(fs.readFileSync('extension/background.js', 'utf8') + '\nglobalThis.api = {ready, dispatch};', context);
  await context.api.ready;
  return { call: (action, fields = {}) => context.api.dispatch({ action, ...fields }), disk: () => clone(disk) };
}

test('fixed names persist through background save/reload and content backup import/export', async () => {
  const state = stateFor(unnamed()), suggestions = await generate(state);
  const app = await boot(state);
  assert.equal((await app.call('ai-apply', { suggestions })).applied, 1);
  const restarted = await boot(app.disk());
  assert.equal((await restarted.call('snapshot')).state.items[0].title, '示例研究计划');
  const backup = (await restarted.call('export')).data;
  assert.equal(backup.records[0].user.sessionName, '示例研究计划');
  const target = await boot(C.initial());
  const { preview } = await target.call('import-preview', { datasetId: '命名备份', text: JSON.stringify(backup) });
  assert.equal(preview.records[0].user.sessionName, '示例研究计划');
  await target.call('import-apply', { datasetId: '命名备份', text: JSON.stringify(backup) });
  const restored = (await target.call('snapshot')).state.items[0];
  assert.equal(restored.title, '示例研究计划'); assert.equal(restored.titleBasis, 'generated-name');
  assert.equal(restored.needsSessionName, false); assert.equal(restored.user.sessionName, '示例研究计划');
  const importedReload = await boot(target.disk());
  assert.equal((await importedReload.call('snapshot')).state.items[0].user.sessionName, '示例研究计划');
});

test('dedicated naming sends only the two allowed excerpts and requires one fixed-name proposal per session',async()=>{
  const state=stateFor(unnamed());let payload;
  const result=await S.run({items:[C.publicItem(state.records[0])],projects:[{id:'private-project',name:'DO_NOT_SEND_PROJECT'}],config:{...config,rules:'DO_NOT_SEND_GROUP_RULES'},namingOnly:true,
    fetchImpl:async(_url,options)=>{payload=options.body;return reply([proposal(state.records[0].id)]);}});
  const input=modelInput({body:payload});
  assert.deepEqual(input.projects,[]);assert.equal(input.preferences,'');
  assert.deepEqual(input.records[0].editableFields,['sessionName']);
  assert.deepEqual(input.records[0].namingContext,{firstMessage:FIRST,latestMessage:LATEST});
  assert.equal(input.records[0].summary,undefined);assert.equal(input.records[0].tags,undefined);
  assert.equal(payload.includes('DO_NOT_SEND'),false);
  assert.equal(result.suggestions[0].patch.sessionName,'示例研究计划');
  for(const suggestions of [[],[{recordId:state.records[0].id,patch:{tags:['调研分析']}}]]) {
    await assert.rejects(S.run({items:[C.publicItem(state.records[0])],config,namingOnly:true,fetchImpl:async()=>reply(suggestions)}),/名称/);
  }
});

test('dedicated naming skips source names, fixed names and denied messages without a network request',async()=>{
  const named=unnamed('named',{sourceTitle:'原会话名称'}),fixed=unnamed('fixed'),denied=unnamed('denied',{observations:[observation({includeNaming:false})]});
  fixed.user.sessionName='已固定的会话名';
  const result=await S.run({items:[named,fixed,denied].map(r=>C.publicItem(r)),config,namingOnly:true,fetchImpl:()=>assert.fail('No messages may be sent')});
  assert.equal(result.suggestions.length,0);assert.equal(result.excluded.length,3);
});
