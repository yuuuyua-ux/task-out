const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('../extension/core.js');
const S = require('../extension/suggestions.js');
const NOW = Date.now() - 1000;
const DAY = 86400000;
const clone = value => structuredClone(value);
const response = data => ({ok: true, status: 200, json: async () => clone(data)});
const deferred = () => { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve}; };
function session(id, extra = {}) {
  return C.normalizeRecord({id, connectorId: 'fixture', kind: 'session', title: `来源名称 ${id}`, createdAt: NOW - 40 * DAY, updatedAt: NOW,
    observations: [{connectionId: 'fixture-connection', allowAI: true, includeSummary: true, includeNaming: true}], ...extra});
}
function workspace(records = []) {
  const state = C.initial(); state.records = records;
  state.connections = [{id: 'fixture-connection', historyDays: 30, allowAI: true, includeSummary: true, includeNaming: true}];
  return state;
}
const completion = (records, patch = {}) => response({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({suggestions: records.map(item => ({recordId: item.id,
  patch: item.editableFields?.length === 1 && item.editableFields[0] === 'summary' ? {summary:'新的进展摘要', ...patch} : {projectName: '示例项目', tags: ['需求规划'], ...(item.namingContext ? {sessionName: '固定生成名称'} : {}), ...patch}}))})}}]});
async function app(options = {}) {
  let disk = clone(options.initial || workspace()), timer = null, clock = Date.now();
  const model = {baseUrl: 'https://model.example/v1', model: 'fixture', apiKey: '', autoSuggest: false, ...(options.model || {})};
  const local = {taskOutModel: model, ...(options.local || {})}, sessionStorage = {taskOutEpoch: 'fixture-epoch'};
  const tabs = options.tabs || [];
  const events = {}, requests = [];
  const event = name => ({addListener(fn) {events[name] = fn;}});
  const storage = data => ({get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, clone(data[k])])), set: async patch => Object.assign(data, clone(patch)), setAccessLevel: async () => {}});
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname.endsWith('/chat/completions')) {
      const input = JSON.parse(JSON.parse(init.body).messages[1].content); requests.push(input);
      return options.complete ? options.complete(input, init) : completion(input.records);
    }
    return options.service ? options.service(url, init) : response(new URL(url).pathname.endsWith('/connectors') ? {connectors: []} : {records: [], connections: disk.connections});
  };
  class Clock extends Date { static now() {return clock;} }
  const context = {console, URL, crypto, Date: Clock, structuredClone, DOMException, AbortController, AbortSignal,
    importScripts() {}, setTimeout: fn => {timer = fn; return 1;}, clearTimeout: () => {timer = null;},
    TaskOutCore: C, TaskOutSuggestions: {...S, run: args => S.run({...args, fetchImpl}), testConnection: args => S.testConnection({...args, fetchImpl})},
    TaskOutStore: {read: async () => clone(disk), write: async next => {disk = clone(next);}}, fetch: fetchImpl,
    chrome: {storage: {local: storage(local), session: storage(sessionStorage)}, permissions: {contains: async () => true},
      runtime: {id: 'test', getURL: file => `chrome-extension://test/${file}`, sendMessage: async () => {}, onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup')},
      tabs: {query: async () => tabs, onCreated: event('created'), onUpdated: event('updated'), onRemoved: event('removed'), onActivated: event('activated')},
      windows: {onFocusChanged: event('focus')}, alarms: {create() {}, onAlarm: event('alarm')}, action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}}}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('extension/background.js', 'utf8') + '\nthis.testAPI={dispatch,ready,scheduleSuggestions,enqueue};', context);
  await context.testAPI.ready; await Promise.resolve();
  return {call: (action, extra = {}) => context.testAPI.dispatch({action, ...extra}), disk: () => clone(disk), local: () => clone(local), requests, events, tabs,
    tick: async (schedule = true) => {if (schedule) context.testAPI.scheduleSuggestions(); const work = timer; timer = null; if (work) await work();},
    pending: () => !!timer, advance: amount => {clock += amount;}, drain: () => context.testAPI.enqueue(() => {})};
}

