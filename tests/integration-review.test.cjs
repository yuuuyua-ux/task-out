const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const C = require('../extension/core.js');
const Suggestions = require('../extension/suggestions.js');

const base = Date.now() - 10000;
const at = offset => base + offset;
const clone = value => structuredClone(value);
function example(overrides = {}) {
  return C.normalizeRecord({ id: 'claude:example', kind: 'session', connectorId: 'claude-jsonl',
    title: '示例任务', summary: '原始近况', updatedAt: at(1000), syncedAt: at(2000),
    observations: [{ connectionId: 'conn-example', allowAI: true, includeSummary: true }], ...overrides });
}
const response = data => ({ ok: true, status: 200, json: async () => clone(data) });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function background(initial, fetchImpl, options = {}) {
  let disk = clone(initial);
  let clock = Date.now();
  class Clock extends Date { static now() { return clock; } }
  const local = { taskOutBridge: { url: 'http://127.0.0.1:4518', token: 'synthetic-token' },
    taskOutModel: { baseUrl: 'https://model.example/v1', model: 'example', apiKey: '', autoSuggest: false }, ...clone(options.local || {}) };
  const session = clone(options.session || {});
  let scheduled;
  const storage = data => ({
    get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, clone(data[key])])),
    set: async value => { Object.assign(data, clone(value)); },
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
    setAccessLevel: async () => {}
  });
  const event = () => ({ addListener() {} });
  const context = {
    console, URL, crypto, Date: Clock, structuredClone, AbortController, AbortSignal, DOMException,
    setTimeout: callback => { scheduled = callback; return 1; },
    clearTimeout: () => { scheduled = null; },
    TaskOutCore: C, TaskOutModelLifetime:require('../extension/model-lifetime.js'),TaskOutSuggestions: { ...Suggestions,
      run: args => Suggestions.run({ ...args, fetchImpl }), testConnection: args => Suggestions.testConnection({ ...args, fetchImpl }) },
    TaskOutStore: { read: async () => clone(disk), write: async state => { disk = clone(state); } },
    importScripts() {}, fetch: fetchImpl,
    chrome: {
      storage: { local: storage(local), session: storage(session) },
      permissions: { contains: options.permission || (async () => true) },
      runtime: { id: 'test-extension', getURL: path => 'chrome-extension://test-extension/' + path,
        sendMessage: async () => {}, onMessage: event(), onStartup: event(), onInstalled: event() },
      tabs: { query: options.tabs || (async () => []), onCreated: event(), onUpdated: event(), onRemoved: event(), onActivated: event() },
      windows: { onFocusChanged: event() },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      alarms: { create() {}, onAlarm: event() }
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('extension/background.js', 'utf8') + '\nglobalThis.review = {dispatch, ready, scheduleSuggestions};', context);
  await context.review.ready;
  return { dispatch: context.review.dispatch, disk: () => clone(disk), local: () => clone(local), advance: ms => { clock += ms; },
    tick: async () => { context.review.scheduleSuggestions(); const callback = scheduled; scheduled = null; await callback(); } };
}

test('review: asynchronous upsert preserves manual changes, archival and their revision', () => {
  const state = C.initial(), record = example(); state.records.push(record);
  const project = C.saveProject(state, { name: '自定义项目' });
  C.userPatch(state, record.id, { projectId: project.id, tags: ['使用咨询'], summary: '人工近况' });
  record.user.archived = true; record.user.archivedAt = 3000;
  const before = clone(record.user);
  C.upsert(state, [example({ summary: '后台新近况', updatedAt: at(4000) })]);
  assert.deepEqual(record.user, before);
  assert.equal(C.publicItem(record).summary, '人工近况');
  assert.equal(record.summary, '后台新近况');
});

test('review: old AI suggestions cannot be applied after source permission is revoked', () => {
  const state = C.initial(), record = example(); state.records.push(record);
  const proposal = { id: 'suggestion-a', recordId: record.id, revision: 0, observedUpdatedAt: record.updatedAt, patch: { tags: ['方案设计'] } };
  state.suggestions.push(proposal);
  record.observations[0].allowAI = false;
  const result = C.applySuggestions(state, [proposal]);
  assert.equal(result.applied, 0);
  assert.deepEqual(record.user.tags, []);
});

