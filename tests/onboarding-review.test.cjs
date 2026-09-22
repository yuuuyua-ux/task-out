'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('../extension/core.js');
const S = require('../extension/suggestions.js');
const clone = value => structuredClone(value);
const response = (body, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => clone(body)});
const ORIGIN = 'chrome-extension://' + 'a'.repeat(32);
async function app(options = {}) {
  let disk = clone(options.initial || C.initial());
  const local = {taskOutModel: {autoOrganize: false}, ...clone(options.local || {})}, session = {}, requests = [];
  const handlers = {}, event = name => ({addListener: fn => {handlers[name] = fn;}});
  const storage = data => ({get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, clone(data[key])])),
    set: async patch => Object.assign(data, clone(patch)), setAccessLevel: async () => {}});
  const context = {console, URL, crypto, structuredClone, DOMException, AbortController, AbortSignal: options.abortSignal || AbortSignal, importScripts() {}, setTimeout: () => 1, clearTimeout() {},
    TaskOutCore: C, TaskOutModelLifetime:require('../extension/model-lifetime.js'),TaskOutSuggestions: S, TaskOutStore: {read: async () => clone(disk), write: async value => {disk = clone(value);}},
    fetch: async (url, init) => {requests.push({url, init}); return options.fetch ? options.fetch(url, init) : response({});},
    chrome: {storage: {local: storage(local), session: storage(session)}, permissions: {contains: async () => true},
      runtime: {id: 'a'.repeat(32), getURL: file => ORIGIN + '/' + file, sendMessage: async () => {}, onMessage: event('message'), onStartup: event('startup'), onInstalled: event('installed')},
      tabs: {query: async () => [], onCreated: event('created'), onUpdated: event('updated'), onRemoved: event('removed'), onActivated: event('activated')},
      windows: {onFocusChanged: event('focus')}, alarms: {create() {}, onAlarm: event('alarm')}, action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}}}};
  vm.createContext(context); vm.runInContext(fs.readFileSync('extension/background.js', 'utf8') + '\nthis.reviewAPI={dispatch,ready};', context); await context.reviewAPI.ready;
  return {call: (action, extra = {}) => context.reviewAPI.dispatch({action, ...extra}), disk: () => clone(disk), local: () => clone(local), requests};
}

test('repeated health checks cannot turn an expired credential into a connected status', async () => {
  const initial = C.initial(); initial.bridge.paired = true;
  const record = C.normalizeRecord({id: 'cached', kind: 'session', title: '来源名称', updatedAt: Date.now()}); record.user.alias = '人工保留名称'; initial.records.push(record);
  const x = await app({initial, local: {taskOutBridge: {url: 'http://127.0.0.1:4518', token: 'expired-fixture'}},
    fetch: async url => new URL(url).pathname === '/health' ? response({name: 'Task Out', state: 'running', mode: 'background'}) : response({error: '请重新配对', code: 'CONNECTION_EXPIRED'}, 401)});
  for (let count = 0; count < 2; count++) {
    const result = await x.call('service-status');
    assert.equal(result.service.code, 'CONNECTION_EXPIRED'); assert.equal(x.disk().bridge.paired, false);
    assert.match(x.disk().bridge.status, /失效|配对/); assert.equal(x.disk().records[0].user.alias, '人工保留名称');
  }
});

test('a saved credential is recovered after a worker restart before the paired UI snapshot committed', async () => {
  const x = await app({local: {taskOutBridge: {url: 'http://127.0.0.1:4518', token: 'valid-fixture'}},
    fetch: async url => new URL(url).pathname === '/health' ? response({name: 'Task Out', state: 'running', mode: 'background'}) : response({state: 'running', mode: 'background', canStop: true})});
  const result = await x.call('service-status');
  assert.equal(x.requests.some(request => new URL(request.url).pathname === '/v1/service'), true, 'saved credentials must be validated instead of relying only on stale UI state');
  assert.equal(result.service.canStop, true); assert.equal(x.disk().bridge.paired, true); assert.equal(x.local().taskOutBridge.token, 'valid-fixture');
});

