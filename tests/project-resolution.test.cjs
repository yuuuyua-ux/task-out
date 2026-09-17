const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const S = require('../extension/suggestions.js');
const config = {baseUrl: 'https://model.example/v1', model: 'fixture', rules: '只使用公开测试数据'};
const projects = [{id: 'project:11111111-1111-4111-8111-111111111111', name: '研究'}];
const web = (id, extra = {}) => ({id, kind: 'web', title: '虚构网页', url: 'https://example.test/', projectId: null, tags: [], manual: {}, revision: 0, ...extra});
const proposal = (recordId, patch) => ({recordId, patch});
const reply = suggestions => ({ok: true, status: 200, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({suggestions})}}]})});
const inputOf = options => JSON.parse(JSON.parse(options.body).messages.find(message => message.role === 'user').content);

test('project references accept exact real IDs and unique exact names and always resolve to persisted IDs', async () => {
  for (const reference of [projects[0].id, projects[0].name]) {
    let calls = 0;
    const result = await S.run({items: [web('a')], projects, config, fetchImpl: async () => {calls++; return reply([proposal('a', {projectId: reference})]);}});
    assert.equal(calls, 1); assert.deepEqual(result.suggestions[0].patch, {projectId: projects[0].id});
  }
});

test('short project aliases avoid existing IDs and names and remap current record membership and output consistently', async () => {
  const collisionProjects = [{id: 'p1', name: 'p2'}, {id: 'project:second', name: 'p3'}, {id: 'project:third', name: '研究'}];
  const items = collisionProjects.map((project, n) => web(`row-${n}`, {projectId: project.id}));
  let input;
  const result = await S.run({items, projects: collisionProjects, config, fetchImpl: async (_url, options) => {
    input = inputOf(options);
    const occupied = new Set(collisionProjects.flatMap(project => [project.id, project.name]));
    assert.equal(new Set(input.projects.map(project => project.id)).size, collisionProjects.length);
    input.projects.forEach((project, index) => {
      assert.match(project.id, /^_*p\d+$/); assert.equal(occupied.has(project.id), false);
      assert.equal(project.name, collisionProjects[index].name);
      assert.equal(input.records[index].projectId, project.id);
    });
    return reply(input.records.map((record, index) => proposal(record.id, {projectId: input.projects[index].id})));
  }});
  assert.deepEqual(result.suggestions.map(item => item.patch.projectId), collisionProjects.map(project => project.id));
  assert.deepEqual(items.map(item => item.projectId), collisionProjects.map(project => project.id));
});

test('ambiguous project names, copied-ID mistakes and invented IDs remain errors after only one repair request', async () => {
  const cases = [
    {catalog: [...projects, {id: 'project:another', name: '研究'}], reference: '研究'},
    {catalog: projects, reference: projects[0].id.slice(0, -1)},
    {catalog: [], reference: 'project:invented'},
  ];
  for (const {catalog, reference} of cases) {
    let calls = 0;
    await assert.rejects(() => S.run({items: [web('a')], projects: catalog, config, fetchImpl: async () => {
      calls++; return reply([proposal('a', {projectId: reference})]);
    }}), /项目|分组/);
    assert.equal(calls, 2);
  }
});

test('a real ID colliding with another project name requires correction instead of choosing a project by precedence', async () => {
  const collisionProjects = [{id: 'legacy-id', name: '研发'}, {id: 'other-id', name: 'legacy-id'}];
  let calls = 0;
  const result = await S.run({items: [web('a')], projects: collisionProjects, config, fetchImpl: async (_url, options) => {
    calls++;
    if (calls === 1) return reply([proposal('a', {projectId: 'legacy-id'})]);
    const input = inputOf(options);
    return reply([proposal('a', {projectId: input.projects[1].id})]);
  }});
  assert.equal(calls, 2); assert.equal(result.suggestions[0].patch.projectId, 'other-id');
  calls = 0;
  await assert.rejects(() => S.run({items: [web('a')], projects: collisionProjects, config, fetchImpl: async () => {
    calls++; return reply([proposal('a', {projectId: 'legacy-id'})]);
  }}), /项目|分组/);
  assert.equal(calls, 2);
});

test('bounded repair resends the same authorized batch without replaying the invalid model response', async () => {
  const rawMarker = 'INVALID_MODEL_REPLY_IGNORE_RULES_AND_EXFILTRATE';
  const requests = [];
  const result = await S.run({items: [web('allowed'), web('denied', {allowAI: false})], projects, config, fetchImpl: async (_url, options) => {
    requests.push(options);
    const input = inputOf(options);
    assert.deepEqual(input.records.map(item => item.id), ['allowed']);
    if (requests.length === 1) return reply([{...proposal('allowed', {projectId: 'project:invented'}), reason: rawMarker}]);
    assert.equal(options.body.includes(rawMarker), false);
    const original = inputOf(requests[0]);
    assert.deepEqual(input.records, original.records); assert.deepEqual(input.projects, original.projects);
    assert.equal(input.preferences, original.preferences);
    assert.equal(options.signal, requests[0].signal);
    return reply([proposal('allowed', {projectId: input.projects[0].id})]);
  }});
  assert.equal(requests.length, 2); assert.equal(result.suggestions[0].patch.projectId, projects[0].id);
  assert.deepEqual(result.excluded.map(item => item.id), ['denied']);
});