test('review: stale detail response cannot restore source permission revoked while it was in flight', async () => {
  const state = C.initial(); state.records.push(example()); state.bridge.paired = true;
  let connection = { id: 'conn-example', allowAI: true, includeSummary: true };
  state.connections = [clone(connection)];
  const started = deferred(), detail = deferred();
  const app = await background(state, async (url, options) => {
    const path = new URL(url).pathname;
    if (path.startsWith('/v1/records/')) { started.resolve(); return detail.promise; }
    if (path === '/v1/connections/conn-example') { connection.allowAI = false; return response({ connection }); }
    if (path === '/v1/connectors') return response({ connectors: [] });
    if (path === '/v1/connections') return response({ connections: [connection] });
    throw Error('Unexpected request: ' + path);
  });
  const request = app.dispatch({ action: 'record-detail', id: state.records[0].id });
  await started.promise;
  await app.dispatch({ action: 'service', path: '/v1/connections/conn-example', method: 'PATCH', body: { allowAI: false } });
  detail.resolve(response({ record: example() }));
  await request;
  assert.equal(app.disk().records[0].observations[0].allowAI, false);
});

test('review: a delayed sync cannot replace a newer user permission change with old connection settings', async () => {
  const state = C.initial(); state.records.push(example()); state.bridge.paired = true;
  let connection = { id: 'conn-example', allowAI: true, includeSummary: true };
  state.connections = [clone(connection)];
  const started = deferred(), sync = deferred();
  const app = await background(state, async url => {
    const path = new URL(url).pathname;
    if (path === '/v1/sync') { started.resolve(); return sync.promise; }
    if (path === '/v1/connections/conn-example') { connection.allowAI = false; return response({ connection }); }
    if (path === '/v1/connectors') return response({ connectors: [] });
    if (path === '/v1/connections') return response({ connections: [connection] });
    throw Error('Unexpected request: ' + path);
  });
  const request = app.dispatch({ action: 'refresh' });
  await started.promise;
  await app.dispatch({ action: 'service', path: '/v1/connections/conn-example', method: 'PATCH', body: { allowAI: false } });
  sync.resolve(response({ records: [example()], connections: [{ id: 'conn-example', allowAI: true, includeSummary: true }] }));
  await request;
  assert.equal(app.disk().connections[0].allowAI, false);
  assert.equal(app.disk().records[0].observations[0].allowAI, false);
});

test('review: long Chinese dataset names do not merge unrelated imported records', () => {
  const parsed = C.importRecords('数'.repeat(80), JSON.stringify([
    { id: 'first', kind: 'session', title: '第一条' }, { id: 'second', kind: 'session', title: '第二条' }
  ]));
  const state = C.initial(); C.upsert(state, parsed.records);
  assert.equal(new Set(parsed.records.map(record => record.id)).size, 2);
  assert.equal(state.records.length, 2);
});

test('review: later imports update title and summary even when source activity time is unknown', () => {
  const state = C.initial();
  C.upsert(state, [example({ title: '旧标题', summary: '旧内容', updatedAt: null, syncedAt: 1000 })]);
  C.upsert(state, [example({ title: '新标题', summary: '新内容', updatedAt: null, syncedAt: 2000 })]);
  assert.equal(state.records[0].title, '新标题');
  assert.equal(state.records[0].summary, '新内容');
});

test('review: export/import restores explicit source identity and original manual override semantics', async () => {
  const state = C.initial(), record = example(); state.records.push(record);
  record.user.sourceOverride = { id: 'user:示例应用', label: '示例应用', icon: '◇', basis: 'user-confirmed' };
  record.user.archived = true; record.user.archivedAt = 1100; record.user.archivedActivityAt = 1000;
  const source = await background(state, () => { throw Error('No network'); });
  const backup = await source.dispatch({ action: 'export' });
  const target = await background(C.initial(), () => { throw Error('No network'); });
  await target.dispatch({ action: 'import-apply', datasetId: 'backup', text: JSON.stringify(backup.data) });
  const restored = target.disk().records[0];
  assert.deepEqual(restored.user.sourceOverride, record.user.sourceOverride);
  assert.equal(restored.user.summaryOverride, null);
  assert.deepEqual(restored.user.manual, record.user.manual);
  assert.equal(restored.user.archivedActivityAt, 1000);
});

