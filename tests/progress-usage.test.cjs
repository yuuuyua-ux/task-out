const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const S = require('../extension/suggestions.js');
const config = {baseUrl: 'https://model.example/v1', model: 'fixture-model', rules: 'PRIVATE_GROUPING_PREFERENCE'};
const session = (id, extra = {}) => ({id, kind: 'session', title: '公开任务', summary: '已完成资料收集', revision: 3,
  manual: {}, observations: [{allowAI: true, includeSummary: true, includeNaming: true}], ...extra});
const web = (id, extra = {}) => ({id, kind: 'web', title: '公开网页', url: 'https://example.test/', revision: 0, manual: {}, ...extra});
const patch = (recordId, value = {summary: '资料已收集，待完成分析'}) => ({recordId, patch: value});
const response = (suggestions, usage, extra = {}) => ({ok: true, status: 200, json: async () => ({usage, choices: [{finish_reason: 'stop', message: {content: JSON.stringify({suggestions})}, ...extra}]})});
const inputOf = options => JSON.parse(JSON.parse(options.body).messages.find(message => message.role === 'user').content);
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const unknown = {inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null};
const counts = event => Object.fromEntries(Object.keys(unknown).map(key => [key, event[key]]));

test('progress preparation requires session summary consent and excludes protected, archived, child and out-of-window records', () => {
  const allowed = session('allowed', {manual: {projectId: true, tags: true}, projectId: 'private-project', tags: ['PRIVATE_TAG'], firstMessage: 'PRIVATE_FIRST', latestMessage: 'PRIVATE_LATEST'});
  const result = S.prepareProgress([allowed,
    web('web'), session('denied', {observations: [{allowAI: false, includeSummary: true}]}),
    session('no-summary', {observations: [{allowAI: true, includeSummary: false}]}),
    session('shared-restricted', {observations: [{allowAI: true, includeSummary: true}, {allowAI: true}]}),
    session('manual', {manual: {summary: true}}), session('archived', {archived: true}),
    session('child', {parentId: 'parent'}), session('expired', {outsideHistoryRange: true})
  ]);
  assert.deepEqual(result.included, [{id: 'allowed', kind: 'session', title: '公开任务', summary: '已完成资料收集', editableFields: ['summary']}]);
  assert.equal(result.excluded.length, 8);
});

test('progress requests send only title and permitted summary, without preferences, catalogs, tags or naming excerpts', async () => {
  let request;
  const item = session('progress', {title: 'PRIVATE_FIRST_TITLE', titleBasis: 'first-message', sourceTitle: '', firstMessage: 'PRIVATE_FIRST', latestMessage: 'PRIVATE_LATEST', needsSessionName: true, tags: ['PRIVATE_TAG'], transcript: 'PRIVATE_HISTORY'});
  const result = await S.run({items: [item], projects: [{id: 'private-project', name: 'PRIVATE_PROJECT'}], config, progressOnly: true,
    fetchImpl: async (_url, options) => {request = options; return response([patch(item.id)]);}});
  const input = inputOf(request);
  assert.deepEqual(Object.keys(input), ['records']);
  assert.deepEqual(Object.keys(input.records[0]).sort(), ['editableFields', 'id', 'kind', 'summary', 'title']);
  assert.equal(input.records[0].title, '未命名会话'); assert.deepEqual(input.records[0].editableFields, ['summary']);
  assert.equal(request.body.includes('PRIVATE_'), false); assert.deepEqual(result.suggestions[0].patch, {summary: '资料已收集，待完成分析'});
});