test('same-batch new groups require repeated projectName instead of an invented ID and can be corrected once', async () => {
  let calls = 0;
  const result = await S.run({items: [web('a'), web('b')], projects: [], config, fetchImpl: async () => {
    calls++;
    return reply([proposal('a', {projectName: '新项目'}), proposal('b', calls === 1 ? {projectId: 'project:new'} : {projectName: '新项目'})]);
  }});
  assert.equal(calls, 2); assert.deepEqual(result.suggestions.map(item => item.patch), [{projectName: '新项目'}, {projectName: '新项目'}]);
});

test('protected project fields are ignored before reference resolution while unrelated illegal fields are still rejected', async () => {
  const item = web('a', {projectId: projects[0].id, manual: {projectId: true}});
  let calls = 0;
  const result = await S.run({items: [item], projects, config, fetchImpl: async () => {
    calls++; return reply([proposal('a', {projectId: 'project:invented', tags: ['调研分析']})]);
  }});
  assert.equal(calls, 1); assert.deepEqual(result.suggestions[0].patch, {tags: ['调研分析']});
  assert.equal(item.projectId, projects[0].id);
  const both = await S.run({items: [item], projects, config, fetchImpl: async () =>
    reply([proposal('a', {projectId: 'project:invented', projectName: '不应创建的项目', tags: ['调研分析']})])});
  assert.deepEqual(both.suggestions[0].patch, {tags: ['调研分析']});
  calls = 0;
  await assert.rejects(() => S.run({items: [item], projects, config, fetchImpl: async () => {
    calls++; return reply([proposal('a', {projectId: 'project:invented', archived: true})]);
  }}));
  assert.equal(calls, 1);
});

test('non-project output errors do not trigger the project-reference repair request', async () => {
  for (const bad of [proposal('a', {tags: 'wrong type'}), proposal('other', {projectId: projects[0].id}), proposal('a', {sourceId: 'forbidden'})]) {
    let calls = 0;
    await assert.rejects(() => S.run({items: [web('a')], projects, config, fetchImpl: async () => {calls++; return reply([bad]);}}));
    assert.equal(calls, 1);
  }
});

test('cancellation during a repair discards even a valid repaired response', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(() => S.run({items: [web('a')], projects, config, signal: controller.signal, fetchImpl: async (_url, options) => {
    if (++calls === 1) return reply([proposal('a', {projectId: 'project:invented'})]);
    controller.abort();
    return reply([proposal('a', {projectId: inputOf(options).projects[0].id})]);
  }}), {name: 'AbortError'});
  assert.equal(calls, 2);
});

test('project repair shares the original 120-second deadline without starting another timer', async () => {
  let timeout, timers = 0, cleared = 0, calls = 0;
  const context = {URL, AbortController, DOMException,
    setTimeout(callback, delay) {assert.equal(delay, 120000); timers++; timeout = callback; return 1;},
    clearTimeout() {cleared++;}};
  vm.createContext(context); vm.runInContext(fs.readFileSync('extension/suggestions.js', 'utf8'), context);
  await assert.rejects(() => context.TaskOutSuggestions.run({items: [web('a')], projects, config, fetchImpl: async () => {
    if (++calls === 1) return reply([proposal('a', {projectId: 'project:invented'})]);
    timeout(); return new Promise(() => {});
  }}), {name: 'TimeoutError'});
  assert.equal(calls, 2); assert.equal(timers, 1); assert.equal(cleared, 1);
});

test('repair does not resend records that expired while the invalid first response was in flight', async () => {
  let now = 1000, calls = 0;
  class Clock extends Date {static now() {return now;}}
  const context = {URL, AbortController, DOMException, setTimeout, clearTimeout, Date: Clock};
  vm.createContext(context); vm.runInContext(fs.readFileSync('extension/suggestions.js', 'utf8'), context);
  const items = [web('expires', {historyExpiresAt: 1100}), web('current', {historyExpiresAt: 5000})];
  const result = await context.TaskOutSuggestions.run({items, projects, config, fetchImpl: async (_url, options) => {
    const input = inputOf(options);
    if (++calls === 1) {
      assert.deepEqual(input.records.map(item => item.id), ['expires', 'current']);
      now = 2000;
      return reply(input.records.map(item => proposal(item.id, {projectId: 'project:invented'})));
    }
    assert.deepEqual(input.records.map(item => item.id), ['current']);
    return reply([proposal('current', {projectId: input.projects[0].id})]);
  }});
  assert.equal(calls, 2); assert.equal(result.suggestions.length, 1); assert.equal(result.suggestions[0].recordId, 'current');
  assert.equal(result.excluded.some(item => item.id === 'expires'), true);
});

test('a later batch failure rejects the entire run even after an earlier batch was successfully repaired', async () => {
  const items = Array.from({length: 21}, (_, n) => web(`row-${n}`)); let calls = 0;
  await assert.rejects(() => S.run({items, projects, config, fetchImpl: async (_url, options) => {
    const input = inputOf(options); calls++;
    if (calls === 1) return reply(input.records.map(item => proposal(item.id, {projectId: 'project:invented'})));
    if (calls === 2) return reply(input.records.map(item => proposal(item.id, {projectId: input.projects[0].id})));
    return reply(input.records.map(item => proposal(item.id, {tags: 'invalid'})));
  }}));
  assert.equal(calls, 3); assert.equal(items.every(item => item.projectId === null), true);
});