test('connector-declared password and sensitive fields cannot enter an onboarding draft under generic names', async () => {
  const initial = C.initial();
  initial.connectors = [{id: 'fixture', configFields: [{key: 'authorization', type: 'password'}, {key: 'access', type: 'text', sensitive: true}, {key: 'credentialFile', type: 'path'}, {key: 'alternateRoot', type: 'path'}]}];
  const x = await app({initial});
  await x.call('onboarding-save', {step: 'preview', draft: {connectorId: 'fixture', root: '/fixture/logs', alternateRoot: '/fixture/alternate',
    authorization: 'DO_NOT_PERSIST_PASSWORD', access: 'DO_NOT_PERSIST_SENSITIVE', credentialFile: '/DO_NOT_PERSIST_KEY', code: 'DO_NOT_PERSIST_CODE'}});
  assert.equal(x.disk().onboarding.draft.alternateRoot, '/fixture/alternate');
  assert.doesNotMatch(JSON.stringify(x.disk().onboarding), /DO_NOT_PERSIST/);
});

test('recovering a saved credential for a new address also restores the URL needed to accept later sync results', async () => {
  const initial = C.initial(); initial.bridge = {url: 'http://127.0.0.1:4518', paired: false, generation: 'previous-service'};
  const record = C.normalizeRecord({id: 'new-service-record', kind: 'session', title: '新服务的会话', updatedAt: Date.now(),
    observations: [{connectionId: 'new-source', allowAI: false}]});
  const x = await app({initial, local: {taskOutBridge: {url: 'http://127.0.0.1:49123', token: 'new-valid-fixture'}}, fetch: async url => {
    const route = new URL(url).pathname;
    if (route === '/health') return response({name: 'Task Out', state: 'running', mode: 'background'});
    if (route === '/v1/service') return response({state: 'running', mode: 'background', canStop: true});
    if (route === '/v1/connectors') return response({connectors: []});
    return response({records: [record], connections: [{id: 'new-source', historyDays: 30, allowAI: false}]});
  }});
  await x.call('service-status'); await x.call('refresh');
  assert.equal(x.disk().bridge.url, 'http://127.0.0.1:49123');
  assert.equal(x.disk().records.some(record => record.id === 'new-service-record'), true);
});

test('a temporary authenticated status failure does not revoke an established pairing or ask for a new code', async () => {
  for (const fail of [() => response({error: '暂时不可用', code: 'SERVICE_ERROR'}, 500), () => {throw new TypeError('temporary connection interruption');}]) {
    const initial = C.initial(); initial.bridge.paired = true;
    const x = await app({initial, local: {taskOutBridge: {url: 'http://127.0.0.1:4518', token: 'valid-fixture'}},
      fetch: async url => new URL(url).pathname === '/health' ? response({name: 'Task Out', state: 'running', mode: 'background'}) : fail()});
    const result = await x.call('service-status');
    assert.equal(x.disk().bridge.paired, true); assert.notEqual(result.service.paired, false);
    assert.doesNotMatch(x.disk().bridge.status, /失效|重新配对/); assert.equal(x.local().taskOutBridge.token, 'valid-fixture');
  }
});

test('native picker timeout can reach the extension before the bridge transport times out', async () => {
  const deadlines = [];
  const x = await app({local: {taskOutBridge: {url: 'http://127.0.0.1:4518', token: 'valid-fixture'}},
    abortSignal: {timeout: milliseconds => {deadlines.push(milliseconds); return new AbortController().signal;}},
    fetch: async () => response({code: 'DIRECTORY_PICKER_TIMEOUT', error: '选择目录已超时，请手动填写目录的完整路径。'}, 408)});
  await assert.rejects(x.call('service', {method: 'POST', path: '/v1/directories/select', body: {}}), error => error.code === 'DIRECTORY_PICKER_TIMEOUT' && /手动填写/.test(error.message));
  assert.ok(deadlines[0] > 120000, 'bridge needs response time beyond the 120-second native picker deadline');
});