test('review: importing a backup cleans up empty projects without changing the original backup or preview', async () => {
  const source = await background(C.initial(), () => { throw Error('No network'); });
  await source.dispatch({action:'project-save',name:'空项目'});
  const backup = await source.dispatch({ action: 'export' });
  const original=JSON.stringify(backup.data);
  assert.equal(backup.data.projects.length,1);
  const target = await background(C.initial(), () => { throw Error('No network'); });
  const {preview}=await target.dispatch({action:'import-preview',datasetId:'backup',text:original});
  assert.equal(preview.projects.length,1);
  await target.dispatch({ action: 'import-apply', datasetId: 'backup', text: original });
  assert.equal(target.disk().projects.length,0);
  assert.equal(target.disk().records.length,0);
  assert.equal(preview.projects[0].name,'空项目');
  assert.equal(JSON.stringify(backup.data),original);
});

test('review: imported namespaces remain distinct across delimiters and long original IDs', () => {
  const a = C.importRecords('a:b', JSON.stringify([{ id: 'c', kind: 'session' }])).records[0];
  const b = C.importRecords('a', JSON.stringify([{ id: 'b:c', kind: 'session' }])).records[0];
  assert.notEqual(a.id, b.id);
  const long = 'x'.repeat(350);
  const result = C.importRecords('dataset', JSON.stringify([
    { id: long + '-a', kind: 'session' }, { id: long + '-b', kind: 'session', parentId: long + '-a' }
  ]));
  assert.equal(result.records.length, 2);
  assert.notEqual(result.records[0].id, result.records[1].id);
  assert.equal(result.records[1].parentId, result.records[0].id);
  const rejected = C.importRecords('dataset', JSON.stringify([{ id: 'x'.repeat(600), kind: 'session' }]));
  assert.equal(rejected.records.length, 0);
  assert.match(rejected.warnings[0], /过长/);
  assert.throws(() => C.importRecords('x'.repeat(101), '[]'), /100/);
});

test('review: import preview matches restored project and user fields; subsequent imports preserve edits', async () => {
  const backup = {
    format: 'task-out-records', version: 2, projects: [{ id: 'p-original', name: '归档项目', color: C.COLORS[1] }],
    records: [{ ...example(), user: { ...C.defaultUser(), projectId: 'p-original', tags: ['调研分析'], alias: '自定义标题',
      summaryOverride: null, manual: { projectId: true, tags: true, summary: false } } }]
  };
  const content = JSON.stringify(backup);
  const app = await background(C.initial(), () => { throw Error('No network'); });
  const { preview } = await app.dispatch({ action: 'import-preview', datasetId: '备份', text: content });
  await app.dispatch({ action: 'import-apply', datasetId: '备份', text: content });
  const record = app.disk().records[0];
  assert.deepEqual(record.user, preview.records[0].user);
  assert.deepEqual(app.disk().projects, preview.projects);
  assert.equal(record.user.projectId, preview.projects[0].id);
  await app.dispatch({ action: 'record-edit', id: record.id, patch: { alias: '后续手动改名', summary: '后续人工近况' } });
  await app.dispatch({ action: 'import-apply', datasetId: '备份', text: content });
  assert.equal(app.disk().records.length, 1);
  assert.equal(app.disk().projects.length, 1);
  assert.equal(app.disk().records[0].user.alias, '后续手动改名');
  assert.equal(app.disk().records[0].user.summaryOverride, '后续人工近况');
});

function suggestedState() {
  const state = C.initial(), record = example(); state.records.push(record);
  state.bridge.paired = true;
  state.connections = [{ id: 'conn-example', allowAI: true, includeSummary: true }];
  state.suggestions.push({ id: 'suggestion-review', recordId: record.id, revision: 0, contentRevision: 0,
    policyRevision: 0, observedUpdatedAt: record.updatedAt, patch: { summary: '基于之前许可的近况生成的建议' } });
  return state;
}