test('automatic organization defaults on, applies and remains stable through unrelated groups, recency and worker restarts', async () => {
  const record = session('old-created-recently-active');
  const tabs = [{id: 1, windowId: 1, title: '网页原名', url: 'https://example.test/page', lastAccessed: NOW - 90 * DAY}];
  const x = await app({initial: workspace([record]), tabs});
  await x.tick(false);
  assert.equal(x.requests.length, 1); assert.equal(x.requests[0].records.length, 2);
  assert.equal(x.disk().records.every(r => r.user.projectId), true); assert.equal(x.disk().suggestions.length, 0);
  assert.equal((await x.call('snapshot')).state.organization.lastApplied, 2);
  assert.equal((await x.call('snapshot')).state.model.autoOrganize, true);
  await x.call('project-save', {name: '无关项目'});
  tabs[0].lastAccessed = NOW + 500; await x.call('refresh'); await x.tick();
  assert.equal(x.requests.length, 1);
  const restarted = await app({initial: x.disk(), local: x.local(), tabs}); await restarted.tick(false);
  assert.equal(restarted.requests.length, 0);
});

test('automatic scope uses recent activity, live browser identity and strict source consent', async () => {
  const recent = session('old-created-new-update'), old = session('created-today-old-update', {createdAt: NOW, updatedAt: NOW - 5 * DAY});
  const unknown = session('unknown-update', {createdAt: NOW, updatedAt: null}), child = session('child', {parentId: recent.id});
  const denied = session('denied', {observations: [{connectionId: 'restricted', allowAI: false}]}), archived = session('archived'); archived.user.archived = true;
  const detached = C.normalizeRecord({id: 'detached', kind: 'web', connectorId: 'browser', title: '离线网页', url: 'https://example.test/detached'});
  const state = workspace([recent, old, unknown, child, denied, archived, detached]); state.connections[0].historyDays = 3;
  const x = await app({initial: state}); await x.tick(false);
  assert.deepEqual(x.requests.flatMap(r => r.records.map(i => i.id)), [recent.id]);
  assert.equal(x.disk().records.find(r => r.id === denied.id).user.projectId, null);
});

test('automatic local grouping follows each configured activity window, independent of creation time', async () => {
  for (const [days, expected] of [[3, ['recent']], [7, ['recent', 'six-days']], [30, ['recent', 'six-days', 'twenty-days']]]) {
    const state = workspace([
      session('recent'), session('six-days', {createdAt: NOW, updatedAt: NOW - 6 * DAY}),
      session('twenty-days', {updatedAt: NOW - 20 * DAY}), session('expired', {updatedAt: NOW - 31 * DAY}),
      session('unknown-time', {updatedAt: null}), session('future', {updatedAt: NOW + DAY}),
    ]);
    state.connections[0].historyDays = days;
    const x = await app({initial: state}); await x.tick(false);
    assert.deepEqual(x.requests.flatMap(request => request.records.map(record => record.id)), expected);
    assert.equal(x.disk().records.filter(record => record.user.projectId).length, expected.length);
    await x.tick(); assert.equal(x.requests.length, 1, 'unchanged records are not regrouped');
  }
});

test('restored older ungrouped sessions are classified once while grouped sessions retain project type and fixed name', async () => {
  const pending = session('restored-pending', {updatedAt: NOW - 20 * DAY}); pending.user.archived = true;
  const grouped = session('restored-grouped', {updatedAt: NOW - 20 * DAY, summary: '来源提供的新进展'}); grouped.user.archived = true;
  const state = workspace([pending, grouped]);
  const project = C.saveProject(state, {name: '保留的项目'});
  Object.assign(grouped.user, {projectId: project.id, tags: ['方案设计'], sessionName: '保留的固定名称'});
  const x = await app({initial: state}); await x.tick(false); assert.equal(x.requests.length, 0);
  await x.call('restore', {ids: [pending.id, grouped.id]}); await x.tick();
  assert.equal(x.requests.length, 2);
  assert.deepEqual(x.requests[0].records.map(record => record.id), [pending.id]);
  assert.deepEqual(x.requests[1].records[0].editableFields, ['summary']);
  const updated = x.disk().records.find(record => record.id === grouped.id);
  assert.equal(updated.user.projectId, project.id); assert.deepEqual(updated.user.tags, ['方案设计']);
  assert.equal(updated.user.sessionName, '保留的固定名称');
  const restarted = await app({initial: x.disk(), local: x.local()}); await restarted.tick(false);
  assert.equal(restarted.requests.length, 0);
});

