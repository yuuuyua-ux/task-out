const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const S = require('../extension/suggestions.js');
const config = {baseUrl: 'https://model.example/v1', model: 'fixture', maxGroups: 2};
const projects = [{id: 'existing', name: '原有项目'}];
const web = id => ({id, kind: 'web', title: '虚构参考资料', url: 'https://example.com/', revision: 1, manual: {}});
const session = (id, extra = {}) => ({id, kind: 'session', title: '固定会话名称', summary: '已整理虚构资料', revision: 3,
  manual: {}, observations: [{allowAI: true, includeSummary: true, includeNaming: true}], ...extra});
const suggestion = (id, patch) => ({recordId: id, patch});
const reply = (suggestions, finish_reason = 'stop') => ({ok: true, status: 200, json: async () => ({usage: {total_tokens: 20},
  choices: [{finish_reason, message: {content: typeof suggestions === 'string' ? suggestions : JSON.stringify({suggestions})}}]})});
const inputOf = options => JSON.parse(JSON.parse(options.body).messages[1].content);

test('group limits default to five for absent settings and reject invalid explicit values', () => {
  for (const maxGroups of [undefined, null, '', '   ']) assert.equal(S.normalizeConfig({maxGroups}).maxGroups, 5);
  for (const maxGroups of [1, 5, 50]) assert.equal(S.normalizeConfig({maxGroups}).maxGroups, maxGroups);
  for (const maxGroups of [0, -1, 51, 1.5, '5', false, {}, NaN]) assert.throws(() => S.normalizeConfig({maxGroups}), /1 到 50/);
});

test('unique existing names reuse real IDs and repeated proposed names consume only one remaining slot', async () => {
  const result = await S.run({items: [web('a'), web('b'), web('c')], projects, config, fetchImpl: async (_url, options) => {
    const input = inputOf(options); assert.equal(input.maxGroups, 2); assert.equal(input.remainingNewGroups, 1);
    return reply([suggestion('a', {projectName: '原有项目'}), suggestion('b', {projectName: '共同新项目'}), suggestion('c', {projectName: '共同新项目'})]);
  }});
  assert.deepEqual(result.suggestions.map(row => row.patch), [{projectId: 'existing'}, {projectName: '共同新项目'}, {projectName: '共同新项目'}]);
});

test('over-limit answers get one correction with no provisional slots or raw rejected answer carried forward', async () => {
  const requests = [], usage = [];
  const result = await S.run({items: [web('a'), web('b')], projects, config, onUsage: event => usage.push(event), fetchImpl: async (_url, options) => {
    requests.push(options); const input = inputOf(options);
    assert.equal(input.remainingNewGroups, 1); assert.equal(input.projects.length, 1);
    assert.equal(options.body.includes('PRIVATE_REJECTED_OUTPUT'), false);
    return reply(requests.length === 1 ? [suggestion('a', {projectName: '新项目一'}), {...suggestion('b', {projectName: '新项目二'}), reason: 'PRIVATE_REJECTED_OUTPUT'}] :
      [suggestion('a', {projectName: '共同项目'}), suggestion('b', {projectName: '共同项目'})]);
  }});
  assert.equal(requests.length, 2); assert.equal(result.suggestions.length, 2);
  assert.deepEqual(usage.map(event => event.attempt), [1, 2]);
  assert.equal(requests[0].signal, requests[1].signal);
});

test('persistent over-limit output is rejected instead of silently dropping extra groups', async () => {
  let calls = 0; const items = [web('a'), web('b')];
  await assert.rejects(() => S.run({items, projects, config, fetchImpl: async () => {
    calls++; return reply([suggestion('a', {projectName: '新项目一'}), suggestion('b', {projectName: '新项目二'})]);
  }}), {code: 'GROUP_LIMIT_EXCEEDED'});
  assert.equal(calls, 2); assert.equal(items.some(item => item.projectId), false);
});