test('review: sync-discovered summary permission restrictions invalidate existing suggestions', async () => {
  const state = suggestedState(), suggestions = clone(state.suggestions);
  const app = await background(state, async url => {
    const pathname = new URL(url).pathname;
    if (pathname === '/v1/connectors') return response({ connectors: [] });
    if (pathname === '/v1/sync') return response({ records: [example()], connections: [{ id: 'conn-example', allowAI: true, includeSummary: false }] });
    throw Error('Unexpected request');
  });
  await app.dispatch({ action: 'refresh' });
  const result = await app.dispatch({ action: 'ai-apply', suggestions });
  assert.equal(result.applied, 0);
  assert.equal(app.disk().records[0].user.summaryOverride, null);
});

test('review: revoking naming permission invalidates the preview and cached observation without changing other permissions', async () => {
  const state = suggestedState();
  state.connections[0].includeNaming = true;
  state.records[0] = example({sourceTitle: '', titleBasis: 'first-message', firstMessage: '比较任务看板', latestMessage: '方案比较完成',
    observations: [{connectionId: 'conn-example', allowAI: true, includeSummary: true, includeNaming: true}]});
  state.suggestions[0].patch = {sessionName: '任务看板方案比较'};
  const suggestions = clone(state.suggestions);
  const app = await background(state, async url => {
    const pathname = new URL(url).pathname;
    if (pathname === '/v1/connectors') return response({connectors: []});
    if (pathname === '/v1/sync') return response({records: [state.records[0]], connections: [{...state.connections[0], includeNaming: false}]});
    throw Error('Unexpected request');
  });
  await app.dispatch({action: 'refresh'});
  const snapshot = app.disk();
  assert.equal(snapshot.records[0].observations[0].includeNaming, false);
  assert.equal(snapshot.records[0].observations[0].allowAI, true);
  assert.equal(snapshot.records[0].observations[0].includeSummary, true);
  assert.equal(snapshot.suggestions.length, 0);
  const result = await app.dispatch({action: 'ai-apply', suggestions});
  assert.equal(result.applied, 0);
  assert.equal(app.disk().records[0].user.sessionName, '');
});

test('review: narrowing the task window hides cached tasks without losing edits, widening restores them after a worker restart', async () => {
  const now = Date.now(), state = C.initial();
  let connection = {id: 'conn-example', historyDays: 30, allowAI: false};
  state.connections = [clone(connection)];
  const record = example({updatedAt: now - 10 * 86400000});
  state.records.push(record);
  const project=C.saveProject(state,{name:'超窗仍保留的项目',color:C.COLORS[2]});
  C.userPatch(state, record.id, {alias: '保留的人工名称', tags: ['使用咨询'],projectId:project.id});
  const archive = example({id: 'archived-example', updatedAt: now - 40 * 86400000});
  archive.user.archived = true; state.records.push(archive);
  const web = C.normalizeRecord({id: 'saved-web', kind: 'web', title: '网页', url: 'https://example.com/', updatedAt: 1000});
  state.records.push(web);
  const transport = async (url, options) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/v1/connections/conn-example') { connection = {...connection, ...JSON.parse(options.body)}; return response({connection}); }
    if (pathname === '/v1/connections') return response({connections: [connection]});
    if (pathname === '/v1/connectors') return response({connectors: []});
    if (pathname === '/v1/sync') return response({records: [], connections: [connection]});
    throw Error('Unexpected request');
  };
  let app = await background(state, transport);
  assert.equal((await app.dispatch({action: 'snapshot'})).state.items.length, 3);
  await app.dispatch({action: 'service', method: 'PATCH', path: '/v1/connections/conn-example', body: {historyDays: 3}});
  await app.dispatch({action: 'refresh'});
  let snapshot = (await app.dispatch({action: 'snapshot'})).state;
  assert.deepEqual(snapshot.items.map(item => item.id), ['archived-example', 'saved-web']);
  assert.equal(snapshot.historyExcluded, 1);
  assert.equal(app.disk().records.find(item => item.id === record.id).user.alias, '保留的人工名称');
  assert.deepEqual(app.disk().projects,[project]);
  app = await background(app.disk(), transport);
  assert.deepEqual(app.disk().projects,[project]);
  await app.dispatch({action: 'service', method: 'PATCH', path: '/v1/connections/conn-example', body: {historyDays: 30}});
  snapshot = (await app.dispatch({action: 'snapshot'})).state;
  assert.equal(snapshot.items.find(item => item.id === record.id).title, '保留的人工名称');
  assert.deepEqual(snapshot.items.find(item => item.id === record.id).tags, ['使用咨询']);
  assert.equal(snapshot.items.find(item => item.id === record.id).projectId,project.id);
  assert.deepEqual(snapshot.projects,[project]);
  assert.equal(snapshot.historyExcluded, 0);
});