test('wide shared-source windows retain strict model permissions and manual unassigned choices', async () => {
  const observations = [{connectionId: 'narrow', allowAI: true, includeSummary: true}, {connectionId: 'wide', allowAI: true, includeSummary: true}];
  const allowed = session('shared-allowed', {updatedAt: NOW - 20 * DAY, observations});
  const denied = session('shared-denied', {updatedAt: NOW - 20 * DAY, observations: [observations[0], {...observations[1], allowAI: false}]});
  const manual = session('manual-unassigned', {updatedAt: NOW - 20 * DAY}); manual.user.manual.projectId = true;
  const state = workspace([allowed, denied, manual]);
  state.connections.push({id: 'narrow', historyDays: 3}, {id: 'wide', historyDays: 30});
  const x = await app({initial: state}); await x.tick(false);
  assert.deepEqual(x.requests[0].records.map(record => record.id), [allowed.id]);
  assert.deepEqual(x.requests[1].records.map(record => record.id), [manual.id]);
  assert.deepEqual(x.requests[1].records[0].editableFields, ['summary']);
  assert.equal(x.disk().records.find(record => record.id === manual.id).user.projectId, null);
  assert.equal(x.disk().records.find(record => record.id === denied.id).user.projectId, null);
});

test('imported sessions without a source window do not silently expand automatic history', async () => {
  const records = C.importRecords('synthetic-sessions', JSON.stringify([
    {id: 'recent', kind: 'session', title: '最近导入的会话', updatedAt: NOW, allowAI: true},
    {id: 'older', kind: 'session', title: '较早导入的会话', updatedAt: NOW - 20 * DAY, allowAI: true},
  ])).records;
  const x = await app({initial: workspace(records)}); await x.tick(false);
  assert.deepEqual(x.requests.flatMap(request => request.records.map(record => record.id)), [records[0].id]);
  await x.call('organize-now', {ids: [records[1].id]});
  assert.ok(x.disk().records.every(record => record.user.projectId));
});

test('automatic startup waits for repaired local naming facts instead of fixing a wrapper as a permanent name', async () => {
  const polluted = session('waiting-for-cleanup', {namingVersion: 2, sourceTitle: '', titleBasis: 'first-message',
    title: '<current_user_request>比较虚构方案</current_user_request>',
    firstMessage: '<current_user_request>比较虚构方案</current_user_request>', latestMessage: '已完成虚构对比', updatedAt: NOW - 20 * DAY});
  const state = workspace([polluted]);
  const x = await app({initial: state, tabs: [{id: 1, windowId: 1, title: '示例网页', url: 'https://example.test/cleanup', lastAccessed: NOW}]});
  await x.tick(false);
  assert.equal(x.requests.length, 1); assert.ok(x.requests[0].records.every(record => record.kind === 'web'));
  assert.equal(x.disk().records.find(record => record.id === polluted.id).user.sessionName, '');
  const repaired = x.disk(), previousRevision = repaired.records.find(record => record.id === polluted.id).contentRevision;
  C.upsert(repaired, [{...polluted, namingVersion: 3, title: '比较虚构方案', firstMessage: '比较虚构方案'}]);
  const current = repaired.records.find(record => record.id === polluted.id);
  assert.equal(current.updatedAt, polluted.updatedAt); assert.ok(current.contentRevision > previousRevision);
  const restarted = await app({initial: repaired, local: x.local()}); await restarted.tick(false);
  assert.equal(restarted.requests.length, 1);
  assert.equal(restarted.requests[0].records[0].namingContext.firstMessage, '比较虚构方案');
  assert.equal(restarted.disk().records.find(record => record.id === polluted.id).user.sessionName, '固定生成名称');
});

test('missing-name sessions commit in small batches and retry only unfinished grouping after a later failure', async () => {
  const records = Array.from({length: 12}, (_, index) => session(`batch-${index}`, {namingVersion: 3,
    sourceTitle: '', titleBasis: 'first-message', firstMessage: '设计虚构产品', latestMessage: '补充虚构方案', updatedAt: NOW - 20 * DAY}));
  let requests = 0;
  const x = await app({initial: workspace(records), complete: input => {
    if (++requests === 2) return {ok: false, status: 503};
    return completion(input.records);
  }});
  await x.tick(false);
  assert.deepEqual(x.requests.map(input => input.records.length), [5, 5]);
  const saved = x.disk().records.filter(record => record.user.projectId);
  assert.equal(saved.length, 5); assert.ok(saved.every(record => record.user.sessionName === '固定生成名称'));
  assert.equal((await x.call('snapshot')).state.organization.status, 'error');
  x.advance(31000); await x.tick();
  assert.deepEqual(x.requests.map(input => input.records.length), [5, 5, 5, 2]);
  assert.ok(x.disk().records.every(record => record.user.projectId && record.user.sessionName));
  assert.ok(x.requests.slice(2).every(input => input.records.every(record => !saved.some(prior => prior.id === record.id))));
  for (const prior of saved) assert.deepEqual(x.disk().records.find(record => record.id === prior.id).user, prior.user);
});

