'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('../extension/core.js');
const S = require('../extension/suggestions.js');
const clone = value => structuredClone(value);
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const reply = data => ({ok: true, status: 200, json: async () => clone(data)});
const modelReply = input => reply({usage: {prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_tokens_details: {cached_tokens: 0}}, choices: [{finish_reason: 'stop', message: {content: JSON.stringify({suggestions: input.records.map(item => ({recordId: item.id, evidence:{field:'title',quote:item.title}, patch: item.editableFields.length === 1 && item.editableFields[0] === 'summary' ? {summary: '模型提炼的进展'} : item.editableFields.join() === 'projectId' ? {projectId:input.projects[0].id} : {projectName: '示例项目', tags: ['需求规划']}}))})}}]});
function initialState() {
  const state = C.initial(), now = Date.now() - 1000;
  state.connections = [{id: 'fixture', historyDays: 30, allowAI: true, includeSummary: true, includeNaming: true}];
  state.records = [C.normalizeRecord({id: 'session', kind: 'session', connectorId: 'fixture', title: '原应用名称', sourceTitle: '原应用名称', summary: '源会话近况', createdAt: now, updatedAt: now,
    observations: [{connectionId: 'fixture', allowAI: true, includeSummary: true, includeNaming: true}]})];
  return state;
}
function app(options = {}) {
  let disk = clone(options.initial || initialState()), timer = null, clock = Date.now();
  const local = {taskOutModel: {baseUrl: 'https://model.example/v1', model: 'fixture', autoOrganize: true, ...options.model}, ...options.local};
  const sessionStorage = {taskOutEpoch: 'fixture-epoch'}, events = {}, requests = [], alarms = [], serviceCalls = [];
  const event = name => ({addListener(fn) {events[name] = fn;}});
  const storage = data => ({get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, clone(data[key])])), set: async patch => Object.assign(data, clone(patch)), setAccessLevel: async () => {}});
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname.endsWith('/chat/completions')) {
      const input = JSON.parse(JSON.parse(init.body).messages[1].content); requests.push(input);
      return options.complete ? options.complete(input, init, requests.length) : modelReply(input);
    }
    serviceCalls.push({url, init}); options.onService?.({url, init});
    return reply(new URL(url).pathname.endsWith('/connectors') ? {connectors: []} : {records: [], connections: disk.connections});
  };
  class Clock extends Date {static now() {return clock;}}
  const context = {console, URL, crypto, Date: Clock, structuredClone, DOMException, AbortController, AbortSignal,
    importScripts() {}, setTimeout: fn => {timer = fn; return 1;}, clearTimeout: () => {timer = null;},
    TaskOutCore: C, TaskOutModelLifetime:require('../extension/model-lifetime.js'),TaskOutSuggestions: {...S, run: args => S.run({...args, fetchImpl}), testConnection: args => S.testConnection({...args, fetchImpl})},
    TaskOutStore: {read: async () => {if (options.readGate) await options.readGate.promise; return clone(disk);}, write: async next => {disk = clone(next);}}, fetch: fetchImpl,
    chrome: {storage: {local: storage(local), session: storage(sessionStorage)}, permissions: {contains: async () => true},
      runtime: {id: 'test', getURL: file => `chrome-extension://test/${file}`, sendMessage: async () => {}, onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup')},
      tabs: {query: async () => [], onCreated: event('created'), onUpdated: event('updated'), onRemoved: event('removed'), onActivated: event('activated')},
      windows: {onFocusChanged: event('focus')}, alarms: {create: (name, details) => alarms.push({name, ...details}), clear: name => alarms.push({name, clear: true}), onAlarm: event('alarm')},
      action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}}}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('extension/background.js', 'utf8') + '\nthis.reviewAPI={ready,dispatch,enqueue,scheduleSuggestions,mutate:patch=>enqueue(()=>change(next=>{C.upsert(next,[{...next.records[0],...patch}]);}))};', context);
  const api = context.reviewAPI;
  return {ready: api.ready, call: (action, extra = {}) => api.dispatch({action, ...extra}), disk: () => clone(disk), requests, events, alarms, serviceCalls,
    mutate: api.mutate, advance: ms => {clock += ms;}, drain: () => api.enqueue(() => {}),
    tick: async () => {await api.ready; api.scheduleSuggestions(); const work = timer; timer = null; if (work) await work();}};
}

test('new sessions group once, subsequent changed source progress waits 60 seconds and never changes project or type', {timeout: 3000}, async () => {
  const x = app(); await x.ready; assert.equal(x.disk().syncSettings.intervalSeconds, 60);
  assert.equal(x.alarms[0].periodInMinutes, 1); await x.tick();
  const first = x.disk().records[0].user; assert.equal(x.requests.length, 1); assert.ok(first.projectId); assert.deepEqual(first.tags, ['需求规划']);
  await x.mutate({summary: '新的源会话证据'}); x.advance(59000); await x.tick(); assert.equal(x.requests.length, 1);
  x.advance(1000); await x.tick(); assert.equal(x.requests.length, 2);
  assert.deepEqual(Object.keys(x.requests[1]), ['records']); assert.deepEqual(x.requests[1].records[0].editableFields, ['summary']);
  assert.equal(x.requests[1].records[0].summary, '新的源会话证据');
  assert.equal(x.disk().records[0].user.projectId, first.projectId); assert.deepEqual(x.disk().records[0].user.tags, first.tags);
  x.advance(60000); await x.tick(); assert.equal(x.requests.length, 2);
  const restarted = app({initial: x.disk()}); await restarted.ready; restarted.advance(180000); await restarted.tick(); assert.equal(restarted.requests.length, 0);
  assert.deepEqual(x.disk().usage.recent.map(event => event.purpose).sort(), ['grouping', 'progress']);
});

