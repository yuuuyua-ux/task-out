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
  const x = await app({initial: workspace([recent, old, unknown, child, denied, archived, detached])}); await x.tick(false);
  assert.deepEqual(x.requests.flatMap(r => r.records.map(i => i.id)), [recent.id]);
  assert.equal(x.disk().records.find(r => r.id === denied.id).user.projectId, null);
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