test('explicit opt-out survives empty settings saves and restart; organize-now still applies', async () => {
  const x = await app({initial: workspace([session('manual')]), model: {autoOrganize: false, autoSuggest: true}});
  await x.tick(false); assert.equal(x.requests.length, 0);
  await x.call('model-save', {baseUrl: '', model: '', rules: '', apiKey: ''});
  assert.equal(x.local().taskOutModel.autoOrganize, false);
  const restarted = await app({initial: x.disk(), local: x.local()}); await restarted.tick(false);
  assert.equal((await restarted.call('snapshot')).state.organization.status, 'paused');
  const result = await restarted.call('organize-now', {ids: ['manual']});
  assert.equal(result.applied, 1); assert.equal(restarted.requests.length, 1); assert.ok(restarted.disk().records[0].user.projectId);
});

test('undo suppresses reapplication until actual source content changes or the user explicitly organizes', async () => {
  const x = await app({initial: workspace([session('undo')])}); await x.tick(false);
  await x.call('undo'); assert.equal(x.disk().records[0].user.projectId, null);
  await x.tick(); assert.equal(x.requests.length, 1);
  const restarted = await app({initial: x.disk(), local: x.local()}); await restarted.tick(false); assert.equal(restarted.requests.length, 0);
  assert.equal((await restarted.call('organize-now', {ids: ['undo']})).applied, 1);
});

test('more than 100 records continue in later batches without starving the tail or repeating the head', async () => {
  const x = await app({initial: workspace(Array.from({length: 205}, (_, n) => session(`batch-${n}`)))});
  let ticks = 0; while (x.pending()) {await x.tick(false); assert.ok(++ticks < 5);}
  assert.equal(x.disk().records.filter(r => r.user.projectId).length, 205);
  const ids = x.requests.flatMap(r => r.records.map(i => i.id)); assert.equal(ids.length, 205); assert.equal(new Set(ids).size, 205);
  await x.tick(); assert.equal(x.requests.flatMap(r => r.records).length, 205);
});

test('old preview suggestions cannot block default organization and applied records clear their old preview', async () => {
  const state = workspace([session('old-preview')]);
  state.suggestions = [{id: 'old-pending', recordId: 'old-preview', revision: 0, observedUpdatedAt: state.records[0].updatedAt, patch: {tags: ['文档整理']}}];
  const x = await app({initial: state}); await x.tick(false);
  assert.equal(x.requests.length, 1); assert.deepEqual(x.disk().records[0].user.tags, ['需求规划']); assert.equal(x.disk().suggestions.length, 0);
});

test('missing generated names are visible errors with backoff, not successful handled inputs', async () => {
  const record = session('unnamed', {title: '临时第一条', sourceTitle: '', titleBasis: 'first-message', firstMessage: '比较方案', latestMessage: '已整理对比'});
  const x = await app({initial: workspace([record]), complete: input => completion(input.records, {sessionName: undefined})});
  await x.tick(false); assert.equal((await x.call('snapshot')).state.organization.status, 'error');
  assert.equal(x.disk().records[0].user.sessionName, ''); assert.equal(x.disk().organizationAttempts[record.id], undefined);
  await x.tick(); assert.equal(x.requests.length, 1);
  x.advance(31000); await x.tick(); assert.equal(x.requests.length, 2);
});

test('automatic generated names remain fixed and are not sent for naming again after source updates', async () => {
  const record = session('unnamed', {sourceTitle: '', titleBasis: 'first-message', firstMessage: '比较方案', latestMessage: '已整理对比'});
  const x = await app({initial: workspace([record])}); await x.tick(false);
  assert.equal(x.disk().records[0].user.sessionName, '固定生成名称');
  const next = x.disk(); C.upsert(next, [{...record, latestMessage: '新的进度', summary: '后续总结', updatedAt: NOW + 1}]);
  const restarted = await app({initial: next, local: x.local()}); restarted.advance(61000); await restarted.tick(false);
  assert.equal(restarted.requests[0].records[0].namingContext, undefined);
  assert.equal(restarted.disk().records[0].user.sessionName, '固定生成名称');
});

test('manual changes during a request block stale automatic application', async () => {
  const gate = deferred(), started = deferred();
  const x = await app({initial: workspace([session('racing')]), complete: async input => {started.resolve(); await gate.promise; return completion(input.records);}});
  const running = x.tick(false); await started.promise;
  const p = await x.call('project-save', {name: '用户决定'}); await x.call('record-edit', {id: 'racing', patch: {projectId: p.project.id, tags: ['使用咨询']}});
  gate.resolve(); await running;
  assert.equal(x.disk().records[0].user.projectId, p.project.id); assert.deepEqual(x.disk().records[0].user.tags, ['使用咨询']);
});