test('review: disconnected legacy caches without windows cannot reappear or enter model requests', async () => {
  const now = Date.now(), state = C.initial();
  const expired = example({id: 'old-local', updatedAt: now - 40 * 86400000});
  expired.user.alias = '保留的旧任务名称';
  const archived = example({id: 'old-archived', updatedAt: now - 40 * 86400000});
  archived.user.archived = true;
  const current = example({id: 'recent-local', updatedAt: now - 86400000});
  const imported = C.importRecords('history-backup', JSON.stringify([{id: 'old-import', kind: 'session', title: '人工导入历史', updatedAt: now - 90 * 86400000}])).records[0];
  const web = C.normalizeRecord({id: 'web', kind: 'web', title: '保留网页', url: 'https://example.com/', updatedAt: null});
  state.records = [expired, archived, current, imported, web];
  let modelRequests = 0;
  const offline = async url => { if (new URL(url).pathname.endsWith('/chat/completions')) modelRequests++; throw Error('Offline fixture'); };
  let app = await background(state, offline);
  await app.dispatch({action: 'refresh'}).catch(() => {});
  let snapshot = (await app.dispatch({action: 'snapshot'})).state;
  assert.deepEqual(snapshot.items.map(item => item.id), [archived.id, current.id, imported.id, web.id]);
  assert.equal(snapshot.historyExcluded, 1);
  const result = await app.dispatch({action: 'ai-preview', ids: [expired.id]});
  assert.equal(result.suggestions.length, 0);
  assert.equal(modelRequests, 0);
  assert.equal(app.disk().records.find(item => item.id === expired.id).user.alias, '保留的旧任务名称');
  app = await background(app.disk(), offline);
  snapshot = (await app.dispatch({action: 'snapshot'})).state;
  assert.equal(snapshot.items.some(item => item.id === expired.id), false);
  assert.equal(snapshot.items.some(item => item.id === archived.id), true);
});

test('review: changing paired services revokes cached permissions even if the first new sync fails', async () => {
  const state = suggestedState(), suggestions = clone(state.suggestions);
  const app = await background(state, async url => {
    if (new URL(url).pathname === '/pair') return response({ token: 'new-synthetic-token' });
    throw Error('New service temporarily offline');
  });
  await app.dispatch({ action: 'pair', url: 'http://127.0.0.1:4519', code: '12345678' }).catch(() => {});
  const result = await app.dispatch({ action: 'ai-apply', suggestions });
  assert.equal(result.applied, 0);
  assert.equal(app.disk().records[0].observations[0].allowAI, false);
});

test('review: switching services during a sync runs a fresh sync for the newly paired service', async () => {
  const state = suggestedState(), oldSyncStarted = deferred(), oldSync = deferred();
  let newSyncRequests = 0;
  const app = await background(state, async url => {
    const address = new URL(url);
    if (address.pathname === '/pair') return response({ token: 'new-synthetic-token' });
    if (address.pathname === '/v1/connectors') return response({ connectors: [] });
    if (address.pathname === '/v1/sync' && address.port === '4518') { oldSyncStarted.resolve(); return oldSync.promise; }
    if (address.pathname === '/v1/sync' && address.port === '4519') { newSyncRequests++; return response({ records: [], connections: [] }); }
    throw Error('Unexpected request');
  });
  const refresh = app.dispatch({ action: 'refresh' });
  await oldSyncStarted.promise;
  const pairing = app.dispatch({ action: 'pair', url: 'http://127.0.0.1:4519', code: '12345678' });
  await new Promise(setImmediate);
  oldSync.resolve(response({ records: [example()], connections: state.connections }));
  await Promise.all([refresh, pairing]);
  assert.equal(newSyncRequests, 1);
  assert.equal(app.disk().connections.length, 0);
});