test('progress output rejects every non-summary field before protected-field filtering and never repairs project references', async () => {
  for (const illegal of [{projectId: 'invented'}, {projectName: '新项目'}, {tags: []}, {sessionName: '不应改名'}, {archived: true}]) {
    let calls = 0;
    await assert.rejects(() => S.run({items: [session('a', {manual: {projectId: true, tags: true}})], config, progressOnly: true,
      fetchImpl: async () => {calls++; return response([patch('a', {summary: '进展', ...illegal})]);}}));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const result = await S.run({items: [session('no-permission', {includeSummary: false})], config, progressOnly: true, fetchImpl: () => {calls++;}});
  assert.equal(calls, 0); assert.equal(result.suggestions.length, 0);
});

test('progress batches preserve revisions and do not send a later record that expired in flight', async () => {
  let now = 1000, calls = 0;
  class Clock extends Date {static now() {return now;}}
  const context = {URL, AbortController, DOMException, setTimeout, clearTimeout, Date: Clock};
  vm.createContext(context); vm.runInContext(fs.readFileSync('extension/suggestions.js', 'utf8'), context);
  const items = Array.from({length: 21}, (_, n) => session(`p-${n}`, {revision: n, historyExpiresAt: n === 20 ? 1100 : 5000}));
  const result = await context.TaskOutSuggestions.run({items, config, progressOnly: true, fetchImpl: async (_url, options) => {
    calls++; const input = inputOf(options); assert.equal(input.records.length, 20); now = 2000;
    return response(input.records.map(item => patch(item.id)));
  }});
  assert.equal(calls, 1); assert.equal(result.suggestions.length, 20); assert.equal(result.suggestions[19].revision, 19);
  assert.equal(result.excluded.some(item => item.id === 'p-20'), true);
});

test('usage records exact allowlisted OpenAI token counts without prompts, keys, output or gateway extras', async () => {
  const events = [];
  await S.run({items: [web('public')], config, apiKey: 'SYNTHETIC_SECRET_KEY', onUsage: async event => events.push(event), trigger: 'automatic',
    fetchImpl: async () => response([patch('public', {tags: ['调研分析']})], {prompt_tokens: 40, completion_tokens: 20, total_tokens: 60, prompt_tokens_details: {cached_tokens: 10}, private: 'GATEWAY_PRIVATE'})});
  assert.equal(events.length, 1);
  const event = events[0];
  assert.deepEqual(Object.keys(event).sort(), ['id', 'at', 'baseUrl', 'model', 'purpose', 'trigger', 'status', 'inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'recordCount', 'attempt'].sort());
  assert.deepEqual(counts(event), {inputTokens: 40, outputTokens: 20, totalTokens: 60, cachedInputTokens: 10});
  assert.equal(event.purpose, 'grouping'); assert.equal(event.trigger, 'automatic'); assert.equal(event.status, 'response');
  assert.equal(event.recordCount, 1); assert.equal(event.attempt, 1); assert.ok(Number.isSafeInteger(event.at)); assert.ok(event.id);
  assert.equal(event.baseUrl, config.baseUrl); assert.equal(event.model, config.model);
  for (const secret of ['PRIVATE_GROUPING_PREFERENCE', 'SYNTHETIC_SECRET_KEY', 'GATEWAY_PRIVATE', '公开网页']) assert.equal(JSON.stringify(event).includes(secret), false);
});

test('usage accepts compatibility counters, retains valid zero and treats absent or malformed counts as unknown', async () => {
  const cases = [
    {usage: {input_tokens: 5, output_tokens: 0, total_tokens: 5, input_tokens_details: {cached_tokens: 2}}, expected: {inputTokens: 5, outputTokens: 0, totalTokens: 5, cachedInputTokens: 2}},
    {usage: undefined, expected: unknown},
    {usage: {prompt_tokens: -1, completion_tokens: '3', total_tokens: 1.5, cached_input_tokens: Infinity}, expected: unknown},
    {usage: {prompt_tokens: 4, completion_tokens: 2, prompt_tokens_details: {cached_tokens: 5}}, expected: {inputTokens: 4, outputTokens: 2, totalTokens: null, cachedInputTokens: null}},
  ];
  for (const {usage, expected} of cases) {
    const events = [];
    await S.run({items: [web('a')], config, onUsage: event => events.push(event), fetchImpl: async () => response([patch('a')], usage)});
    assert.equal(events.length, 1); assert.deepEqual(counts(events[0]), expected);
  }
});

test('each actual model retry is counted once even when grouping or later output validation fails', async () => {
  const events = []; let calls = 0;
  await assert.rejects(() => S.run({items: [web('a')], config, projects: [{id: 'known', name: '示例项目'}], onUsage: event => events.push(event), fetchImpl: async () => {
    calls++; return response([patch('a', calls === 1 ? {projectId: 'invented'} : {tags: ['INVALID_TYPE']})], {prompt_tokens: calls, completion_tokens: 2, total_tokens: calls + 2});
  }}));
  assert.equal(calls, 2); assert.equal(events.length, 2); assert.notEqual(events[0].id, events[1].id);
  assert.deepEqual(events.map(event => event.attempt), [1, 2]); assert.deepEqual(events.map(event => event.status), ['response', 'response']);
  assert.deepEqual(events.map(event => event.totalTokens), [3, 4]);
  const truncated = [];
  await assert.rejects(() => S.run({items: [web('a')], config, onUsage: event => truncated.push(event), fetchImpl: async () => response([], {total_tokens: 9}, {finish_reason: 'length'})}));
  assert.equal(truncated.length, 1); assert.equal(truncated[0].totalTokens, 9);
});

test('network, HTTP and JSON failures report one unknown usage event without reading or logging private error bodies', async () => {
  const failures = [
    async () => {throw Error('PRIVATE_TRANSPORT_ERROR');},
    async () => ({ok: false, status: 401, json: () => assert.fail('Do not read an error body')}),
    async () => ({ok: true, status: 200, json: async () => {throw Error('PRIVATE_PARSE_ERROR');}}),
  ];
  for (const fetchImpl of failures) {
    const events = [];
    await assert.rejects(() => S.run({items: [web('a')], config, fetchImpl, onUsage: event => events.push(event)}));
    assert.equal(events.length, 1); assert.equal(events[0].status, 'error'); assert.deepEqual(counts(events[0]), unknown);
    assert.equal(JSON.stringify(events).includes('PRIVATE_'), false);
  }
});

test('cancellation counts an attempted request once and no usage event is invented before fetch', async () => {
  const controller = new AbortController(), events = [];
  await assert.rejects(() => S.run({items: [session('a')], config, progressOnly: true, signal: controller.signal, onUsage: event => events.push(event), fetchImpl: async () => {
    controller.abort(); return new Promise(() => {});
  }}), {name: 'AbortError'});
  assert.equal(events.length, 1); assert.equal(events[0].status, 'cancelled'); assert.equal(events[0].purpose, 'progress'); assert.deepEqual(counts(events[0]), unknown);
  const before = [];
  await assert.rejects(() => S.run({items: [web('a')], config, signal: controller.signal, onUsage: event => before.push(event), fetchImpl: () => assert.fail('Already cancelled')}), {name: 'AbortError'});
  assert.equal(before.length, 0);
});

test('usage callbacks are awaited and persistence errors propagate without being wrapped as model connectivity errors', async () => {
  const entered = deferred(), gate = deferred(); let completed = false;
  const pending = S.run({items: [web('a')], config, onUsage: async () => {entered.resolve(); await gate.promise;}, fetchImpl: async () => response([patch('a')])}).then(result => {completed = true; return result;});
  await entered.promise; assert.equal(completed, false); gate.resolve(); await pending; assert.equal(completed, true);
  const failure = Error('Synthetic ledger write failed'); let calls = 0;
  await assert.rejects(() => S.run({items: [web('a')], config, onUsage: async () => {calls++; throw failure;}, fetchImpl: async () => response([patch('a')])}), error => error === failure);
  assert.equal(calls, 1);
});

test('batch usage has actual record counts and testConnection reports public classification calls as test', async () => {
  const events = [];
  await S.run({items: Array.from({length: 21}, (_, n) => session(`p-${n}`)), config, progressOnly: true, onUsage: event => events.push(event), fetchImpl: async (_url, options) => response(inputOf(options).records.map(item => patch(item.id)))});
  assert.deepEqual(events.map(event => event.recordCount), [20, 1]); assert.deepEqual(events.map(event => event.purpose), ['progress', 'progress']);
  const testEvents = [];
  await S.testConnection({config, onUsage: event => testEvents.push(event), fetchImpl: async (_url, options) => {
    assert.equal(options.body.includes('PRIVATE_GROUPING_PREFERENCE'), false); const input = inputOf(options);
    return response(input.records.map(item => ({...patch(item.id, {projectId: input.projects[0].id}),evidence:{field:'title',quote:item.title}})), {total_tokens: 11});
  }});
  assert.equal(testEvents.length, 1); assert.equal(testEvents[0].purpose, 'test'); assert.equal(testEvents[0].trigger, 'manual'); assert.equal(testEvents[0].recordCount, 2);
});

test('model types are a fixed seven-choice vocabulary and at most one primary type survives strict validation', async () => {
  assert.deepEqual(S.TYPE_LABELS, ['调研分析', '需求规划', '方案设计', '开发实现', '测试排障', '文档整理', '使用咨询']);
  const accepted = await S.run({items: [web('a')], config, fetchImpl: async (_url, options) => {
    assert.deepEqual(inputOf(options).allowedTypes, S.TYPE_LABELS); return response([patch('a', {tags: ['开发实现']})]);
  }});
  assert.deepEqual(accepted.suggestions[0].patch.tags, ['开发实现']);
  for (const tags of [['工具名'], ['方案设计', '开发实现'], ['调研分析', '调研分析']]) {
    let calls = 0;
    await assert.rejects(() => S.run({items: [web('a', {manual: {tags: true}})], config, fetchImpl: async () => {calls++; return response([patch('a', {tags, summary: '进展'})]);}}));
    assert.equal(calls, 1);
  }
  const empty = await S.run({items: [web('a')], config, fetchImpl: async () => response([patch('a', {tags: []})])});
  assert.deepEqual(empty.suggestions[0].patch.tags, []);
});

test('request hooks freeze prices at each actual batch and project-repair request with matching usage IDs', async () => {
  for (const retry of [false, true]) {
    const snapshots = new Map(), starts = [], usedPrices = [], events = [];
    let currentPrice = 2, calls = 0;
    await S.run({items: retry ? [web('a')] : Array.from({length: 21}, (_, n) => web(`w-${n}`)), config, projects: [{id: 'project', name: '示例项目'}],
      onRequest: request => {
        assert.equal(calls, starts.length, 'snapshot runs immediately before its fetch');
        assert.deepEqual(Object.keys(request).sort(), ['at', 'baseUrl', 'id', 'model']);
        assert.equal(request.baseUrl, config.baseUrl); assert.equal(request.model, config.model);
        snapshots.set(request.id, currentPrice); starts.push(request);
      },
      onUsage: event => {assert.equal(event.at, starts.find(start => start.id === event.id).at); usedPrices.push(snapshots.get(event.id)); events.push(event);},
      fetchImpl: async (_url, options) => {
        calls++; assert.equal(starts.length, calls, 'every fetch already has its own snapshot');
        currentPrice = 100;
        const input = inputOf(options);
        return response(input.records.map(item => patch(item.id, {projectId: retry && calls === 1 ? 'INVALID_PROJECT' : input.projects[0].id})), {total_tokens: 3});
      }});
    assert.equal(calls, 2); assert.equal(starts.length, 2); assert.notEqual(starts[0].id, starts[1].id);
    assert.deepEqual(usedPrices, [2, 100]); assert.deepEqual(events.map(event => event.id), starts.map(start => start.id));
    assert.deepEqual(events.map(event => event.recordCount), retry ? [1, 1] : [20, 1]);
    assert.deepEqual(events.map(event => event.attempt), retry ? [1, 2] : [1, 1]);
  }
});

test('request snapshot failures and pre-fetch cancellation never invent charged requests', async () => {
  const failure = Error('Synthetic snapshot failure'), events = [];
  await assert.rejects(() => S.run({items: [web('a')], config, onRequest: () => {throw failure;},
    onUsage: event => events.push(event), fetchImpl: () => assert.fail('snapshot failed before fetch')}), error => error === failure);
  assert.equal(events.length, 0);
  const controller = new AbortController(); let starts = 0;
  await assert.rejects(() => S.run({items: [web('a')], config, signal: controller.signal, onRequest: () => {starts++; controller.abort();},
    onUsage: event => events.push(event), fetchImpl: () => assert.fail('cancelled before fetch')}), {name: 'AbortError'});
  assert.equal(starts, 1); assert.equal(events.length, 0);
  await assert.rejects(() => S.run({items: [web('a')], config, signal: controller.signal, onRequest: () => assert.fail('already cancelled'),
    onUsage: event => events.push(event), fetchImpl: () => assert.fail('already cancelled')}), {name: 'AbortError'});
  await S.run({items: [session('denied', {allowAI: false})], config, onRequest: () => assert.fail('all records excluded'),
    onUsage: event => events.push(event), fetchImpl: () => assert.fail('all records excluded')});
  assert.equal(events.length, 0);
});

test('connection tests forward the request snapshot hook before classification fetch', async () => {
  const starts = [], events = [];
  await S.testConnection({config, onRequest: request => starts.push(request), onUsage: event => events.push(event),
    fetchImpl: async (_url, options) => {assert.equal(starts.length, 1); const input = inputOf(options); return response(input.records.map(item => ({...patch(item.id, {projectId: input.projects[0].id}),evidence:{field:'title',quote:item.title}})));}});
  assert.equal(events.length, 1); assert.equal(events[0].id, starts[0].id); assert.equal(events[0].at, starts[0].at);
  assert.equal(events[0].purpose, 'test');
});

test('every truncated parent, split child and project repair has its own usage count and request-price snapshot', async () => {
  for (const lengthFirst of [true, false]) {
  const starts = [], events = [], prices = [], snapshots = new Map(); let calls = 0, price = 1;
  const result = await S.run({items: [web('a'), web('b')], projects: [{id: 'project', name: '示例项目'}], config,
    onRequest: event => {starts.push(event); snapshots.set(event.id, price);},
    onUsage: event => {events.push(event); prices.push(snapshots.get(event.id));},
    fetchImpl: async (_url, options) => {
      calls++; price++; const input = inputOf(options);
      if (calls === (lengthFirst ? 1 : 2)) return response([], {prompt_tokens: 8, completion_tokens: 8192, total_tokens: 8200}, {finish_reason: 'length'});
      return response(input.records.map(item => patch(item.id, {projectId: calls === (lengthFirst ? 2 : 1) ? 'INVALID_PROJECT' : input.projects[0].id})), {total_tokens: 10});
    }});
  assert.equal(result.suggestions.length, 2); assert.equal(calls, 4);
  assert.deepEqual(events.map(event => event.recordCount), lengthFirst ? [2, 1, 1, 1] : [2, 2, 1, 1]);
  assert.deepEqual(events.map(event => event.attempt), [1, 2, 3, 4]);
  assert.deepEqual(events.map(event => event.totalTokens), lengthFirst ? [8200, 10, 10, 10] : [10, 8200, 10, 10]);
  assert.deepEqual(prices, [1, 2, 3, 4]);
  assert.equal(new Set(events.map(event => event.id)).size, 4);
  assert.deepEqual(events.map(event => event.id), starts.map(event => event.id));
  }
});

test('length splitting preserves progress-only and naming-only contracts and required names', async () => {
  for (const namingOnly of [false, true]) {
    const items = ['a', 'b'].map(id => session(id, {sourceTitle: '', titleBasis: 'first-message', needsSessionName: true,
      firstMessage: '虚构请求', latestMessage: '虚构结果'}));
    const events = []; let calls = 0;
    const result = await S.run({items, config, namingOnly, progressOnly: !namingOnly, onUsage: event => events.push(event),
      fetchImpl: async (_url, options) => {
        calls++; const input = inputOf(options);
        assert.deepEqual(input.records[0].editableFields, [namingOnly ? 'sessionName' : 'summary']);
        if (!namingOnly) {assert.deepEqual(Object.keys(input), ['records']); assert.equal(options.body.includes('虚构请求'), false);}
        if (calls === 1) return response([], {total_tokens: 100}, {finish_reason: 'length'});
        return response(input.records.map(item => patch(item.id, namingOnly ? {sessionName: '固定名称'} : {summary: '已整理资料'})), {total_tokens: 20});
      }});
    assert.equal(result.suggestions.length, 2); assert.equal(calls, 3);
    assert.deepEqual(events.map(event => event.purpose), Array(3).fill(namingOnly ? 'naming' : 'progress'));
  }
  let calls = 0;
  await assert.rejects(() => S.run({items: ['a', 'b'].map(id => session(id, {sourceTitle: '', needsSessionName: true, firstMessage: '请求', latestMessage: '结果'})),
    config, requireNames: true, fetchImpl: async () => {calls++; return calls === 1 ? response([], {}, {finish_reason: 'length'}) : response([patch('a')]);}}), /缺名会话返回名称/);
  assert.equal(calls, 2);
});

test('ledger persistence errors and cancellation during a split never start extra requests or lose attempted usage', async () => {
  const error = Object.assign(Error('Synthetic ledger failure'), {code: 'MODEL_OUTPUT_LENGTH'}); let calls = 0;
  await assert.rejects(() => S.run({items: [web('a'), web('b')], config,
    onUsage: () => {throw error;}, fetchImpl: async () => {calls++; return response([], {}, {finish_reason: 'length'});}}), value => value === error);
  assert.equal(calls, 1);
  const controller = new AbortController(), events = []; calls = 0;
  await assert.rejects(() => S.run({items: [session('a'), session('b')], config, progressOnly: true, signal: controller.signal,
    onUsage: event => events.push(event), fetchImpl: async () => {
      calls++; if (calls === 1) return response([], {total_tokens: 55}, {finish_reason: 'length'});
      controller.abort(); return new Promise(() => {});
    }}), {name: 'AbortError'});
  assert.equal(calls, 2); assert.equal(events.length, 2);
  assert.deepEqual(events.map(event => event.status), ['response', 'cancelled']);
  assert.equal(events[0].totalTokens, 55); assert.equal(events[1].totalTokens, null);
});