test('a run shares its remaining quota across normal batches and returns provisional aliases as project names', async () => {
  const items = Array.from({length: 21}, (_, n) => web('row-' + n)); let calls = 0;
  const result = await S.run({items, config: {...config, maxGroups: 1}, fetchImpl: async (_url, options) => {
    calls++; const input = inputOf(options);
    if (calls === 1) {assert.equal(input.remainingNewGroups, 1); return reply(input.records.map(row => suggestion(row.id, {projectName: '唯一项目'})));}
    assert.equal(input.remainingNewGroups, 0); assert.equal(input.projects.length, 1); assert.equal(input.projects[0].name, '唯一项目');
    return reply(input.records.map(row => suggestion(row.id, {projectId: input.projects[0].id})));
  }});
  assert.equal(calls, 2); assert.equal(result.suggestions.length, 21);
  assert.deepEqual([...new Set(result.suggestions.map(row => row.patch.projectName))], ['唯一项目']);
  assert.equal(result.suggestions.some(row => row.patch.projectId), false);
});

test('later batches and length-split siblings cannot independently spend the same final new-group slot', async () => {
  for (const split of [false, true]) {
    let calls = 0; const quotas = [];
    const result = await S.run({items: Array.from({length: split ? 2 : 21}, (_, n) => web('row-' + n)), config: {...config, maxGroups: 1}, fetchImpl: async (_url, options) => {
      calls++; const input = inputOf(options); quotas.push(input.remainingNewGroups);
      if (split && calls === 1) return reply('TRUNCATED_RESPONSE', 'length');
      if (calls === (split ? 2 : 1)) return reply(input.records.map(row => suggestion(row.id, {projectName: '唯一项目'})));
      if (calls === (split ? 3 : 2)) return reply(input.records.map(row => suggestion(row.id, {projectName: '超额项目'})));
      return reply(input.records.map(row => suggestion(row.id, {projectId: input.projects.find(project => project.name === '唯一项目').id})));
    }});
    assert.equal(calls, split ? 4 : 3); assert.deepEqual(quotas, split ? [1, 1, 0, 0] : [1, 0, 0]);
    assert.equal(result.suggestions.every(row => row.patch.projectName === '唯一项目'), true);
  }
});

test('group-only merging excludes protected and denied records and sends only necessary authorized grouping evidence', async () => {
  const items = [session('move-a', {firstMessage: 'PRIVATE_FIRST', latestMessage: 'PRIVATE_LATEST', tags: ['PRIVATE_TAG'], needsSessionName: true}),
    session('move-b', {manual: {tags: true, summary: true}}), session('fixed', {title: 'PRIVATE_FIXED_TITLE', manual: {projectId: true}}),
    session('denied', {title: 'PRIVATE_DENIED_TITLE', observations: [{allowAI: false}]})];
  const result = await S.run({items, projects, config, groupOnly: true, fetchImpl: async (_url, options) => {
    const input = inputOf(options); assert.equal(input.remainingNewGroups, 0); assert.equal(input.allowedTypes, undefined);
    assert.equal(options.body.includes('PRIVATE_'), false);
    assert.deepEqual(input.records.map(row => row.editableFields), [['projectId'], ['projectId']]);
    return reply([suggestion('move-a', {projectName: '原有项目'}), suggestion('move-b', {projectId: input.projects[0].id})]);
  }});
  assert.deepEqual(result.suggestions.map(row => row.patch), [{projectId: 'existing'}, {projectId: 'existing'}]);
  assert.deepEqual(result.excluded.map(row => row.id), ['denied', 'fixed']);
  assert.equal(items[0].title, '固定会话名称'); assert.deepEqual(items[1].manual, {tags: true, summary: true});
});

test('group-only merging rejects new projects, missing assignments and unrelated changes before manual-field filtering', async () => {
  const item = session('a', {manual: {tags: true, summary: true}});
  for (const [suggestions, count, code] of [[[suggestion('a', {projectName: '禁止新增'})], 2, 'GROUP_LIMIT_EXCEEDED'], [[], 2, 'INCOMPLETE_GROUP_ASSIGNMENT'],
    [[suggestion('a', {projectId: 'existing', tags: ['调研分析']})], 1, undefined], [[suggestion('a', {projectId: 'existing', summary: '不能改写'})], 1, undefined]]) {
    let calls = 0;
    await assert.rejects(() => S.run({items: [item], projects, config, groupOnly: true, fetchImpl: async () => {calls++; return reply(suggestions);}}), error => !code || error.code === code);
    assert.equal(calls, count);
  }
  await assert.rejects(() => S.run({items: [item], projects: [], config, groupOnly: true, fetchImpl: () => assert.fail('No target exists')}), {code: 'INCOMPLETE_GROUP_ASSIGNMENT'});
  await assert.rejects(() => S.run({items: [item], projects: [...projects, {id: 'another', name: '另一项目'}], config: {...config, maxGroups: 1}, fetchImpl: () => assert.fail('Existing groups already exceed cap')}), {code: 'GROUP_LIMIT_EXCEEDED'});
});