test('turning off automatic organization or changing model cancels an in-flight result', async () => {
  for (const patch of [{autoOrganize: false}, {model: 'changed-model'}]) {
    const gate = deferred(), started = deferred();
    const x = await app({initial: workspace([session('racing')]), complete: async input => {started.resolve(); await gate.promise; return completion(input.records);}});
    const running = x.tick(false); await started.promise;
    await x.call('model-save', patch); gate.resolve(); await running;
    assert.equal(x.disk().records[0].user.projectId, null); assert.equal(x.disk().undo.length, 0);
    if (patch.autoOrganize === false) assert.equal((await x.call('snapshot')).state.organization.status, 'paused');
  }
});

test('revoking source consent cancels an in-flight automatic result', async () => {
  const gate = deferred(), started = deferred();
  const restricted = {id: 'fixture-connection', historyDays: 30, allowAI: false, includeSummary: false, includeNaming: false};
  const x = await app({initial: workspace([session('racing')]), local: {taskOutBridge: {url: 'http://127.0.0.1:4518', token: 'fixture'}},
    complete: async input => {started.resolve(); await gate.promise; return completion(input.records);},
    service: async url => response(new URL(url).pathname.endsWith('/connectors') ? {connectors: []} : {connections: [restricted]})});
  const running = x.tick(false); await started.promise;
  await x.call('service', {method: 'PATCH', path: '/v1/connections/fixture-connection', body: {allowAI: false}});
  gate.resolve(); await running;
  assert.equal(x.disk().records[0].user.projectId, null); assert.equal(x.disk().records[0].observations[0].allowAI, false);
});

test('a recency-only in-flight conflict stays eligible for a later automatic retry', async () => {
  const gate = deferred(), started = deferred();
  const tabs = [{id: 2, windowId: 1, title: '同一网页', url: 'https://example.test/same', lastAccessed: NOW}];
  const x = await app({tabs, complete: async input => {started.resolve(); await gate.promise; return completion(input.records);}});
  const running = x.tick(false); await started.promise;
  tabs[0].lastAccessed = NOW + 100; await x.call('refresh'); gate.resolve(); await running;
  const record = x.disk().records[0];
  assert.equal(record.user.projectId, null); assert.equal(x.disk().organizationAttempts[record.id], undefined);
  assert.match((await x.call('snapshot')).state.organization.message, /变化/);
  await x.tick(false);
  assert.equal(x.requests.length, 2); assert.ok(x.disk().records[0].user.projectId);
});

test('manual organize-now includes explicitly authorized imported webpages without treating detached browser records as live', async () => {
  const imported = C.importRecords('fixture-import', JSON.stringify([{id: 'page', kind: 'web', title: '导入网页', url: 'https://example.test/imported', allowAI: true}])).records[0];
  const detached = C.normalizeRecord({id: 'detached-browser', connectorId: 'browser', kind: 'web', title: '待关联网页', url: 'https://example.test/detached'});
  const x = await app({initial: workspace([imported, detached])}); await x.tick(false);
  assert.equal(x.requests.length, 0);
  const result = await x.call('organize-now', {ids: [imported.id, detached.id]});
  assert.equal(result.applied, 1); assert.deepEqual(x.requests[0].records.map(r => r.id), [imported.id]);
  assert.equal(x.disk().records.find(r => r.id === detached.id).user.projectId, null);
});

test('usage persists each real request across grouping, progress, naming and model-test without exposing content or credentials', async () => {
  const state = workspace([session('usage', {summary: '初始近况'})]);
  C.saveModelPricing(state, {baseUrl:'https://model.example/v1',model:'fixture',currency:'CNY',inputPerMillion:2,outputPerMillion:5,cachedInputPerMillion:1});
  const respond = async input => {
    const body = await completion(input.records).json();
    body.usage = {prompt_tokens:1000,completion_tokens:200,total_tokens:1200,prompt_tokens_details:{cached_tokens:400}};
    if (input.records.every(r => r.editableFields.length === 1 && r.editableFields[0] === 'sessionName'))
      body.choices[0].message.content = JSON.stringify({suggestions:input.records.map(r=>({recordId:r.id,patch:{sessionName:'固定生成名称'}}))});
    return response(body);
  };
  const x = await app({initial:state,complete:respond,model:{apiKey:'secret-fixture'}}); await x.tick(false);
  assert.equal(x.disk().usage.recent[0].purpose,'grouping');
  const next=x.disk(); C.upsert(next,[session('usage',{summary:'更新近况',updatedAt:NOW+1})]);
  const unnamed=session('naming',{sourceTitle:'',titleBasis:'first-message',firstMessage:'FIRST_PRIVATE_FIXTURE',latestMessage:'LATEST_PRIVATE_FIXTURE'});
  next.records.push(unnamed);
  const y=await app({initial:next,local:x.local(),complete:respond});
  await y.call('progress-refresh');
  await y.call('name-preview',{ids:['naming']});
  await y.call('model-test');
  const report=(await y.call('usage-report',{days:30})).report;
  assert.equal(report.totals.requests,4);assert.equal(report.totals.totalTokens,4800);
  assert.ok(Math.abs(report.totals.estimatedCosts.CNY-0.0104)<1e-9);
  assert.deepEqual(report.recent.map(e=>e.purpose).sort(),['grouping','naming','progress','test']);
  assert.equal(report.recent.find(e=>e.purpose==='grouping').trigger,'automatic');
  assert.equal(report.recent.find(e=>e.purpose==='test').trigger,'manual');
  assert.doesNotMatch(JSON.stringify(report),/secret-fixture|FIRST_PRIVATE_FIXTURE|LATEST_PRIVATE_FIXTURE|初始近况/);
  const restarted=await app({initial:y.disk(),local:y.local()});
  assert.equal((await restarted.call('usage-report',{days:30})).report.totals.requests,4);
});

