'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const C = require('../extension/core.js');
const DAY = 86400000, NOW = Date.now() - 1000;
function fixture(groups = 0) {
  const state = C.initial(); state.groupSettings = {maxGroups: 5};
  state.connections = [{id: 'fixture', historyDays: 30}];
  for (let index = 0; index < groups; index++) {
    const project = C.saveProject(state, {name: `虚构分组${index}`});
    const record = item(`member-${index}`); record.user.projectId = project.id; state.records.push(record);
  }
  return state;
}
function item(id, patch = {}) {
  return C.normalizeRecord({id, kind: 'session', connectorId: 'fixture', title: '虚构任务', updatedAt: NOW,
    observations: [{connectionId: 'fixture', allowAI: true, includeSummary: true, includeNaming: true}], ...patch});
}
function proposal(record, patch, extra = {}) {
  return {id: `proposal-${record.id}`, recordId: record.id, revision: record.user.revision, observedUpdatedAt: record.updatedAt,
    contentRevision: record.contentRevision, patch, ...extra};
}

test('group quota counts only active main records and preserves protected groups before stable popularity order', () => {
  const state = fixture(7);
  state.records[5].user.manual.projectId = true;
  state.records[6].observations[0].allowAI = false;
  const archived = item('archive'); archived.user.archived = true; archived.user.projectId = C.saveProject(state, {name: '归档专用组'}).id;
  const expired = item('expired', {updatedAt: NOW - 31 * DAY}); expired.user.projectId = C.saveProject(state, {name: '过期专用组'}).id;
  const child = item('child', {parentId: state.records[0].id}); child.user.projectId = C.saveProject(state, {name: '子会话专用组'}).id;
  const web = C.normalizeRecord({id: 'web', kind: 'web', connectorId: 'browser', title: '虚构网页', url: 'https://example.test'});
  web.binding = {epoch: 'old', live: true}; web.user.projectId = C.saveProject(state, {name: '旧页签专用组'}).id;
  state.records.push(archived, expired, child, web);
  const popular = item('popular'); popular.user.projectId = state.projects[4].id; state.records.push(popular);
  const plan = C.groupingPlan(state, {epoch: 'current', now: NOW + 100});
  assert.equal(plan.groups.length, 7); assert.equal(plan.protectedCount, 2);
  assert.deepEqual(plan.keepIds, [state.projects[5].id, state.projects[6].id, state.projects[4].id, state.projects[0].id, state.projects[1].id]);
  assert.deepEqual(plan.mergeIds, [state.records[2].id, state.records[3].id]);
});

test('too many protected groups produce an actionable limit error without proposing moves', () => {
  const state = fixture(6); state.records.forEach(record => {record.user.manual.projectId = true;});
  const before = C.copy(state), plan = C.groupingPlan(state);
  assert.equal(plan.error.code, 'GROUP_LIMIT_PROTECTED'); assert.match(plan.error.message, /6.*上限 5/);
  assert.equal(plan.mergeIds.length, 0); assert.deepEqual(state, before);
});

test('AI quota checks are atomic across a preview and recheck new groups at apply time', () => {
  const state = fixture(4), first = item('new-first'), second = item('new-second'); state.records.push(first, second);
  state.suggestions = [proposal(first, {projectName: '第五组'}), proposal(second, {projectName: '第六组'})];
  const before = C.copy(state);
  assert.throws(() => C.applySuggestions(state, state.suggestions), error => error.code === 'GROUP_LIMIT_REACHED');
  assert.deepEqual(state, before, 'later quota failure must not leave the first proposal applied');
  assert.equal(C.applySuggestions(state, [state.suggestions[0]]).applied, 1);
  assert.equal(C.groupingPlan(state).groups.length, 5);
  assert.throws(() => C.applySuggestions(state, state.suggestions), error => error.code === 'GROUP_LIMIT_REACHED');
  assert.equal(state.records.find(record => record.id === second.id).user.projectId, null);
});

test('group-only application enforces target and immutable fields while retaining undo backups', () => {
  for (const variant of ['type', 'new-group', 'outside-target', 'manual', 'valid']) {
    const state = fixture(6), record = state.records[5], plan = C.groupingPlan(state);
    const preserved = C.copy(record.user);
    const patch = variant === 'type' ? {projectId: plan.keepIds[0], tags: ['方案设计']} : variant === 'new-group' ? {projectName: '新建禁止'}
      : {projectId: variant === 'outside-target' ? record.user.projectId : plan.keepIds[0]};
    state.suggestions = [proposal(record, patch, {kind: 'grouping-merge', allowedProjectIds: plan.keepIds})];
    if (variant === 'manual') record.user.manual.projectId = true;
    if (variant === 'valid') {
      assert.equal(C.applySuggestions(state, state.suggestions).applied, 1);
      assert.equal(C.groupingPlan(state).groups.length, 5);
      assert.deepEqual(record.user.tags, preserved.tags); assert.equal(record.user.sessionName, preserved.sessionName);
      assert.equal(state.undo.at(-1).label, '合并分组'); C.pruneEmptyProjects(state); C.undo(state);
      assert.equal(record.user.projectId, preserved.projectId); assert.equal(C.groupingPlan(state).groups.length, 6);
    } else if (variant === 'manual') {
      assert.equal(C.applySuggestions(state, state.suggestions).applied, 0); assert.equal(record.user.projectId, preserved.projectId);
    } else { const before = C.copy(state); assert.throws(() => C.applySuggestions(state, state.suggestions)); assert.deepEqual(state, before); }
  }
});

test('manual grouping remains possible above the AI limit and dormant groups consume no slots', () => {
  const state = fixture(5), extra = item('manual-extra'); state.records.push(extra);
  const dormant = C.saveProject(state, {name: '手工分组'}); assert.equal(C.groupingPlan(state).groups.length, 5);
  C.userPatch(state, extra.id, {projectId: dormant.id});
  assert.equal(C.groupingPlan(state).groups.length, 6); assert.equal(extra.user.manual.projectId, true);
});