test('manual progress refresh bypasses cadence only for changed content; explicit regrouping can repeat', {timeout: 3000}, async () => {
  const x = app(); await x.ready; await x.tick(); assert.equal(x.requests.length, 1);
  await x.call('progress-refresh'); assert.equal(x.requests.length, 1, 'unchanged manual refresh must not call model');
  await x.mutate({summary: '来源已更新，不等下一轮'}); await x.call('progress-refresh');
  assert.equal(x.requests.length, 2); assert.deepEqual(x.requests[1].records[0].editableFields, ['summary']);
  await x.call('progress-refresh'); assert.equal(x.requests.length, 2, 'repeat refresh with same source must not call model');
  await x.call('organize-now', {ids: ['session']}); assert.equal(x.requests.length, 3); assert.ok(x.requests[2].projects);
});

test('zero cadence persists and disables automatic progress, while changed manual progress remains available', {timeout: 3000}, async () => {
  const x = app(); await x.ready; await x.tick(); await x.call('sync-settings-save', {intervalSeconds: 0});
  assert.equal(x.alarms.at(-1).clear, true); await x.mutate({summary: '等待用户手动刷新'}); x.advance(180000); await x.tick(); assert.equal(x.requests.length, 1);
  const restarted = app({initial: x.disk()}); await restarted.ready; assert.equal(restarted.disk().syncSettings.intervalSeconds, 0);
  await restarted.tick(); assert.equal(restarted.requests.length, 0);
  await restarted.call('progress-refresh'); assert.equal(restarted.requests.length, 1); assert.deepEqual(restarted.requests[0].records[0].editableFields, ['summary']);
});

test('an alarm delivered before initialization completes waits for state instead of dropping the wakeup', {timeout: 3000}, async () => {
  const gate = deferred(), requested = deferred(), state = initialState();
  state.bridge = {url: 'http://127.0.0.1:4518', generation: 'fixture-generation', paired: true};
  const x = app({initial: state, readGate: gate, local: {taskOutBridge: {url: state.bridge.url, token: 'synthetic-pairing'}},
    onService: request => {if (new URL(request.url).pathname.endsWith('/sync')) requested.resolve();}});
  try {assert.doesNotThrow(() => x.events.alarm({name: 'task-out-sync'}));}
  finally {gate.resolve(); await x.ready; await x.drain();}
  await requested.promise;
  assert.deepEqual(JSON.parse(x.serviceCalls.find(request => new URL(request.url).pathname.endsWith('/sync')).init.body), {dueOnly: true});
});

test('in-flight price edits preserve request-start price and usage persistence does not deadlock the background queue', {timeout: 3000}, async () => {
  const gate = deferred(), entered = deferred();
  const x = app({complete: async input => {entered.resolve(); await gate.promise; return modelReply(input);}}); await x.ready;
  const price = {baseUrl: 'https://model.example/v1', model: 'fixture', currency: 'CNY', inputPerMillion: 2, outputPerMillion: 5, cachedInputPerMillion: 0.5};
  await x.call('pricing-save', price); const running = x.tick(); await entered.promise;
  await x.call('pricing-save', {...price, inputPerMillion: 100, outputPerMillion: 100});
  gate.resolve(); await running;
  const events = x.disk().usage.recent; assert.equal(events.length, 1); assert.equal(events[0].pricing.inputPerMillion, 2); assert.equal(events[0].cost, 0.003);
  const report = await x.call('usage-report'); assert.equal(report.report.totals.requests, 1);
  await x.mutate({summary: '发生新进展'}); await x.call('progress-refresh');
  assert.equal(x.disk().usage.recent.find(event => event.purpose === 'progress').pricing.inputPerMillion, 100);
});

test('cadence changes cancel in-flight progress, preserve project/type, and record the attempted request once', {timeout: 3000}, async () => {
  const entered = deferred(), gate = deferred();
  const x = app({complete: async (input, _init, count) => {if (count > 1) {entered.resolve(); await gate.promise;} return modelReply(input);}});
  await x.ready; await x.tick(); const before = x.disk().records[0].user;
  await x.mutate({summary: '待刷新进展'}); x.advance(61000); const running = x.tick(); await entered.promise;
  await x.call('sync-settings-save', {intervalSeconds: 0}); gate.resolve(); await running;
  assert.deepEqual(x.disk().records[0].user, before);
  const cancelled = x.disk().usage.recent.filter(event => event.status === 'cancelled'); assert.equal(cancelled.length, 1); assert.equal(cancelled[0].purpose, 'progress');
  assert.equal(x.disk().usage.recent.length, 2); await x.tick(); assert.equal(x.requests.length, 2);
});