test('review: forgetting the model key removes legacy migrated credentials as well', async () => {
  const key = 'SYNTHETIC_LEGACY_KEY', model = { baseUrl: 'https://model.example/v1', model: 'example', apiKey: key };
  const app = await background(C.initial(), () => { throw Error('No network'); }, { local: { taskOutModel: model, llmConfig: model } });
  await app.dispatch({ action: 'model-save', baseUrl: model.baseUrl, model: model.model, forgetKey: true });
  assert.equal(app.local().taskOutModel.apiKey, '');
  assert.equal(JSON.stringify(app.local()).includes(key), false);
});

test('review: omitted, empty and whitespace-only model fields preserve the saved configuration', async () => {
  const saved = { timeoutSeconds:120, maxGroups: 5, baseUrl: 'https://model.example/v1', model: 'example', apiKey: 'SYNTHETIC_SAVED_KEY',
    rules: '优先按任务目标分类', autoSuggest: true, autoOrganize: true };
  const app = await background(C.initial(), () => { throw Error('No network'); }, { local: { taskOutModel: saved } });
  for (const fields of [{}, { baseUrl: '', model: '', rules: '', apiKey: '' },
    { baseUrl: ' \t\n ', model: ' \t\n ', rules: ' \t\n ', apiKey: ' \t\n ' }]) {
    await app.dispatch({ action: 'model-save', ...fields });
    assert.deepEqual(app.local().taskOutModel, saved);
  }
});

test('review: a partial model save changes only supplied values, including explicit false', async () => {
  const saved = { timeoutSeconds:120, maxGroups: 5, baseUrl: 'https://model.example/v1', model: 'example', apiKey: 'SYNTHETIC_SAVED_KEY',
    rules: '优先按任务目标分类', autoSuggest: true, autoOrganize: true };
  const app = await background(C.initial(), () => { throw Error('No network'); }, { local: { taskOutModel: saved } });
  await app.dispatch({ action: 'model-save', model: ' next-model ', baseUrl: '', apiKey: '', rules: '', autoSuggest: false });
  const expected = { ...saved, model: 'next-model', autoSuggest: false };
  assert.deepEqual(app.local().taskOutModel, expected);
  const restarted = await background(app.disk(), () => { throw Error('No network'); }, { local: app.local() });
  await restarted.dispatch({ action: 'model-save', rules: '新增整理偏好' });
  assert.deepEqual(restarted.local().taskOutModel, { ...expected, rules: '新增整理偏好' });
});

test('review: first-time model setup still requires an address and a model', async () => {
  for (const fields of [{}, { baseUrl: 'https://model.example/v1' }, { model: 'example' },
    { baseUrl: ' \n ', model: '\t' }]) {
    const app = await background(C.initial(), () => { throw Error('No network'); }, { local: { taskOutModel: {} } });
    await assert.rejects(app.dispatch({ action: 'model-save', ...fields }));
    assert.deepEqual(app.local().taskOutModel, {});
  }
});

test('review: changing the model service without a replacement key or explicit clear is rejected atomically', async () => {
  const saved = { timeoutSeconds:120, maxGroups: 5, baseUrl: 'https://model.example/v1', model: 'example', apiKey: 'SYNTHETIC_SAVED_KEY',
    rules: '优先按任务目标分类', autoSuggest: true, autoOrganize: true };
  const app = await background(C.initial(), () => { throw Error('No network'); }, { local: { taskOutModel: saved } });
  for (const key of [undefined, '', ' \t\n ']) {
    await assert.rejects(app.dispatch({ action: 'model-save', baseUrl: 'https://other-model.example/v1',
      model: 'different-model', rules: '不应保存的偏好', autoSuggest: false, ...(key === undefined ? {} : { apiKey: key }) }));
    assert.deepEqual(app.local().taskOutModel, saved);
  }
});

