'use strict';
importScripts('core.js', 'store.js', 'suggestions.js');
const C = TaskOutCore;
let state, epoch, ready, queue = Promise.resolve(), aiJob = null, syncJob = null;
let scheduleTimer;
let policyChanging = 0;
let serviceQueue = Promise.resolve();
let modelQueue = Promise.resolve();
let serviceStopping = false;
let modelChanging = 0, organizationJob = null;
const SYNC_INTERVALS = [0, 30, 60, 120, 300];
const ONBOARDING_STEPS = ['start', 'pair', 'discover', 'preview', 'enable', 'done'];
function onboardingDraft(input) {
  if (input === null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('接入草稿格式不正确。');
  const connector = (state.connectors || []).find(c => c.id === input.connectorId);
  const sensitive = new Set((connector?.configFields || []).filter(field => field.sensitive === true || field.secret === true || ['password', 'secret'].includes(field.type)).map(field => field.key));
  const allowed = new Set(['connectorId', 'root', 'name', 'historyDays', 'pollIntervalMs', 'metadataRoot', 'allowAI', 'includeSummary', 'includeNaming',
    ...(connector?.configFields || []).map(field => field.key)]);
  const draft = {};
  for (const [key, value] of Object.entries(input)) {
    if (/token|secret|key|code|credential|password|authorization|__proto__|constructor|prototype/i.test(key) || sensitive.has(key)) continue;
    if (key === 'identity') {
      if (value === null) draft.identity = null;
      else if (value && typeof value === 'object' && !Array.isArray(value)) draft.identity = {id: C.text(value.id, 80), label: C.text(value.label, 80), icon: C.text(value.icon, 40)};
    } else if (allowed.has(key) && (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value))) {
      draft[key] = typeof value === 'string' ? value.slice(0, 4096) : value;
    }
  }
  return draft;
}
const syncInterval = next => SYNC_INTERVALS.includes(next?.syncSettings?.intervalSeconds) ? next.syncSettings.intervalSeconds : 60;
function configureSyncAlarm() {
  const seconds = syncInterval(state);
  if (seconds) chrome.alarms.create('task-out-sync', {periodInMinutes: seconds / 60});
  else chrome.alarms.clear?.('task-out-sync');
}
const safeSend = message => { try { chrome.runtime.sendMessage(message).catch(() => {}); } catch {} };
const enqueue = fn => { const job = queue.then(() => ready).then(fn); queue = job.catch(() => {}); return job; };
async function persist(next = state) {
  await TaskOutStore.write(next); state = next;
  safeSend({type: 'task-out-updated'});
}
async function change(fn) {
  const next = C.copy(state), result = await fn(next);
  C.normalizeTypes(next);
  C.pruneEmptyProjects(next, result?.project ? [result.project.id] : []);
  if (result?.suggestions) result.suggestions = C.copy(next.suggestions);
  await persist(next); return result || {};
}
function mustRecord(id) { const r = C.find(state, id); if (!r) throw Error('记录不存在。'); return r; }
const actualWeb = tab => !!C.webUrl(tab.url);
async function badge() {
  try { const tabs = (await chrome.tabs.query({})).filter(actualWeb); await chrome.action.setBadgeText({text: tabs.length ? String(tabs.length) : ''}); await chrome.action.setBadgeBackgroundColor({color: '#5b7d64'}); } catch {}
}
async function reconcileTabs() {
  const tabs = (await chrome.tabs.query({})).filter(actualWeb);
  const {tabRecency = {}} = await chrome.storage.session.get('tabRecency');
  await change(next => {
    const present = new Set(tabs.map(t => t.id));
    for (const record of next.records) {
      if (!record.binding) continue;
      if (record.binding.epoch !== epoch || !present.has(record.binding.tabId)) record.binding.live = false;
    }
    for (const tab of tabs) {
      let r = next.records.find(r => r.kind === 'web' && r.binding?.epoch === epoch && r.binding.tabId === tab.id);
      const activity = tabRecency[tab.id] || tab.lastAccessed || null;
      if (!r) {
        r = C.normalizeRecord({id: `browser:${epoch}:${tab.id}`, kind: 'web', connectorId: 'browser',
          source: {id: 'browser', label: '浏览器', icon: '◎'}, title: tab.title || tab.url, url: tab.url,
          status: 'open', createdAt: null, createdAtBasis: 'first-observed', updatedAt: activity, syncedAt: Date.now(), capabilities: {open: true}});
        next.records.push(r);
      }
      // Tab identity survives navigation within this browser session, not across restarts.
      const title = C.text(tab.title || tab.url, 500), url = C.webUrl(tab.url);
      if (r.title !== title || r.url !== url) r.contentRevision = (r.contentRevision || 0) + 1;
      r.title = title; r.url = url;
      r.updatedAt = activity || r.updatedAt; r.syncedAt = Date.now();
      r.binding = {epoch, tabId: tab.id, windowId: tab.windowId, live: true};
      r.capabilities.open = true;
    }
  });
  await badge();
}
async function initialize() {
  await chrome.storage.local.setAccessLevel?.({accessLevel: 'TRUSTED_CONTEXTS'});
  await chrome.storage.session.setAccessLevel?.({accessLevel: 'TRUSTED_CONTEXTS'});
  state = await TaskOutStore.read();
  if (!state.sourceStyles || typeof state.sourceStyles !== 'object' || Array.isArray(state.sourceStyles)) state.sourceStyles = {};
  state.organization ||= {status: 'idle', lastApplied: 0, lastRunAt: null};
  state.organizationAttempts ||= {};
  state.sessionGrouping ||= {};
  state.progressAttempts ||= {};
  state.progressUpdatedAt ||= {};
  state.syncSettings = {intervalSeconds: syncInterval(state)};
  state.onboarding = {step: ONBOARDING_STEPS.includes(state.onboarding?.step) ? state.onboarding.step : state.connections?.some(c => c.enabled) ? 'done' : 'start',
    draft: onboardingDraft(state.onboarding?.draft || null)};
  state.onboardingRevision = Number.isSafeInteger(state.onboardingRevision) ? state.onboardingRevision : 0;
  C.normalizeTypes(state);
  if (state.organization.status === 'running') state.organization = {...state.organization, status: 'idle', message: '上次整理未完成，将继续检查未处理的内容。'};
  const session = await chrome.storage.session.get(['taskOutEpoch', 'aiView']);
  epoch = session.taskOutEpoch || crypto.randomUUID();
  await chrome.storage.session.set({taskOutEpoch: epoch});
  const legacy = await chrome.storage.local.get(['deferred', 'groupUpgradeBackup', 'taskOutModel', 'llmConfig']);
  if (!state.migration.completed && !state.migration.skipped) {
    const groups = (session.aiView || legacy.groupUpgradeBackup || {}).groups || [];
    const deferred = (legacy.deferred || []).filter(d => !d.dismissed);
    state.migration = {completed: false, skipped: false, pending: !!(groups.length || deferred.length), groups, deferred};
  }
  if (!legacy.taskOutModel) {
    const old = legacy.llmConfig || {};
    // Keep an existing gateway/key in its original extension context; do not send it to the service.
    await chrome.storage.local.set({taskOutModel: {
      baseUrl: old.baseUrl || 'https://api.openai.com/v1', model: old.model || '', rules: old.rules || '', apiKey: old.apiKey || '', autoSuggest: false, autoOrganize: true
    }});
  }
  const initializedModel = await modelConfig();
  state.groupSettings = {maxGroups: C.groupLimit(initializedModel.maxGroups ?? 5)};
  // An interrupted external operation is never repeated blindly after a worker restart.
  for (const r of state.records) if (r.pending) { r.error = '上次操作未确认完成，请核对网页后重试。'; }
  await persist();
  await reconcileTabs();
  configureSyncAlarm();
}
ready = initialize();
ready.catch(() => {});
ready.then(() => scheduleSuggestions()).catch(() => {});
async function modelConfig() {
  const {taskOutModel = {}} = await chrome.storage.local.get('taskOutModel');
  return {...TaskOutSuggestions.normalizeConfig(taskOutModel), apiKey: taskOutModel.apiKey || ''};
}
async function publicSnapshot() {
  const model = await modelConfig();
  const now = Date.now(), items = state.records.map(r => C.publicItem(r, now, state.connections));
  const visible = items.filter(r => r.archived || !r.outsideHistoryRange);
  const visibleIds = new Set(visible.map(r => r.id));
  return {state: {
    projects: C.copy(state.projects), sourceStyles: C.copy(state.sourceStyles), items: visible, historyExcluded: items.filter(r => !r.parentId && !r.archived && r.outsideHistoryRange).length, connections: C.copy(state.connections), connectors: C.copy(state.connectors),
    migration: C.copy(state.migration), bridge: C.copy(state.bridge), suggestions: C.copy(state.suggestions.filter(s => visibleIds.has(s.recordId))), suggestionExcluded: C.copy(state.suggestionExcluded),
    model: {...model, apiKey: undefined, hasKey: !!model.apiKey}, syncSettings: C.copy(state.syncSettings), onboarding: C.copy(state.onboarding), organization: organizationStatus(model), undoAvailable: state.undo.length > 0
  }};
}
function bridgeUrl(value) {
  let u; try { u = new URL(value); } catch { throw Error('请填写本机服务地址。'); }
  if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw Error('本机服务地址须为 localhost 或回环地址，不含路径、账号和参数。');
  return u.origin;
}
async function permission(url) {
  if (!await chrome.permissions.contains({origins: [new URL(url).origin + '/*']})) throw Object.assign(Error('尚未授权访问此地址。请重新点击配对，并在 Chrome 弹窗中允许访问；模型地址请在模型设置中重新保存。'), {code: 'BROWSER_PERMISSION_DENIED'});
}
async function bridgeRequest(path, {method = 'GET', body, url, code, timeoutMs = 120000} = {}) {
  const saved = (await chrome.storage.local.get('taskOutBridge')).taskOutBridge || {};
  const base = bridgeUrl(url || saved.url || state.bridge.url);
  await permission(base);
  if (path !== '/health' && !code && !saved.token) throw Object.assign(Error('请先配对本机服务。在启动窗口复制配对码，回到这里输入即可。'), {code: 'PAIR_REQUIRED'});
  if (!/^\/(?:pair|health|v1\/(?:service(?:\/stop)?|connectors|connections(?:\/[a-zA-Z0-9:_-]+)?|directories\/select|discover|test|sync|records\/[^/?#]+))$/.test(path)) throw Error('不支持的服务操作。');
  let response;
  try {
    response = await fetch(base + path, {method, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs),
      headers: {'Content-Type': 'application/json', 'X-Task-Out-Extension': chrome.runtime.id, ...(code || !saved.token ? {} : {Authorization: 'Bearer ' + saved.token})},
      ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
  } catch (error) {
    throw Object.assign(Error(error.name === 'TimeoutError' ? '本机服务响应超时，请稍后刷新状态。' : '无法连接本机服务。请双击 Task Out 文件夹内 scripts/Start Task Out.command 启动，确认服务地址后重试。'), {connectionFailure: true, code: error.name === 'TimeoutError' ? 'SERVICE_TIMEOUT' : 'SERVICE_OFFLINE'});
  }
  let result; try { result = await response.json(); } catch { throw Error('本机服务返回了无效响应。'); }
  if (!response.ok) throw Object.assign(Error(result.error || '本机服务请求失败（' + response.status + '）。'), {status: response.status,
    code: result.code || (response.status === 401 ? 'CONNECTION_EXPIRED' : 'SERVICE_ERROR')});
  return result;
}
async function serviceStatus() {
  const generation = state.bridge.generation;
  const stoppedByUser = state.bridge.stoppedByUser === true;
  const saved = (await chrome.storage.local.get('taskOutBridge')).taskOutBridge || {};
  let service;
  try {
    const health = await bridgeRequest('/health', {timeoutMs: 3000});
    if (health.name !== 'Task Out') throw Error('该地址没有运行 Task Out 服务，请检查服务地址。');
    service = {state: health.state || 'running', mode: health.mode || 'legacy', startedAt: health.startedAt, canStop: false,
      paired: saved.token ? state.bridge.paired === true : false};
    if (saved.token && service.state === 'running') {
      try { Object.assign(service, await bridgeRequest('/v1/service', {timeoutMs: 3000}), {paired: true, verified: true}); }
      catch (error) { service.message = error.status === 401 ? '服务正在运行，但连接凭据已失效。请重新配对；已有记录和整理仍保留。' : [400,404].includes(error.status) ? '当前为旧版服务。请在原终端停止，再运行更新后的一键启动脚本。' : error.message; service.code = error.code; if (error.status === 401) service.paired = false; }
    }
  } catch (error) {
    const stopped = stoppedByUser && error.connectionFailure === true;
    service = {state: stopped ? 'stopped' : 'offline', canStop: false, code: error.code,
      message: stopped ? '本机服务已停止。需要继续读取会话时，请双击 Start Task Out.command 重新启动。' : error.message};
  }
  await enqueue(() => change(next => {
    if (next.bridge.generation !== generation) return;
    if (service.verified && saved.url && next.bridge.url !== saved.url) {
      // Recover a pairing interrupted after the credential committed but
      // before the IndexedDB snapshot. Do not reuse the old source grants.
      invalidateSuggestions(next); next.connections = []; next.connectors = []; policies(next, []);
      next.bridge.url = saved.url; next.bridge.generation = crypto.randomUUID();
      next.onboarding = {...next.onboarding, step: 'discover'};
    }
    Object.assign(next.bridge, {serviceState: service.state, mode: service.mode, startedAt: service.startedAt, canStop: service.canStop,
      status: service.state === 'running' ? service.verified ? '已连接' : service.code === 'CONNECTION_EXPIRED' ? '连接失效 · 请重新配对' : saved.token ? '服务已启动 · 连接待核验' : '服务已启动 · 待配对' : service.state === 'stopping' ? '正在停止' : service.state === 'stopped' ? '已停止' : '未运行或无法连接'});
    if (typeof service.paired === 'boolean') next.bridge.paired = service.paired;
    if (service.state === 'running') next.bridge.stoppedByUser = false;
  }));
  return {service};
}
async function stopService() {
  serviceStopping = true;
  await enqueue(() => change(next => {
    next.bridge.generation = crypto.randomUUID();
    Object.assign(next.bridge, {serviceState: 'stopping', status: '正在停止', canStop: false});
  }));
  try {
    await bridgeRequest('/v1/service/stop', {method: 'POST', body: {}, timeoutMs: 5000});
    await enqueue(() => change(next => { next.bridge.stoppedByUser = true; }));
    const result = await serviceStatus();
    return {...result, message: result.service.state === 'stopped' ? '本机服务已停止，记录和配对保留。' : '正在停止本机服务，记录和配对保留。'};
  } catch (error) { await serviceStatus(); throw error; }
  finally { serviceStopping = false; }
}
function policies(next, connections) {
  const configs = new Map(connections.map(c => [c.id, c]));
  for (const r of next.records) for (const observation of r.observations) {
    if (observation.connectionId.startsWith('import:')) continue;
    const config = configs.get(observation.connectionId);
    observation.allowAI = config?.allowAI === true;
    observation.includeSummary = config?.includeSummary === true;
    observation.includeNaming = config?.includeNaming === true;
    if (config?.historyDays !== undefined) observation.historyDays = [3, 7, 30].includes(config.historyDays) ? config.historyDays : 30;
  }
}
function invalidateSuggestions(next) {
  aiJob?.abort(); next.policyRevision = (next.policyRevision || 0) + 1;
  next.suggestions = []; next.suggestionExcluded = [];
}
function connectionPolicy(configs) {
  return JSON.stringify(configs.map(c => [c.id, c.root, c.metadataRoot, c.historyDays, c.allowAI === true, c.includeSummary === true, c.includeNaming === true]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))));
}
function updateConnections(next, connections) {
  if (connectionPolicy(next.connections) !== connectionPolicy(connections)) invalidateSuggestions(next);
  next.connections = connections; policies(next, connections);
}
async function syncService(automatic = false) {
  if (serviceStopping) return {message: '本机服务正在停止，显示已读取的记录。'};
  if (syncJob) return syncJob;
  syncJob = (async () => {
    const saved = (await chrome.storage.local.get('taskOutBridge')).taskOutBridge;
    if (!saved?.token) return {message: '浏览器已刷新；本机服务尚未配对。'};
    const {revision, generation} = await enqueue(() => ({revision: state.policyRevision || 0, generation: state.bridge.generation}));
    try {
      const [catalog, result] = await Promise.all([bridgeRequest('/v1/connectors'), bridgeRequest('/v1/sync', {method: 'POST', body: automatic ? {dueOnly: true} : {}})]);
      return await enqueue(() => change(next => {
        if (next.bridge.url !== saved.url || next.bridge.generation !== generation) return {message: '连接已切换，已忽略旧服务的同步结果。'};
        C.upsert(next, result.records || []);
        if ((next.policyRevision || 0) === revision) updateConnections(next, result.connections || next.connections);
        next.connectors = catalog.connectors || [];
        const status = next.connections.some(c => c.status === 'offline') ? '部分来源离线' : result.errors?.length ? '有读取提示' : '已连接';
        policies(next, next.connections); next.bridge = {...next.bridge, url: saved.url, generation, paired: true, status, serviceState: 'running', stoppedByUser: false, syncedAt: Date.now(), errors: result.errors || []};
        return {message: `已同步 ${(result.records || []).length} 条会话记录`, errors: result.errors || []};
      }));
    } catch (e) {
      await enqueue(() => change(next => { if (next.bridge.generation === generation) { next.bridge.status = e.status === 401 ? '连接失效 · 请重新配对' : next.bridge.stoppedByUser ? '已停止' : '离线 · 显示缓存'; next.bridge.serviceState = next.bridge.stoppedByUser ? 'stopped' : 'offline'; next.bridge.canStop = false; next.bridge.error = e.message; if (e.status === 401) next.bridge.paired = false; } }));
      throw e;
    }
  })().finally(() => { syncJob = null; scheduleSuggestions(); });
  return syncJob;
}
async function archive(ids, recordUndo = true) {
  const results = [];
  for (const id of [...new Set(ids)]) {
    const r = mustRecord(id); if (r.user.archived) continue;
    if (r.pending?.type === 'restore') { results.push({id, ok: false, error: '请先核对上次恢复打开的页签。'}); continue; }
    const operationId = crypto.randomUUID();
    // Persist both URL snapshot and intention BEFORE any irreversible browser call.
    await change(next => { const x = C.find(next, id); x.pending = {type: 'archive', operationId}; x.error = ''; });
    try {
      const live = r.kind === 'web' && r.binding?.epoch === epoch && r.binding.live;
      if (live) {
        const tab = await chrome.tabs.get(r.binding.tabId).catch(() => null);
        if (tab && C.webUrl(tab.url) !== r.url) throw Error('网页已跳转，请刷新后再归档。');
        if (tab) await chrome.tabs.remove(tab.id);
      }
      await change(next => {
        const x = C.find(next, id); x.user.archived = true; x.user.archivedAt = Date.now();
        x.user.archivedActivityAt = x.updatedAt; x.user.revision++; x.pending = null; x.error = '';
        if (x.binding) x.binding.live = false;
      });
      results.push({id, ok: true});
    } catch (e) {
      await change(next => { const x = C.find(next, id); x.pending = null; x.error = e.message; });
      results.push({id, ok: false, error: e.message});
    }
  }
  await badge();
  if (recordUndo && results.some(r => r.ok)) await change(next => {
    next.undo.push({kind: 'archive', items: results.filter(r => r.ok).map(r => ({id: r.id, revision: C.find(next, r.id).user.revision}))});
    next.undo = next.undo.slice(-30);
  });
  return {results, message: `已归档 ${results.filter(r => r.ok).length} 条${results.some(r => !r.ok) ? '，部分条目未完成，请重试' : ''}`};
}
async function restore(ids, recordUndo = true) {
  const results = [];
  for (const id of [...new Set(ids)]) {
    let r = mustRecord(id); if (!r.user.archived) continue;
    if (r.pending?.type === 'restore') { results.push({id, ok: false, error: '上次恢复结果未知，请先在浏览器核对，避免重复打开。'}); continue; }
    try {
      if (r.kind === 'web' && r.connectorId === 'browser') {
        if (!C.webUrl(r.url)) throw Error('保存的网址无效。');
        await change(next => { C.find(next, id).pending = {type: 'restore', operationId: crypto.randomUUID()}; });
        const tab = await chrome.tabs.create({url: r.url, active: false});
        // Keep the original record; the created-tab event is queued behind this operation.
        await change(next => {
          const x = C.find(next, id); x.binding = {epoch, tabId: tab.id, windowId: tab.windowId, live: true};
          x.pending = null; x.user.archived = false; x.user.archivedAt = null; x.user.revision++; x.error = '';
        });
      } else await change(next => { const x = C.find(next, id); x.user.archived = false; x.user.archivedAt = null; x.user.revision++; x.error = ''; });
      results.push({id, ok: true});
    } catch (e) {
      // Do not clear an unknown create outcome: a retry could create a second tab.
      await change(next => { C.find(next, id).error = e.message; });
      results.push({id, ok: false, error: e.message});
    }
  }
  if (recordUndo && results.some(r => r.ok)) await change(next => {
    next.undo.push({kind: 'restore', items: results.filter(r => r.ok).map(r => ({id: r.id, revision: C.find(next, r.id).user.revision}))});
    next.undo = next.undo.slice(-30);
  });
  return {results, message: `已恢复 ${results.filter(r => r.ok).length} 条${results.some(r => !r.ok) ? '，部分条目需要核对' : ''}`};
}
async function undoAction() {
  organizationJob?.abort();
  const entry = state.undo.at(-1);
  if (!entry) throw Error('没有可撤销的修改。');
  if (!entry.kind) {
    const config = await modelConfig();
    return change(next => {
      const result = C.undo(next);
      if (entry.label === '合并分组') next.groupMergeSuppressed = groupMergeSignature(next, config);
      // Undo is an intentional disposition of these exact inputs. Do not
      // silently apply the same classification again on the next timer tick.
      for (const item of entry.entries || []) {
        const record = C.find(next, item.id);
        if (record) next.organizationAttempts[record.id] = organizationSignature(record, config, next);
      }
      return result;
    });
  }
  const ids = entry.items.filter(i => C.find(state, i.id)?.user.revision === i.revision).map(i => i.id);
  await change(next => { next.undo.pop(); });
  const result = entry.kind === 'archive' ? await restore(ids, false) : await archive(ids, false);
  return {...result, message: '已撤销上次' + (entry.kind === 'archive' ? '归档' : '恢复') + (ids.length !== entry.items.length ? '；后续已修改的记录已跳过。' : '。')};
}
async function openRecord(id) {
  const r = mustRecord(id);
  if (r.kind !== 'web') throw Error('此来源尚无经过验证的会话直达入口，可在详情复制来源位置。');
  if (!C.webUrl(r.url)) throw Error('此记录没有有效网址。');
  if (r.binding?.live && r.binding.epoch === epoch) {
    const tab = await chrome.tabs.get(r.binding.tabId).catch(() => null);
    if (tab && C.webUrl(tab.url) === r.url) { await chrome.tabs.update(tab.id, {active: true}); await chrome.windows.update(tab.windowId, {focused: true}); return {}; }
    if (tab) throw Error('网页已跳转，请刷新后再打开。');
  }
  if (r.user.archived && r.connectorId === 'browser') return restore([id]);
  const tab = await chrome.tabs.create({url: r.url, active: true});
  if (r.connectorId === 'browser') await change(next => { C.find(next, id).binding = {epoch, tabId: tab.id, windowId: tab.windowId, live: true}; });
  return {};
}
async function rebind(id, tabId) {
  const record = mustRecord(id);
  if (record.kind !== 'web' || record.connectorId !== 'browser') throw Error('此记录不支持关联浏览器页签。');
  if (record.binding?.live && record.binding.epoch === epoch && record.binding.tabId !== tabId) throw Error('记录仍关联着一个打开的页签，请先核对。');
  const tab = await chrome.tabs.get(tabId);
  if (!actualWeb(tab) || C.webUrl(tab.url) !== record.url) throw Error('所选页签网址与记录不一致，请重新选择。');
  const existing = state.records.find(r => r.id !== id && r.binding?.epoch === epoch && r.binding.tabId === tabId);
  const organized = existing && (existing.user.projectId || existing.user.tags.length || existing.user.alias || existing.user.summaryOverride !== null || existing.user.sourceOverride || existing.user.saved || existing.user.archived || Object.values(existing.user.manual).some(Boolean));
  if (organized) throw Error('所选页签已有整理内容，为避免覆盖，请先处理该记录。');
  return change(next => {
    // Only the user's explicit selection can collapse the temporary observation.
    if (existing) next.records = next.records.filter(r => r.id !== existing.id);
    const x = C.find(next, id); x.binding = {epoch, tabId, windowId: tab.windowId, live: true};
    x.pending = null; x.error = ''; x.user.archived = false; x.user.archivedAt = null; x.user.revision++;
    return {message: '已关联所选页签，保留原记录的整理内容。'};
  });
}
async function migrate(includeGroups) {
  if (state.migration.completed) return {message: '旧数据已经迁移。'};
  const backup = {at: Date.now(), migration: C.copy(state.migration)};
  await chrome.storage.local.set({taskOutMigrationBackup: backup});
  return change(next => {
    const mapping = new Map();
    if (includeGroups) for (const g of next.migration.groups) {
      const p = C.saveProject(next, {name: g.label || '旧分组'}); mapping.set(g.domain, p.id);
      for (const member of g.members || []) {
        const r = next.records.find(r => r.binding?.epoch === epoch && r.binding.tabId === member.id && r.url === member.url);
        if (r) { r.user.projectId = p.id; r.user.manual.projectId = member.manual === true; r.user.revision++; }
      }
    }
    for (const old of next.migration.deferred) {
      if (old.dismissed || !C.webUrl(old.url)) continue;
      const id = 'legacy-saved:' + String(old.id);
      if (C.find(next, id)) continue;
      const r = C.normalizeRecord({id, kind: 'web', connectorId: 'browser', source: {id: 'browser', label: '浏览器', icon: '◎'},
        title: old.title || old.url, url: old.url, updatedAt: old.savedAt, createdAt: null, createdAtBasis: 'unknown', syncedAt: Date.now()});
      r.user.saved = true; r.user.archived = !!old.completed; r.user.archivedAt = old.completedAt || null;
      next.records.push(r);
    }
    next.migration = {...next.migration, pending: false, completed: true};
    return {message: '旧数据已迁移，原始备份已保留。'};
  });
}
async function importData(datasetId, text) {
  const parsed = C.importRecords(datasetId, text);
  if (!parsed.records.length && !parsed.projects.length && !Object.keys(parsed.sourceStyles).length) throw Error(parsed.warnings[0] || '文件中没有有效记录、项目或来源外观。');
  aiJob?.abort();
  return change(next => {
    next.policyRevision = (next.policyRevision || 0) + 1; next.suggestions = [];
    const prior = new Set(next.records.map(r => r.id));
    let addedProjects = 0;
    for (const project of parsed.projects) if (!next.projects.some(p => p.id === project.id)) {
      next.projects.push(C.copy(project)); addedProjects++;
    }
    const count = C.upsert(next, parsed.records);
    for (const record of parsed.records) if (!prior.has(record.id) && record.importUser) {
      C.find(next, record.id).user = C.copy(record.importUser);
    }
    let addedStyles = 0;
    for (const [sourceId, style] of Object.entries(parsed.sourceStyles)) {
      if (Object.prototype.hasOwnProperty.call(next.sourceStyles, sourceId)) {
        parsed.warnings.push(`来源 ${sourceId} 已有自定义外观，保留当前设置。`);
      } else { C.saveSourceStyle(next, {sourceId, ...style}); addedStyles++; }
    }
    return {message: `已新增 ${count} 条，更新 ${parsed.records.length - count} 条记录${addedProjects ? `，恢复 ${addedProjects} 个项目` : ''}${addedStyles ? `，恢复 ${addedStyles} 个来源外观` : ''}`, warnings: parsed.warnings};
  });
}
async function saveModel(message) {
  modelChanging++; aiJob?.abort();
  try {
  // Merge against the latest saved settings inside modelQueue. Empty form
  // fields mean unchanged, including edits submitted by another dashboard.
  const old = await modelConfig(), patch = {};
  for (const field of ['baseUrl', 'model', 'rules']) {
    if (typeof message[field] === 'string' && message[field].trim()) patch[field] = message[field].trim();
  }
  if (typeof message.autoSuggest === 'boolean') patch.autoSuggest = message.autoSuggest;
  if (typeof message.autoOrganize === 'boolean') patch.autoOrganize = message.autoOrganize;
  if (message.maxGroups !== undefined && message.maxGroups !== null && String(message.maxGroups).trim() !== '') {
    if (!['string', 'number'].includes(typeof message.maxGroups)) throw Error('最多分组数需为 1 到 50 的整数。');
    patch.maxGroups = C.groupLimit(Number(message.maxGroups));
  }
  const next = TaskOutSuggestions.normalizeConfig({...old, ...patch});
  if (!next.baseUrl || !next.model) throw Error('首次配置请填写模型服务地址和模型名称；已有配置留空表示不变。');
  const suppliedKey = typeof message.apiKey === 'string' ? message.apiKey.trim() : '';
  if (next.baseUrl !== old.baseUrl && old.apiKey && !suppliedKey && message.forgetKey !== true)
    throw Error('更换模型服务地址时，请填写新 Key 或明确点击“清除 Key”。原配置未修改。');
  const apiKey = message.forgetKey === true ? '' : suppliedKey || old.apiKey;
  await permission(next.baseUrl);
  await chrome.storage.local.set({taskOutModel: {...next, apiKey}});
  // Remove the migrated legacy copy as well, including when switching gateways.
  const {llmConfig} = await chrome.storage.local.get('llmConfig');
  if (llmConfig?.apiKey) await chrome.storage.local.set({llmConfig: {...llmConfig, apiKey: ''}});
  await enqueue(() => change(nextState => {
    invalidateSuggestions(nextState);
    nextState.groupSettings = {maxGroups: C.groupLimit(next.maxGroups ?? 5)};
    nextState.organization = {...nextState.organization, status: next.autoOrganize ? 'idle' : 'paused', message: next.autoOrganize ? '自动整理已开启。' : '自动整理已暂停。', failures: 0, retryAt: 0};
    const plan = C.groupingPlan(nextState, {epoch});
    if (plan.error) nextState.organization = {...nextState.organization, status: 'error', ...plan.error};
  }));
  safeSend({type: 'task-out-updated'}); return {message: '模型设置已保存，尚未进行连接测试。'};
  } finally { modelChanging--; scheduleSuggestions(); }
}
function suggestionSignature(item, config, policyRevision) {
  const input = TaskOutSuggestions.prepare([item], config, groupingProjects(state, config));
  return JSON.stringify([config.baseUrl, config.model, config.rules, config.maxGroups, policyRevision, input]);
}
function groupingPlan(next = state, config = {}) { return C.groupingPlan(next, {epoch, maxGroups: config.maxGroups ?? next.groupSettings?.maxGroups ?? 5}); }
function groupingProjects(next = state, config = {}) {
  const plan = groupingPlan(next, config);
  return plan.groups.filter(project => !plan.overLimit || plan.keepIds.includes(project.id)).map(({id, name, color}) => ({id, name, color}));
}
function groupMergeSignature(next = state, config = {}) {
  return JSON.stringify([config.maxGroups ?? next.groupSettings?.maxGroups ?? 5,
    next.records.filter(record => C.groupScope(record, next, {epoch})).map(record => [record.id, record.user.projectId, C.groupMovable(record)]).sort((a, b) => a[0].localeCompare(b[0]))]);
}
async function runSuggestions(ids, automatic = false, namingOnly = false) {
  if (aiJob) throw Error('正在生成整理建议，请稍后或取消。');
  if (policyChanging || modelChanging) throw Error('来源或模型设置正在更新，请稍后生成建议。');
  const controller = new AbortController(); aiJob = controller;
  try {
    const config = await modelConfig(); await permission(config.baseUrl);
    const snapshot = await enqueue(() => {
      const plan = groupingPlan(state, config);
      if (!namingOnly && plan.error) throw Object.assign(Error(plan.error.message), {code: plan.error.code});
      const groupOnly = !namingOnly && plan.overLimit;
      return {items: state.records.filter(r => ids.includes(r.id) && (!groupOnly || plan.mergeIds.includes(r.id))).map(r => C.publicItem(r, Date.now(), state.connections)),
        projects: namingOnly ? [] : groupingProjects(state, config), groupOnly, allowNewProjects: !groupOnly, policyRevision: state.policyRevision || 0};
    });
    const signatures = new Map(snapshot.items.map(item => [item.id, suggestionSignature(item, config, snapshot.policyRevision)]));
    const result = await TaskOutSuggestions.run({...snapshot, config, apiKey: config.apiKey, signal: controller.signal, namingOnly, ...makeUsageRecorder(), purpose: namingOnly ? 'naming' : 'grouping', trigger: automatic ? 'automatic' : 'manual'});
    if (controller.signal.aborted) throw Error('整理已取消。');
    return await enqueue(() => change(next => {
      if (policyChanging || (next.policyRevision || 0) !== snapshot.policyRevision) throw Error('来源许可已变化，请重新生成建议。');
      const produced = result.suggestions.filter(s => { const record = C.find(next, s.recordId); return record && C.withinHistory(record, next.connections); }).map(s => ({...s, kind: namingOnly ? 'naming' : snapshot.groupOnly ? 'grouping-merge' : 'organize', ...(snapshot.groupOnly ? {allowedProjectIds: snapshot.projects.map(project => project.id)} : {}), observedUpdatedAt: snapshot.items.find(i => i.id === s.recordId)?.updatedAt ?? null,
        contentRevision: snapshot.items.find(i => i.id === s.recordId)?.contentRevision || 0, policyRevision: snapshot.policyRevision}));
      next.suggestions = automatic ? [...next.suggestions.filter(s => !ids.includes(s.recordId)), ...produced] : produced;
      next.suggestionAttempts ||= {};
      for (const [id, signature] of signatures) next.suggestionAttempts[id] = signature;
      next.suggestionExcluded = result.excluded || [];
      return {suggestions: C.copy(next.suggestions), excluded: next.suggestionExcluded};
    }));
  } finally { if (aiJob === controller) aiJob = null; }
}
function organizationStatus(config) {
  const current = state.organization || {};
  const status = organizationJob ? 'running' : !config.baseUrl || !config.model ? 'unconfigured' : current.status === 'error' ? 'error' : config.autoOrganize === false ? 'paused' : current.status === 'running' ? 'idle' : current.status || 'idle';
  return {status, message: status === 'unconfigured' ? '配置模型后会自动整理。' : status === 'paused' ? '自动整理已暂停，可随时手动整理。' : current.message || '', lastApplied: current.lastApplied || 0, lastRunAt: current.lastRunAt || null};
}
function organizationEligible(record, next, automatic, now = Date.now()) {
  if (record.parentId || record.user.archived || record.pending || !C.withinHistory(record, next.connections, now)) return false;
  // Old IndexedDB facts may arrive before the upgraded local service syncs.
  // Wait for naming v3 to repair known transport wrappers before an automatic
  // request can generate and permanently save a name from those old facts.
  if (automatic && record.kind === 'session' && C.historyWindowDays(record, next.connections) !== null && (record.namingVersion || 0) < 3 &&
      [record.firstMessage, record.latestMessage, record.sourceTitle ? '' : record.title].some(text => /^<(?:current_user_request|interrupted_turn_context|command-args)\b/.test(String(text || '').trim()))) return false;
  if (record.kind === 'web') return record.connectorId === 'browser' ? record.binding?.live === true && record.binding.epoch === epoch : !automatic && !!C.webUrl(record.url);
  if (record.kind !== 'session') return false;
  // Local sessions already passed their configured 3/7/30-day window above.
  // Standard imports have no source window; retain their existing automatic
  // recency limit rather than sending arbitrarily old imported history.
  if (!automatic || C.historyWindowDays(record, next.connections) !== null) return true;
  return Number.isFinite(record.updatedAt) && record.updatedAt <= now && record.updatedAt >= now - 3 * 86400000;
}
function sessionGrouped(record, next = state) {
  return record.kind === 'session' && (!!record.user.projectId || !!record.user.manual?.projectId ||
    Object.prototype.hasOwnProperty.call(next.sessionGrouping || {}, record.id) ||
    Object.prototype.hasOwnProperty.call(next.organizationAttempts || {}, record.id));
}
function organizationInput(record, config, next, progressOnly = false) {
  const item = C.publicItem(record, Date.now(), next.connections);
  // Always summarize fresh source evidence, never the previous model output.
  item.summary = record.summary;
  const prepared = progressOnly ? TaskOutSuggestions.prepareProgress([item], config) : TaskOutSuggestions.prepare([item], config, groupingProjects(next, config));
  return {item, input: prepared.included[0]};
}
function organizationSignature(record, config, next = state, progressOnly = false) {
  const {input} = organizationInput(record, config, next, progressOnly);
  const content = input ? {kind: input.kind, title: input.title, url: input.url, summary: input.summary, namingContext: input.namingContext} : null;
  return JSON.stringify([config.baseUrl, config.model, progressOnly ? '' : config.rules, progressOnly ? null : config.maxGroups, content]);
}
function organizationCandidates(config, next = state) {
  const now = Date.now(), seconds = syncInterval(next);
  return next.records.filter(record => {
    if (!organizationEligible(record, next, true, now)) return false;
    const progress = sessionGrouped(record, next);
    if (progress && (!seconds || now - (next.progressUpdatedAt?.[record.id] || 0) < seconds * 1000)) return false;
    if (!organizationInput(record, config, next, progress).input) return false;
    const attempts = progress ? next.progressAttempts : next.organizationAttempts;
    return attempts?.[record.id] !== organizationSignature(record, config, next, progress);
  });
}
function makeUsageRecorder() {
  const requestPrices = new Map();
  return {
    onRequest(event) {
      const pricing = (state.modelPrices || []).find(p => p.baseUrl === event.baseUrl && p.model === event.model) || null;
      requestPrices.set(event.id, C.copy(pricing));
    },
    onUsage: event => enqueue(() => change(next => {
      C.recordUsage(next, event, {pricing: requestPrices.get(event.id) || null});
      requestPrices.delete(event.id);
      return {};
    }))
  };
}
async function mergeExcessGroups(config, controller, automatic, ids) {
  let applied = 0, conflicts = 0;
  const mergedIds = [];
  const selectedIds = new Set(Array.isArray(ids) ? ids : []);
  const budget = automatic ? 100 : selectedIds.size, attempted = new Set();
  for (let processed = 0; processed < budget;) {
    if (controller.signal.aborted) throw new DOMException('整理已取消。', 'AbortError');
    const snapshot = await enqueue(() => {
      const plan = groupingPlan(state, config);
      if (plan.error) throw Object.assign(Error(plan.error.message), {code: plan.error.code});
      if (!plan.overLimit || automatic && state.groupMergeSuppressed === groupMergeSignature(state, config)) return null;
      const records = state.records.filter(record => plan.mergeIds.includes(record.id) && !attempted.has(record.id) && (automatic || selectedIds.has(record.id)) && organizationEligible(record, state, true)).slice(0, Math.min(5, budget - processed));
      if (!records.length) return null;
      return {items: records.map(record => C.publicItem(record, Date.now(), state.connections)), projects: groupingProjects(state, config), policyRevision: state.policyRevision || 0};
    });
    if (!snapshot) break;
    snapshot.items.forEach(item => attempted.add(item.id));
    await enqueue(() => change(next => { next.organization = {...next.organization, status: 'running', message: '正在合并现有分组，保留人工固定归属…'}; }));
    const result = await TaskOutSuggestions.run({...snapshot, config, apiKey: config.apiKey, signal: controller.signal,
      groupOnly: true, allowNewProjects: false, ...makeUsageRecorder(), purpose: 'grouping', trigger: automatic ? 'automatic' : 'manual'});
    if (controller.signal.aborted) throw new DOMException('整理已取消。', 'AbortError');
    const outcome = await enqueue(() => change(next => {
      if (controller.signal.aborted || modelChanging || policyChanging || (next.policyRevision || 0) !== snapshot.policyRevision) throw new DOMException('设置已变化，本次整理已取消。', 'AbortError');
      const produced = result.suggestions.map(s => {
        const item = snapshot.items.find(item => item.id === s.recordId);
        if (!item || Object.keys(s.patch).some(key => !['projectId', 'projectName'].includes(key))) throw Error('合并分组建议只能修改项目归属。');
        return {...s, kind: 'grouping-merge', allowedProjectIds: snapshot.projects.map(project => project.id), observedUpdatedAt: item.updatedAt,
          contentRevision: item.contentRevision || 0, policyRevision: snapshot.policyRevision};
      });
      const previous = next.suggestions; next.suggestions = [...previous, ...produced];
      const appliedResult = C.applySuggestions(next, produced, {maxGroups: config.maxGroups, epoch});
      const changedIds = produced.filter(s => !appliedResult.conflicts.includes(s.recordId)).map(s => s.recordId);
      next.suggestions = previous.filter(s => !changedIds.includes(s.recordId));
      for (const id of changedIds) {
        const record = C.find(next, id);
        next.organizationAttempts[id] = organizationSignature(record, config, next);
        if (record.kind === 'session') next.sessionGrouping[id] = true;
      }
      next.organization = {...next.organization, lastApplied: applied + appliedResult.applied, lastRunAt: Date.now(), failures: 0, retryAt: 0};
      return {...appliedResult, mergedIds: changedIds};
    }));
    applied += outcome.applied; conflicts += outcome.conflicts.length; processed += snapshot.items.length;
    mergedIds.push(...outcome.mergedIds);
  }
  return {applied, conflicts, mergedIds};
}
async function runOrganization(ids, automatic = false, {progressOnly = false} = {}) {
  if (aiJob) {
    if (automatic) return {applied: 0, message: '已有整理正在进行。'};
    throw Error('已有整理正在进行，请稍后重试。');
  }
  if (policyChanging || modelChanging) {
    if (automatic) return {applied: 0, message: '设置正在更新。'};
    throw Error('来源或模型设置正在更新，请稍后重试。');
  }
  const controller = new AbortController(); aiJob = controller; organizationJob = controller;
  let applied = 0, conflicts = 0, continueAutomatic = false;
  const mergedIds = new Set();
  try {
    const config = await modelConfig();
    if (automatic && (!config.autoOrganize || (state.organization.retryAt || 0) > Date.now())) return {applied: 0};
    if (!config.baseUrl || !config.model) {
      await enqueue(() => change(next => { next.organization = {...next.organization, status: 'unconfigured', message: '配置模型后会自动整理。'}; }));
      if (!automatic && !progressOnly) throw Error('请先配置模型服务地址与模型名称。');
      return {applied: 0};
    }
    await permission(config.baseUrl);
    if (controller.signal.aborted) throw new DOMException('整理已取消。', 'AbortError');
    if (!progressOnly) {
      const merged = await mergeExcessGroups(config, controller, automatic, ids);
      applied += merged.applied; conflicts += merged.conflicts;
      merged.mergedIds.forEach(id => mergedIds.add(id));
    }
    const selected = automatic ? organizationCandidates(config).slice(0, 100) : state.records.filter(r => (Array.isArray(ids) ? ids : []).includes(r.id) && !mergedIds.has(r.id));
    // Separate requests make the output contract enforceable: grouped sessions
    // cannot receive project/type/name changes through the progress channel.
    const jobs = [];
    for (const progress of [false, true]) {
      const group = selected.filter(r => (progressOnly || automatic && sessionGrouped(r)) === progress);
      // Missing names add first/latest excerpts and an extra output field.
      // Commit bounded batches so one long or failed reply cannot discard
      // other batches that have already completed.
      const batchSize = !progress && group.some(r => organizationInput(r, config, state).input?.namingContext) ? 5 : 20;
      for (let offset = 0; offset < group.length; offset += batchSize) jobs.push({progress, ids: new Set(group.slice(offset, offset + batchSize).map(r => r.id))});
    }
    await enqueue(() => change(next => { next.organization = {...next.organization, status: 'running', message: progressOnly ? '正在更新会话进展…' : '正在处理新内容与会话进展…'}; }));
    for (const job of jobs) {
      if (controller.signal.aborted) throw new DOMException('整理已取消。', 'AbortError');
      const snapshot = await enqueue(() => {
        const records = state.records.filter(r => job.ids.has(r.id) && organizationEligible(r, state, automatic) &&
          (!job.progress || r.kind === 'session' && state.progressAttempts?.[r.id] !== organizationSignature(r, config, state, true)) && organizationInput(r, config, state, job.progress).input);
        const plan = groupingPlan(state, config);
        if (!job.progress && plan.error) throw Object.assign(Error(plan.error.message), {code: plan.error.code});
        return {items: records.map(r => organizationInput(r, config, state, job.progress).item), projects: job.progress ? [] : groupingProjects(state, config), policyRevision: state.policyRevision || 0,
          signatures: new Map(records.map(r => [r.id, organizationSignature(r, config, state, job.progress)]))};
      });
      const result = await TaskOutSuggestions.run({...snapshot, config, apiKey: config.apiKey, signal: controller.signal,
        progressOnly: job.progress, requireNames: !job.progress, ...makeUsageRecorder(),
        purpose: job.progress ? 'progress' : 'grouping', trigger: automatic ? 'automatic' : 'manual'});
      if (controller.signal.aborted) throw new DOMException('整理已取消。', 'AbortError');
      const batch = await enqueue(() => change(next => {
        if (controller.signal.aborted || modelChanging || policyChanging || (next.policyRevision || 0) !== snapshot.policyRevision)
          throw new DOMException('设置已变化，本次整理已取消。', 'AbortError');
        const produced = result.suggestions.filter(s => { const record = C.find(next, s.recordId); return record && organizationEligible(record, next, automatic); }).map(s => {
          if (job.progress && Object.keys(s.patch).some(key => key !== 'summary')) throw Error('进展更新不能改变项目或类型。');
          const item = snapshot.items.find(item => item.id === s.recordId);
          return {...s, kind: job.progress ? 'progress' : 'organize', observedUpdatedAt: item.updatedAt ?? null, contentRevision: item.contentRevision || 0, policyRevision: snapshot.policyRevision};
        });
        const previous = next.suggestions;
        next.suggestions = [...previous, ...produced];
        const appliedResult = C.applySuggestions(next, produced, {maxGroups: config.maxGroups, epoch});
        const conflicted = new Set(appliedResult.conflicts);
        const appliedIds = new Set(produced.filter(s => !conflicted.has(s.recordId)).map(s => s.recordId));
        next.suggestions = previous.filter(s => !appliedIds.has(s.recordId));
        for (const [id, signature] of snapshot.signatures) {
          const record = C.find(next, id);
          if (!record) continue;
          const current = organizationSignature(record, config, next, job.progress);
          if (conflicted.has(id) || !appliedIds.has(id) && current !== signature) continue;
          if (job.progress) {
            next.progressAttempts[id] = current;
            next.progressUpdatedAt[id] = Date.now();
          } else {
            next.organizationAttempts[id] = current;
            if (record.kind === 'session') {
              next.sessionGrouping[id] = true;
              next.progressAttempts[id] = organizationSignature(record, config, next, true);
              next.progressUpdatedAt[id] = Date.now();
            }
          }
        }
        const count = applied + appliedResult.applied;
        next.organization = {status: 'running', lastApplied: count, lastRunAt: Date.now(), failures: 0, retryAt: 0, message: `已更新 ${count} 条内容，可撤销。`};
        return appliedResult;
      }));
      applied += batch.applied; conflicts += batch.conflicts.length;
    }
    const remainingPlan = groupingPlan(state, config);
    let message = applied ? `${progressOnly ? '已更新进展' : '已整理'} ${applied} 条内容，可撤销。` : conflicts ? '部分内容已变化，已保留新修改。' : '当前内容已检查，无需调整。';
    if (!automatic && !progressOnly && remainingPlan.overLimit) message += ` 当前仍有 ${remainingPlan.groups.length} 个在用分组，上限为 ${remainingPlan.maxGroups}；筛选外或尚未处理的分组未合并。请扩大筛选范围后继续，开启自动整理，或提高上限。`;
    await enqueue(() => change(next => { next.organization = {...next.organization, status: 'idle', message}; }));
    const mergeRemaining = !remainingPlan.error && remainingPlan.overLimit && state.groupMergeSuppressed !== groupMergeSignature(state, config) &&
      remainingPlan.mergeIds.some(id => organizationEligible(C.find(state, id), state, true));
    continueAutomatic = (automatic || progressOnly && config.autoOrganize) && (organizationCandidates(config).length > 0 || applied > 0 && mergeRemaining);
    return {applied, conflicts, message};
  } catch (error) {
    await enqueue(() => change(next => {
      if (controller.signal.aborted || error.name === 'AbortError') {
        next.organization = {...next.organization, status: 'idle', message: '整理已取消，保留已完成的修改。'};
      } else {
        const failures = (next.organization.failures || 0) + 1;
        next.organization = {...next.organization, status: 'error', code: error.code, message: error.message || '整理失败，请检查模型设置。', failures, retryAt: Date.now() + Math.min(30 * 60000, 30000 * 2 ** Math.min(failures - 1, 6))};
      }
    }));
    if (!automatic) throw error;
    return {applied, message: error.message};
  } finally {
    if (aiJob === controller) aiJob = null;
    if (organizationJob === controller) organizationJob = null;
    safeSend({type: 'task-out-updated'});
    if (continueAutomatic) scheduleSuggestions();
  }
}
async function proxyService(message) {
  const modifying = ['POST', 'PATCH', 'DELETE'].includes(message.method) && message.path.startsWith('/v1/connections');
  if (modifying) { policyChanging++; aiJob?.abort(); }
  try {
  const generation = state.bridge.generation;
  const onboardingRevision = state.onboardingRevision;
  if (modifying) await enqueue(() => change(invalidateSuggestions));
  const result = await bridgeRequest(message.path, {method: message.method || 'GET', body: message.body,
    ...(message.path === '/v1/directories/select' ? {timeoutMs: 130000} : {})});
  if (modifying) await enqueue(() => change(next => {
    if (next.bridge.generation !== generation) return;
    if (result.connection?.id) updateConnections(next, [...next.connections.filter(c => c.id !== result.connection.id), result.connection]);
    if (message.method === 'DELETE' && result.removed) updateConnections(next, next.connections.filter(c => c.id !== message.path.split('/').at(-1)));
    if (message.path === '/v1/connections' && result.connection?.enabled && next.onboardingRevision === onboardingRevision) {
      next.onboarding = {step: 'done', draft: null}; next.onboardingRevision++;
    }
  }));
  try {
    const [catalog, connectionList] = await Promise.all([bridgeRequest('/v1/connectors'), bridgeRequest('/v1/connections')]);
    await enqueue(() => change(next => {
      if (next.bridge.generation !== generation) return;
      next.connectors = catalog.connectors || []; updateConnections(next, connectionList.connections || []);
      next.bridge.status = '已连接'; next.bridge.paired = true;
    }));
    if (message.path === '/v1/connections' && message.method === 'POST') await syncService();
  } catch (error) {
    // The requested operation already succeeded. Report a later list/sync
    // failure separately so a saved source is not accidentally added twice.
    return {...result, warning: error.message, code: error.code,
      ...(modifying ? {message: '来源配置已保存；暂未刷新完成，可稍后重新同步。'} : {})};
  }
  return result;
  } finally { if (modifying) { policyChanging--; scheduleSuggestions(); } }
}
async function dispatch(message) {
  await ready;
  const action = message.action;
  // Network calls deliberately run outside the write queue so cancellation/UI remain responsive.
  if (action === 'onboarding-save') return enqueue(() => change(next => {
    if (message.step !== undefined && !ONBOARDING_STEPS.includes(message.step)) throw Error('接入步骤不正确。');
    next.onboarding = {...next.onboarding, ...(message.step !== undefined ? {step: message.step} : {}),
      ...(Object.prototype.hasOwnProperty.call(message, 'draft') ? {draft: onboardingDraft(message.draft)} : {})};
    next.onboardingRevision++;
    return {onboarding: C.copy(next.onboarding)};
  }));
  if (action === 'usage-report') return enqueue(() => ({report: C.usageReport(state, {days: message.days ?? 30})}));
  if (action === 'sync-settings-save') {
    if (!SYNC_INTERVALS.includes(message.intervalSeconds)) throw Error('请选择支持的会话同步频率。');
    // Changing the cadence cancels an old automatic result just like changing
    // other automation controls. Manual refresh remains explicitly available.
    aiJob?.abort();
    const result = await enqueue(() => change(next => {
      next.syncSettings = {intervalSeconds: message.intervalSeconds};
      return {message: message.intervalSeconds ? `会话进展每 ${message.intervalSeconds} 秒检查一次，有变化时更新。` : '会话进展改为手动刷新。'};
    }));
    configureSyncAlarm(); return result;
  }
  if (action === 'pricing-save') return enqueue(() => change(next => {
    const baseUrl = TaskOutSuggestions.endpoint(message.baseUrl), model = C.text(message.model, 200);
    const previous = (next.modelPrices || []).find(p => p.baseUrl === baseUrl && p.model === model);
    const input = {baseUrl, model, currency: message.currency || previous?.currency || 'CNY'};
    for (const field of ['inputPerMillion', 'outputPerMillion', 'cachedInputPerMillion']) {
      const value = message[field];
      input[field] = value === undefined || value === null || typeof value === 'string' && !value.trim()
        ? previous?.[field] ?? null : typeof value === 'string' ? Number(value) : value;
    }
    const pricing = C.saveModelPricing(next, input);
    return {pricing, message: '模型单价已保存，用于后续调用的费用估算。'};
  }));
  if (action === 'progress-refresh') {
    await enqueue(reconcileTabs);
    const synced = await syncService();
    const ids = state.records.filter(r => sessionGrouped(r) && organizationEligible(r, state, true)).map(r => r.id);
    const result = await runOrganization(ids, false, {progressOnly: true});
    return {...synced, ...result, message: result.applied ? result.message : '会话进展已刷新，原分组与类型保留。'};
  }
  if (action === 'ai-preview') return runSuggestions(message.ids || []);
  if (action === 'organize-now') return runOrganization(message.ids || []);
  if (action === 'name-preview') return runSuggestions(message.ids || [], false, true);
  if (action === 'ai-cancel') { if (aiJob) aiJob.abort(); else await enqueue(() => change(next => { next.suggestions = []; next.suggestionExcluded = []; })); return {message: '整理已取消，原记录保持不变。'}; }
  if (action === 'model-save') {
    const job = modelQueue.then(() => saveModel(message)); modelQueue = job.catch(() => {}); return job;
  }
  if (action === 'model-test') {
    const cfg = await modelConfig(); await permission(cfg.baseUrl);
    await TaskOutSuggestions.testConnection({config: cfg, apiKey: cfg.apiKey, ...makeUsageRecorder()});
    return {message: '模型连接与示例分类测试通过（仅使用虚构数据，不代表所有真实内容的分类效果）。'};
  }
  if (action === 'pair') {
    const operation = serviceQueue.then(async () => {
    policyChanging++; aiJob?.abort();
    try {
    const url = bridgeUrl(message.url), result = await bridgeRequest('/pair', {method: 'POST', body: {code: message.code}, url, code: message.code});
    if (typeof result.token !== 'string' || !result.token) throw Error('服务未返回有效配对凭据。');
    await chrome.storage.local.set({taskOutBridge: {url, token: result.token}});
    await enqueue(() => change(next => { invalidateSuggestions(next); next.connections = []; next.connectors = []; policies(next, []); next.bridge = {url, generation: crypto.randomUUID(), paired: true, status: '已配对'}; next.onboarding = {...next.onboarding, step: 'discover'}; }));
    if (syncJob) await syncJob.catch(() => {});
    // Pairing has already committed its credential. A later scan failure must
    // not ask the user to reuse the consumed one-time code.
    try { await syncService(); return {paired: true, message: '配对成功。服务重启后无需再次配对。'}; }
    catch (error) { return {paired: true, warning: error.message, code: error.code, message: '配对已保存；暂未读取来源，请在下一步重新检测。'}; }
    } finally { policyChanging--; }
    }); serviceQueue = operation.catch(() => {}); return operation;
  }
  if (action === 'service') {
    const request = serviceQueue.then(() => proxyService(message)); serviceQueue = request.catch(() => {}); return request;
  }
  if (action === 'service-status' || action === 'service-stop') {
    const request = serviceQueue.then(() => action === 'service-stop' ? stopService() : serviceStatus());
    serviceQueue = request.catch(() => {}); return request;
  }
  if (action === 'refresh') { await enqueue(reconcileTabs); return syncService(); }
  if (action === 'record-detail') {
    let record = mustRecord(message.id);
    const generation = state.bridge.generation;
    if (record.connectorId !== 'browser' && record.connectorId !== 'standard-import' && state.bridge.paired) {
      try { const result = await bridgeRequest('/v1/records/' + encodeURIComponent(record.id)); if (result.record) await enqueue(() => change(next => { if (next.bridge.generation !== generation) return; C.upsert(next, [result.record]); policies(next, next.connections); })); } catch {}
    }
    return enqueue(() => ({item: C.publicItem(mustRecord(message.id), Date.now(), state.connections), children: state.records.filter(r => r.parentId === message.id).map(r => C.publicItem(r, Date.now(), state.connections))}));
  }
  return enqueue(async () => {
    if (action === 'snapshot') return publicSnapshot();
    if (action === 'open') return openRecord(message.id);
    if (action === 'archive') return archive(message.ids || []);
    if (action === 'restore') return restore(message.ids || []);
    if (action === 'browser-candidates') {
      const record = mustRecord(message.id);
      return {tabs: (await chrome.tabs.query({})).filter(t => actualWeb(t) && C.webUrl(t.url) === record.url).map(t => ({tabId: t.id, windowId: t.windowId, title: t.title || t.url, url: t.url}))};
    }
    if (action === 'record-rebind') return rebind(message.id, message.tabId);
    if (action === 'restore-reset') return change(next => {
      const r = C.find(next, message.id); if (r?.pending?.type !== 'restore') throw Error('没有需要核对的恢复操作。');
      r.pending = null; r.error = ''; return {message: '已清除未确认操作，可重新恢复。'};
    });
    if (action === 'undo') return undoAction();
    if (action === 'migration-apply') return migrate(message.includeGroups !== false);
    if (action === 'import-preview') return {preview: C.importRecords(message.datasetId, message.text)};
    if (action === 'import-apply') return importData(message.datasetId, message.text);
    if (action === 'export') {
      if (message.mode === 'config') return {data: {format: 'task-out-config', version: 2,
        connections: state.connections.map(c => ({connectorId: c.connectorId, name: '我的来源', root: '', historyDays: c.historyDays, enabled: false, allowAI: false, includeSummary: false, includeNaming: false})),
        model: {baseUrl: '', model: '', rules: '', maxGroups: 5, autoSuggest: false, autoOrganize: true}}};
      return {data: {format: 'task-out-records', version: 2, projects: C.copy(state.projects), sourceStyles: C.copy(state.sourceStyles), records: state.records.map(r => {
        const {binding, pending, error, observations, ...rest} = C.copy(r); return rest;
      })}};
    }
    return change(next => {
      if (action === 'source-style-save') return {sourceStyle: C.saveSourceStyle(next, {sourceId: message.sourceId, icon: message.icon, color: message.color}), message: '来源外观已保存。'};
      if (action === 'source-style-reset') return {removed: C.resetSourceStyle(next, message.sourceId), message: '已恢复来源默认外观。'};
      if (action === 'project-save') return {project: C.saveProject(next, message), message: '项目已保存。'};
      if (action === 'project-delete') {
        if (next.records.some(r => r.user.projectId === message.id)) throw Error('只能删除空项目，请先移动其内容（包括归档）。');
        next.projects = next.projects.filter(p => p.id !== message.id); return {message: '空项目已删除。'};
      }
      if (action === 'record-edit') {
        const entry = C.userPatch(next, message.id, message.patch || {}); C.pushUndo(next, [entry], '编辑内容'); return {message: '修改已保存。'};
      }
      if (action === 'bookmark') {
        const r = C.find(next, message.id); if (!r) throw Error('记录不存在。');
        const before = C.copy(r.user); r.user.saved = !r.user.saved; r.user.revision++;
        C.pushUndo(next, [{id: r.id, before, after: C.copy(r.user)}], '稍后查看'); return {message: r.user.saved ? '已加入稍后查看。' : '已移出稍后查看。'};
      }
      if (action === 'ai-apply') { if (policyChanging || modelChanging) throw Error('来源或模型设置正在更新，请稍后应用。'); return C.applySuggestions(next, message.suggestions || [], {epoch}); }
      if (action === 'migration-skip') { next.migration.skipped = true; next.migration.pending = false; return {message: '已保留旧数据，暂不迁移。'}; }
      throw Error('不支持的操作。');
    });
  });
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== 'task-out') return;
  if (sender.id !== chrome.runtime.id || (sender.url && !sender.url.startsWith(chrome.runtime.getURL('')))) { reply({ok: false, error: '未授权的调用来源。'}); return; }
  dispatch(message).then(result => reply({ok: true, ...result}), e => reply({ok: false, error: e.message || '操作未完成。', ...(e.code ? {code: e.code} : {})}));
  return true;
});
function scheduleSuggestions(delay = 1500) {
  clearTimeout(scheduleTimer);
  scheduleTimer = setTimeout(async () => {
    try {
      await ready; const config = await modelConfig();
      if (!config.autoOrganize || !config.baseUrl || !config.model || aiJob || modelChanging || policyChanging || (state.organization.retryAt || 0) > Date.now()) return;
      await runOrganization([], true);
    } catch (error) {
      // Normal model/network failures are persisted by runOrganization. This
      // path covers setup failures before that operation could start.
      await enqueue(() => change(next => { next.organization = {...next.organization, status: 'error', message: error.message || '自动整理暂不可用。'}; })).catch(() => {});
    }
  }, typeof delay === 'number' ? delay : 1500);
  scheduleTimer?.unref?.();
}
function scheduleTabs() { enqueue(reconcileTabs).then(scheduleSuggestions).catch(() => {}); }
chrome.tabs.onCreated.addListener(scheduleTabs);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url || info.title || info.status === 'complete') scheduleTabs(); });
chrome.tabs.onRemoved.addListener((tabId, info) => {
  enqueue(async () => {
    // A closing window may be browser shutdown; keep snapshots detached instead of guessing.
    await change(next => {
      const r = next.records.find(r => r.binding?.epoch === epoch && r.binding.tabId === tabId);
      if (!r) return;
      r.binding.live = false;
      if (!info.isWindowClosing && !r.pending && !r.user.archived) { r.user.archived = true; r.user.archivedAt = Date.now(); r.user.archivedActivityAt = r.updatedAt; r.user.revision++; }
    });
    await badge();
  }).catch(() => {});
});
chrome.tabs.onActivated.addListener(({tabId}) => {
  enqueue(async () => {
    const recency = (await chrome.storage.session.get('tabRecency')).tabRecency || {};
    recency[tabId] = Date.now(); await chrome.storage.session.set({tabRecency: recency}); await reconcileTabs();
  }).catch(() => {});
});
chrome.windows.onFocusChanged.addListener(windowId => { if (windowId >= 0) scheduleTabs(); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'task-out-sync') return;
  // A persisted alarm can wake the worker before IndexedDB has loaded.
  ready.then(() => { if (syncInterval(state)) return syncService(true).then(scheduleSuggestions); }).catch(() => {});
});
chrome.runtime.onStartup.addListener(scheduleTabs);
chrome.runtime.onInstalled.addListener(scheduleTabs);
chrome.action.onClicked?.addListener(() => {
  enqueue(async () => {
    const url = chrome.runtime.getURL('index.html');
    const existing = (await chrome.tabs.query({})).find(tab => tab.url === url);
    if (existing) { await chrome.tabs.update(existing.id, {active: true}); await chrome.windows.update(existing.windowId, {focused: true}); }
    else await chrome.tabs.create({url, active: true});
  }).catch(() => {});
});