test('invalid model output still records charged usage and preserves existing organization', async () => {
  const x=await app({initial:workspace([session('invalid')]),complete:async()=>response({usage:{prompt_tokens:22,completion_tokens:11,total_tokens:33},choices:[{message:{content:'not valid JSON'}}]})});
  await x.tick(false);
  const report=(await x.call('usage-report',{days:1})).report;
  assert.equal(report.totals.requests,1);assert.equal(report.totals.totalTokens,33);assert.equal(report.totals.unpricedRequests,1);
  assert.equal(x.disk().records[0].user.projectId,null);assert.equal(x.disk().organization.status,'error');
});

test('prices preserve blank fields and zero rates, and in-flight calls retain their starting price', async () => {
  const start=deferred(),gate=deferred();
  const x=await app({initial:workspace([session('price')]),model:{autoOrganize:false},complete:async input=>{start.resolve();await gate.promise;const body=await completion(input.records).json();return response({...body,usage:{prompt_tokens:1000000,completion_tokens:200000,total_tokens:1200000,prompt_tokens_details:{cached_tokens:0}}});}});
  const identity={baseUrl:'https://model.example/v1',model:'fixture'};
  await x.call('pricing-save',{...identity,inputPerMillion:'2',outputPerMillion:'5',cachedInputPerMillion:'1',currency:'USD'});
  const running=x.call('organize-now',{ids:['price']});await start.promise;
  await x.call('pricing-save',{...identity,inputPerMillion:'0',outputPerMillion:' ',cachedInputPerMillion:'',currency:'USD'});
  gate.resolve();await running;
  const report=(await x.call('usage-report',{days:1})).report;
  assert.equal(report.pricing[0].inputPerMillion,0);assert.equal(report.pricing[0].outputPerMillion,5);assert.equal(report.pricing[0].cachedInputPerMillion,1);
  assert.equal(report.totals.estimatedCosts.USD,3);assert.equal(report.recent[0].pricing.inputPerMillion,2);
  await x.call('organize-now',{ids:['price']});
  assert.equal((await x.call('usage-report',{days:1})).report.totals.estimatedCosts.USD,4);
});

test('adding a price during an unpriced in-flight request does not invent a historical estimate', async () => {
  const start=deferred(),gate=deferred();
  const x=await app({initial:workspace([session('unpriced')]),model:{autoOrganize:false},complete:async input=>{start.resolve();await gate.promise;const body=await completion(input.records).json();return response({...body,usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}});}});
  const running=x.call('organize-now',{ids:['unpriced']});await start.promise;
  await x.call('pricing-save',{baseUrl:'https://model.example/v1',model:'fixture',inputPerMillion:2,outputPerMillion:5});
  gate.resolve();await running;
  const report=(await x.call('usage-report',{days:1})).report;
  assert.equal(report.totals.unpricedRequests,1);assert.deepEqual(report.totals.estimatedCosts,{});
});

function groupedWorkspace(count) {
  const state = workspace();
  for (let index = 0; index < count; index++) {
    const record = session(`quota-${index}`, {summary: ''}); record.observations[0].includeSummary = false;
    record.user.projectId = C.saveProject(state, {name: `虚构原分组${index}`}).id;
    record.user.tags = ['方案设计']; record.user.sessionName = `已有固定名称${index}`;
    state.records.push(record);
  }
  return state;
}
const projectOnlyReply = input => response({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({suggestions:
  input.records.map(record => ({recordId: record.id, patch: {projectId: input.projects[0].id}}))})}}]});