test('ambiguous existing names share the correction budget with over-limit output and must resolve by ID', async () => {
  const catalog = [{id: 'first', name: '同名'}, {id: 'second', name: '同名'}]; let calls = 0;
  const result = await S.run({items: [web('a')], projects: catalog, config, fetchImpl: async (_url, options) => {
    calls++; return reply([suggestion('a', calls === 1 ? {projectName: '同名'} : {projectId: inputOf(options).projects[0].id})]);
  }});
  assert.equal(result.suggestions[0].patch.projectId, 'first'); assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(() => S.run({items: [web('a')], projects: catalog, config, fetchImpl: async () => {
    calls++; return reply([suggestion('a', calls === 1 ? {projectId: 'invented'} : {projectName: '超额'})]);
  }}), {code: 'GROUP_LIMIT_EXCEEDED'});
  assert.equal(calls, 2);
});

test('quota correction shares the original deadline and cannot ignore cancellation', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(() => S.run({items: [web('a')], projects, config: {...config, maxGroups: 1}, signal: controller.signal,
    onUsage: () => controller.abort(), fetchImpl: async () => {calls++; return reply([suggestion('a', {projectName: '超额'})]);}}), {name: 'AbortError'});
  assert.equal(calls, 1);
  let expire, timers = 0, cleared = 0;
  const context = {URL, AbortController, DOMException, setTimeout(fn, delay) {assert.equal(delay, 120000); timers++; expire = fn; return 1;}, clearTimeout() {cleared++;}};
  vm.createContext(context); vm.runInContext(fs.readFileSync('extension/suggestions.js', 'utf8'), context); calls = 0;
  await assert.rejects(() => context.TaskOutSuggestions.run({items: [web('a')], projects, config: {...config, maxGroups: 1}, fetchImpl: async () => {
    calls++; if (calls === 1) return reply([suggestion('a', {projectName: '超额'})]); expire(); return new Promise(() => {});
  }}), {name: 'TimeoutError'});
  assert.equal(calls, 2); assert.equal(timers, 1); assert.equal(cleared, 1);
});

test('expired proposals release their temporary name slot without changing acquisition limits', async () => {
  let now = 1000, calls = 0;
  class Clock extends Date {static now() {return now;}}
  const context = {URL, AbortController, DOMException, setTimeout, clearTimeout, Date: Clock};
  vm.createContext(context); vm.runInContext(fs.readFileSync('extension/suggestions.js', 'utf8'), context);
  const items = Array.from({length: 21}, (_, n) => ({...web('row-' + n), historyExpiresAt: n < 20 ? 1100 : 5000}));
  const result = await context.TaskOutSuggestions.run({items, config: {...config, maxGroups: 1}, fetchImpl: async (_url, options) => {
    calls++; const input = inputOf(options);
    if (calls === 1) return reply(input.records.map(row => suggestion(row.id, {projectName: '过期记录拟用项目'})));
    assert.deepEqual(input.records.map(row => row.id), ['row-20']); now = 1200;
    return reply([suggestion('row-20', {projectName: '当前记录项目'})]);
  }});
  assert.equal(calls, 2); assert.equal(result.excluded.length, 20);
  assert.deepEqual(Array.from(result.suggestions, row => [row.recordId, row.patch.projectName]), [['row-20', '当前记录项目']]);
});

test('group-only merging retains its project-only restrictions across length splits', async () => {
  let calls = 0;
  const result = await S.run({items: [session('a'), session('b')], projects, config, groupOnly: true, fetchImpl: async (_url, options) => {
    calls++; const input = inputOf(options); assert.equal(input.remainingNewGroups, 0);
    if (calls === 1) return reply('CUT', 'length');
    return reply(input.records.map(row => suggestion(row.id, {projectId: input.projects[0].id})));
  }});
  assert.equal(calls, 3); assert.deepEqual(result.suggestions.map(row => row.patch), [{projectId: 'existing'}, {projectId: 'existing'}]);
});