test('review: equivalent model service URL forms preserve the existing key', async () => {
  for (const [oldUrl, enteredUrl] of [
    ['https://model.example/v1', ' https://model.example/v1/chat/completions/ '],
    ['https://model.example/v1/chat/completions', 'https://model.example/v1']
  ]) {
    const saved = { timeoutSeconds:120, maxGroups: 5, baseUrl: oldUrl, model: 'example', apiKey: 'SYNTHETIC_SAVED_KEY', rules: '已有偏好', autoSuggest: false, autoOrganize: true };
    const app = await background(C.initial(), () => { throw Error('No network'); }, { local: { taskOutModel: saved } });
    await app.dispatch({ action: 'model-save', baseUrl: enteredUrl, apiKey: '' });
    assert.deepEqual(app.local().taskOutModel, { ...saved, baseUrl: 'https://model.example/v1' });
  }
});

test('review: changing the model service accepts an explicit replacement key or explicit clear', async () => {
  const saved = { timeoutSeconds:120, maxGroups: 5, baseUrl: 'https://model.example/v1', model: 'example', apiKey: 'SYNTHETIC_SAVED_KEY',
    rules: '已有偏好', autoSuggest: false, autoOrganize: true };
  for (const fields of [{ apiKey: ' SYNTHETIC_REPLACEMENT_KEY ' }, { forgetKey: true }]) {
    const app = await background(C.initial(), () => { throw Error('No network'); }, { local: { taskOutModel: saved } });
    await app.dispatch({ action: 'model-save', baseUrl: 'https://other-model.example/v1', ...fields });
    assert.deepEqual(app.local().taskOutModel, { ...saved, baseUrl: 'https://other-model.example/v1',
      apiKey: fields.forgetKey ? '' : 'SYNTHETIC_REPLACEMENT_KEY' });
  }
});

test('review: concurrent partial model saves merge against the latest completed save', async () => {
  const saved = { timeoutSeconds:120, maxGroups: 5, baseUrl: 'https://model.example/v1', model: 'example', apiKey: 'SYNTHETIC_SAVED_KEY',
    rules: '已有偏好', autoSuggest: true, autoOrganize: true };
  const gate = deferred(), firstSaveStarted = deferred();
  let checks = 0;
  const app = await background(C.initial(), () => { throw Error('No network'); }, {
    local: { taskOutModel: saved },
    permission: async () => { if (++checks === 1) { firstSaveStarted.resolve(); await gate.promise; } return true; }
  });
  const first = app.dispatch({ action: 'model-save', model: 'next-model' });
  await firstSaveStarted.promise;
  const second = app.dispatch({ action: 'model-save', rules: '新的整理偏好' });
  const third = app.dispatch({ action: 'model-save', forgetKey: true, autoSuggest: false });
  await new Promise(setImmediate);
  gate.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(app.local().taskOutModel, { ...saved, model: 'next-model', rules: '新的整理偏好', apiKey: '', autoSuggest: false });
});

test('review: a concurrent settings save cannot restore a key after a later clear request', async () => {
  const gate = deferred(), firstSaveStarted = deferred();
  let checks = 0;
  const app = await background(C.initial(), () => { throw Error('No network'); }, {
    local: { taskOutModel: { baseUrl: 'https://model.example/v1', model: 'example', apiKey: 'SYNTHETIC_KEY' } },
    permission: async () => { checks++; if (checks === 1) { firstSaveStarted.resolve(); await gate.promise; } return true; }
  });
  const saving = app.dispatch({ action: 'model-save', baseUrl: 'https://model.example/v1', model: 'renamed-model' });
  await firstSaveStarted.promise;
  const clearing = app.dispatch({ action: 'model-save', baseUrl: 'https://model.example/v1', model: 'example', forgetKey: true });
  await new Promise(setImmediate);
  gate.resolve();
  await Promise.all([saving, clearing]);
  assert.equal(app.local().taskOutModel.apiKey, '');
});