test('group limit defaults to five, blank saves preserve it and paused automation never merges', async () => {
  const x = await app({initial: groupedWorkspace(7), model: {autoOrganize: false}});
  assert.equal((await x.call('snapshot')).state.model.maxGroups, 5);
  await x.call('model-save', {maxGroups: 8}); await x.tick(false);
  assert.equal(x.requests.length, 0); assert.equal(x.disk().groupSettings.maxGroups, 8);
  for (const value of ['', '   ', null]) await x.call('model-save', {maxGroups: value});
  assert.equal(x.local().taskOutModel.maxGroups, 8);
  for (const value of [0, 51, 1.5, true, 'invalid']) await assert.rejects(() => x.call('model-save', {maxGroups: value}), /1 到 50/);
  assert.equal(x.local().taskOutModel.maxGroups, 8);
  const restarted = await app({initial: x.disk(), local: x.local()}); await restarted.tick(false);
  assert.equal(restarted.disk().groupSettings.maxGroups, 8); assert.equal(restarted.requests.length, 0);
});

test('upgraded automatic grouping merges excess groups without changing fixed names types or protected memberships', async () => {
  const state = groupedWorkspace(7);
  state.records[5].user.manual.projectId = true; state.records[6].observations[0].allowAI = false;
  const before = C.copy(state.records.map(record => record.user));
  const x = await app({initial: state, complete: projectOnlyReply}); await x.tick(false);
  assert.equal(C.groupingPlan(x.disk()).groups.length, 5, JSON.stringify(x.disk().organization)); assert.equal(x.requests.length, 1);
  assert.ok(x.requests[0].records.every(record => JSON.stringify(record.editableFields) === '["projectId"]'));
  assert.deepEqual(x.disk().records[5].user, before[5]); assert.deepEqual(x.disk().records[6].user, before[6]);
  x.disk().records.forEach((record, index) => {assert.deepEqual(record.user.tags, before[index].tags); assert.equal(record.user.sessionName, before[index].sessionName);});
  await x.tick(); assert.equal(x.requests.length, 1);
  await x.call('undo'); assert.equal(C.groupingPlan(x.disk()).groups.length, 7);
  await x.tick(); assert.equal(x.requests.length, 1, 'undo is not silently reversed by the next automatic tick');
  const restarted = await app({initial: x.disk(), local: x.local(), complete: projectOnlyReply}); await restarted.tick(false);
  assert.equal(restarted.requests.length, 0);
  await restarted.call('organize-now', {ids: restarted.disk().records.filter(record => C.groupMovable(record)).map(record => record.id)}); assert.ok(C.groupingPlan(restarted.disk()).groups.length <= 5);
});

test('protected groups exceeding the limit report a fix while saving the preference without moving them', async () => {
  const state = groupedWorkspace(6); state.records.forEach(record => {record.user.manual.projectId = true;});
  const x = await app({initial: state}); const before = C.copy(x.disk().records.map(record => record.user));
  await x.call('model-save', {maxGroups: 5}); await x.tick(false);
  assert.equal(x.requests.length, 0); assert.equal(x.disk().organization.code, 'GROUP_LIMIT_PROTECTED');
  assert.equal(x.local().taskOutModel.maxGroups, 5); assert.deepEqual(x.disk().records.map(record => record.user), before);
});

test('new-content batches receive freshly occupied groups and never repeat an already saved batch after quota failure', async () => {
  const state = workspace(Array.from({length: 40}, (_, index) => session(`new-quota-${index}`, {summary: ''})));
  let rejectExtra = true;
  const x = await app({initial: state, complete: input => {
    if (!input.projects.length) return response({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({suggestions:
      input.records.map((record, index) => ({recordId: record.id, patch: {projectName: `允许组${index % 5}`}}))})}}]});
    if (rejectExtra) return completion(input.records, {projectName: '超限新组'});
    return projectOnlyReply(input);
  }});
  await x.tick(false);
  assert.equal(C.groupingPlan(x.disk()).groups.length, 5);
  const saved = x.disk().records.filter(record => record.user.projectId); assert.equal(saved.length, 20);
  assert.ok(x.requests.slice(1).every(input => input.projects.length === 5));
  assert.equal(x.disk().organization.status, 'error');
  const priorCalls = x.requests.length; rejectExtra = false; x.advance(31000); await x.tick();
  assert.equal(x.disk().records.filter(record => record.user.projectId).length, 40); assert.equal(C.groupingPlan(x.disk()).groups.length, 5);
  assert.ok(x.requests.slice(priorCalls).every(input => input.records.every(record => !saved.some(prior => prior.id === record.id))));
  for (const prior of saved) assert.deepEqual(x.disk().records.find(record => record.id === prior.id).user, prior.user);
});

test('manual group consolidation touches only selected records and reports excess groups outside that selection', async () => {
  const state = groupedWorkspace(7), chosen = state.records[5], outside = state.records[6];
  const x = await app({initial: state, model: {autoOrganize: false}, complete: projectOnlyReply});
  const before = C.copy(x.disk().records.map(record => record.user));
  const result = await x.call('organize-now', {ids: [chosen.id]});
  assert.equal(C.groupingPlan(x.disk()).groups.length, 6);
  assert.match(result.message, /6 个在用分组.*扩大筛选范围/);
  assert.ok(x.requests.every(input => input.records.every(record => record.id === chosen.id)));
  assert.equal(x.requests.length, 1, 'merged selections must not be sent again through ordinary type/name editing');
  assert.deepEqual(x.disk().records.find(record => record.id === outside.id).user, before[6]);
  x.disk().records.forEach((record, index) => {
    if (record.id !== chosen.id) assert.deepEqual(record.user, before[index]);
    assert.deepEqual(record.user.tags, before[index].tags); assert.equal(record.user.sessionName, before[index].sessionName);
  });
});

test('manual consolidation completes more than 100 selected overflow records with bounded batches', async () => {
  const state = groupedWorkspace(108), plan = C.groupingPlan(state);
  const x = await app({initial: state, model: {autoOrganize: false}, complete: projectOnlyReply});
  const result = await x.call('organize-now', {ids: plan.mergeIds});
  assert.equal(result.applied, 103); assert.equal(C.groupingPlan(x.disk()).groups.length, 5);
  assert.deepEqual(x.requests.map(input => input.records.length), [...Array(20).fill(5), 3]);
  const ids = x.requests.flatMap(input => input.records.map(record => record.id)); assert.equal(new Set(ids).size, 103);
});

test('manual changes or revoking consent during consolidation preserve their current membership', async () => {
  for (const revoke of [false, true]) {
    const state = groupedWorkspace(6), record = state.records[5], gate = deferred(), started = deferred();
    const x = await app({initial: state, local: {taskOutBridge: {url: 'http://127.0.0.1:4518', token: 'fixture'}},
      complete: async input => {started.resolve(); await gate.promise; return projectOnlyReply(input);},
      service: async url => response(new URL(url).pathname.endsWith('/connectors') ? {connectors: []} : {connections: [{...state.connections[0], allowAI: false, includeSummary: false, includeNaming: false}]})});
    const running = x.tick(false); await started.promise;
    if (revoke) await x.call('service', {method: 'PATCH', path: '/v1/connections/fixture-connection', body: {allowAI: false}});
    else await x.call('record-edit', {id: record.id, patch: {projectId: record.user.projectId}});
    gate.resolve(); await running;
    assert.equal(x.disk().records.find(item => item.id === record.id).user.projectId, record.user.projectId);
    if (revoke) {
      assert.equal(x.requests.length, 1); assert.ok(x.disk().undo.every(entry => entry.label !== '合并分组'));
    } else {
      assert.equal(x.disk().records.find(item => item.id === record.id).user.manual.projectId, true);
      assert.ok(x.requests.slice(1).every(input => input.records.every(item => item.id !== record.id)));
    }
  }
});

test('group consolidation saves each five-record transaction and retries only unfinished groups after the next batch fails', async () => {
  const state = groupedWorkspace(17), original = new Map(state.records.map(record => [record.id, record.user.projectId]));
  let count = 0;
  const x = await app({initial: state, complete: input => ++count === 2 ? {ok: false, status: 503} : projectOnlyReply(input)});
  await x.tick(false);
  assert.deepEqual(x.requests.map(input => input.records.length), [5, 5]);
  const saved = x.disk().records.filter(record => record.user.projectId !== original.get(record.id));
  assert.equal(saved.length, 5); assert.equal(C.groupingPlan(x.disk()).groups.length, 12);
  assert.equal(x.disk().organization.status, 'error');
  x.advance(31000); await x.tick();
  assert.deepEqual(x.requests.map(input => input.records.length), [5, 5, 5, 2]);
  assert.equal(C.groupingPlan(x.disk()).groups.length, 5);
  assert.ok(x.requests.slice(2).every(input => input.records.every(record => !saved.some(prior => prior.id === record.id))));
  for (const prior of saved) assert.deepEqual(x.disk().records.find(record => record.id === prior.id).user, prior.user);
});