test('review: automatic empty suggestions are not repeatedly requested, including after worker restart', async () => {
  const state = suggestedState(); state.suggestions = [];
  let requests = 0;
  const options = { fakeTimers: true, local: { taskOutModel: { baseUrl: 'https://model.example/v1', model: 'example', apiKey: '', autoSuggest: true } } };
  const fetchImpl = async url => {
    assert.equal(new URL(url).pathname, '/v1/chat/completions');
    requests++;
    return response({ choices: [{ finish_reason: 'stop', message: { content: '{"suggestions":[]}' } }] });
  };
  const app = await background(state, fetchImpl, options);
  await app.tick(); await app.tick(); await app.tick();
  assert.equal(requests, 1);
  assert.ok(app.disk().organizationAttempts[state.records[0].id]);
  const restarted = await background(app.disk(), fetchImpl, options);
  await restarted.tick();
  assert.equal(requests, 1);
});

test('review: new sessions group once and changed grouped sessions update only progress without repeating unchanged records', async () => {
  const state = suggestedState(); state.suggestions = [];
  const other = example({ id: 'claude:other', title: '另一项任务' }); state.records.push(other);
  state.projects = [{ id: 'project-existing', name: '现有项目' }];
  state.records[0].user.projectId = 'project-existing';
  let serviceRecords = clone(state.records), requests = [];
  const fetchImpl = async (url, options) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/v1/chat/completions') {
      const input = JSON.parse(JSON.parse(options.body).messages[1].content);
      requests.push(input.records.map(record => record.id));
      return response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ suggestions: input.records.map(record => ({
        recordId: record.id, patch: record.editableFields.length === 1 && record.editableFields[0] === 'summary' ? {summary: '模型更新近况'} : { tags: ['需求规划'] }, reason: '示例内容'
      })) }) } }] });
    }
    if (pathname === '/v1/connectors') return response({ connectors: [] });
    if (pathname === '/v1/sync') return response({ records: serviceRecords, connections: state.connections });
    throw Error('Unexpected request');
  };
  const app = await background(state, fetchImpl, { fakeTimers: true, local: {
    taskOutModel: { baseUrl: 'https://model.example/v1', model: 'example', apiKey: '', autoSuggest: true }
  } });
  await app.tick();
  assert.deepEqual(requests, [[other.id], [state.records[0].id]]);
  const otherRevision = app.disk().records.find(record => record.id === other.id).user.revision;
  assert.deepEqual(app.disk().records.find(record => record.id === other.id).user.tags, ['需求规划']);
  serviceRecords[0].summary = '产生了新近况'; serviceRecords[0].updatedAt = at(5000);
  app.advance(61000);
  await app.dispatch({ action: 'refresh' });
  await app.tick();
  assert.deepEqual(requests, [[other.id], [state.records[0].id], [state.records[0].id]]);
  assert.equal(app.disk().records[0].user.projectId, 'project-existing');
  assert.equal(app.disk().records[0].user.summaryOverride, '模型更新近况');
  assert.equal(app.disk().records.find(record => record.id === other.id).user.revision, otherRevision);
  assert.equal(app.disk().suggestions.length, 0);
});

test('review: a background tab navigation invalidates its old AI suggestion even without a new activity time', async () => {
  let tab = { id: 12, windowId: 1, title: '旧网页', url: 'https://example.com/old', lastAccessed: 1000 };
  const state = C.initial();
  const record = C.normalizeRecord({ id: 'browser:review-epoch:12', kind: 'web', connectorId: 'browser', title: tab.title, url: tab.url, updatedAt: 1000 });
  record.binding = { epoch: 'review-epoch', tabId: 12, windowId: 1, live: true };
  state.records = [record];
  const proposal = { id: 'proposal', recordId: record.id, revision: 0, contentRevision: 0, policyRevision: 0, observedUpdatedAt: 1000, patch: { tags: ['文档整理'] } };
  state.suggestions = [proposal];
  const app = await background(state, async url => response(new URL(url).pathname === '/v1/connectors' ? { connectors: [] } : { records: [], connections: [] }), {
    session: { taskOutEpoch: 'review-epoch' }, tabs: async () => [tab]
  });
  tab = { ...tab, title: '新网页', url: 'https://example.com/new' };
  await app.dispatch({ action: 'refresh' });
  const result = await app.dispatch({ action: 'ai-apply', suggestions: [proposal] });
  assert.equal(result.applied, 0);
  assert.equal(app.disk().records[0].updatedAt, 1000);
  assert.ok(app.disk().records[0].contentRevision > 0);
});
