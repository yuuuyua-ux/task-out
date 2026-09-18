'use strict';
/* Shared, side-effect-free record and organisation rules. */
const TaskOutCore = (() => {
  const copy = value => structuredClone(value);
  const COLORS = ['#89a477', '#c5a878', '#8aa4b5', '#b299b4', '#ca9582', '#93ada1'];
  const SOURCE_COLORS = ['#2563eb', '#7c3aed', '#db2777', '#c2410c', '#a16207', '#15803d', '#0f766e', '#b91c1c'];
  const SOURCE_ICONS = ['', 'web', 'session', 'terminal', 'folder', 'code', 'sparkles'];
  const TYPE_LABELS = ['调研分析', '需求规划', '方案设计', '开发实现', '测试排障', '文档整理', '使用咨询'];
  const TYPE_ALIASES = new Map([
    ...['产品调研', '功能探索', '竞品分析', '调研'].map(value => [value, '调研分析']),
    ...['产品规划', 'prd', '需求文档', '需求分析'].map(value => [value, '需求规划']),
    ...['产品设计', '信息架构梳理', '原型', '原型设计'].map(value => [value, '方案设计']),
    ...['开发', '编程', '代码实现'].map(value => [value, '开发实现']),
    ...['测试', '排障', '调试', 'bug修复'].map(value => [value, '测试排障']),
    ...['知识库梳理', '文档生成', '文档'].map(value => [value, '文档整理']),
    ...['使用教程', '操作咨询'].map(value => [value, '使用咨询'])
  ]);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  const time = value => Number.isFinite(value) && value > 0 ? value : null;
  const uid = prefix => prefix + crypto.randomUUID();
  function initial() {
    return {version: 2, projects: [], records: [], connections: [], connectors: [], sourceStyles: {},
      usage: {version: 1, firstRecordedAt: null, lastRecordedAt: null, daily: [], recent: [], seen: []}, modelPrices: [],
      bridge: {url: 'http://127.0.0.1:4518', paired: false, status: '未连接'},
      suggestions: [], suggestionExcluded: [], undo: [], policyRevision: 0,
      organization: {status: 'idle', lastApplied: 0, lastRunAt: null}, organizationAttempts: {},
      migration: {completed: false, skipped: false, pending: false, groups: [], deferred: []}};
  }
  function webUrl(value) {
    try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; }
    catch { return ''; }
  }
  function validSourceId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
  }
  function validSourceStyle(value) {
    return plainObject(value) && Object.keys(value).every(key => ['icon', 'color'].includes(key)) &&
      own(value, 'icon') && SOURCE_ICONS.includes(value.icon) && own(value, 'color') && typeof value.color === 'string' && /^#[0-9a-f]{6}$/i.test(value.color);
  }
  function sourceAppearance(state, item = {}) {
    const candidate = item.sourceId || item.source?.id || 'unknown';
    const sourceId = typeof candidate === 'string' && candidate ? candidate : 'unknown';
    const suppliedIcon = item.sourceIcon || item.source?.icon;
    const safeIcon = typeof suppliedIcon === 'string' && suppliedIcon.length <= 8 &&
      /^[\p{L}\p{N}\p{S}\p{M}_\-\u200d]+$/u.test(suppliedIcon) && !/[<>&"'`\\]/.test(suppliedIcon);
    const defaultIcon = safeIcon ? suppliedIcon : item.kind === 'web' ? 'web' : 'session';
    let hash = 2166136261;
    for (let i = 0; i < sourceId.length; i++) hash = Math.imul(hash ^ sourceId.charCodeAt(i), 16777619) >>> 0;
    const styles = state?.sourceStyles;
    const custom = plainObject(styles) && own(styles, sourceId) && validSourceStyle(styles[sourceId]) ? styles[sourceId] : null;
    return {icon: custom?.icon || defaultIcon, color: custom ? custom.color.toLowerCase() : SOURCE_COLORS[hash % SOURCE_COLORS.length]};
  }
  function saveSourceStyle(state, input) {
    if (!plainObject(input) || !['sourceId', 'icon', 'color'].every(key => own(input, key)) || Object.keys(input).some(key => !['sourceId', 'icon', 'color'].includes(key)) || !validSourceId(input.sourceId)) throw Error('来源标识格式不正确。');
    const style = {icon: input.icon, color: input.color};
    if (!validSourceStyle(style)) throw Error('请选择支持的来源图标和完整的六位十六进制颜色。');
    if (!plainObject(state.sourceStyles)) state.sourceStyles = {};
    const saved = {icon: style.icon, color: style.color.toLowerCase()};
    // A source ID is data, including __proto__ or constructor. Never assign
    // through the inherited setter or look up inherited object properties.
    Object.defineProperty(state.sourceStyles, input.sourceId, {value: saved, enumerable: true, writable: true, configurable: true});
    return copy(saved);
  }
  function resetSourceStyle(state, sourceId) {
    if (!validSourceId(sourceId)) throw Error('来源标识格式不正确。');
    if (!plainObject(state.sourceStyles) || !own(state.sourceStyles, sourceId)) return false;
    delete state.sourceStyles[sourceId]; return true;
  }
  const USAGE_DAYS = 120, USAGE_RECENT = 100, TOKEN_LIMIT = 1000000000;
  const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens'];
  const CURRENCIES = ['CNY', 'USD', 'EUR'];
  function modelEndpoint(value) {
    let url;
    try { if (typeof value !== 'string') throw Error(); url = new URL(value); } catch { throw Error('模型服务地址格式不正确。'); }
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
        url.username || url.password || url.search || url.hash || url.href.length > 4096) throw Error('模型服务地址须为 HTTPS 或本机 HTTP，不包含账号、查询参数或锚点。');
    return url.href.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  }
  function modelIdentity(input) {
    if (!plainObject(input) || !own(input, 'baseUrl') || !own(input, 'model') || typeof input.model !== 'string' ||
        !input.model.trim() || input.model.length > 200 || /[\u0000-\u001f\u007f]/.test(input.model)) throw Error('请填写有效模型服务地址和模型名称。');
    return {baseUrl: modelEndpoint(input.baseUrl), model: input.model.trim()};
  }
  function priceValue(value) {
    if (value === null || value === undefined || typeof value === 'string' && !value.trim()) return null;
    if (!['number', 'string'].includes(typeof value) || typeof value === 'string' && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) throw Error('单价须为非负数字，未填写请留空。');
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 1000000) throw Error('每百万 Token 单价须在 0–1000000 之间。');
    return number;
  }
  function saveModelPricing(state, input) {
    const identity = modelIdentity(input);
    if (!own(input, 'currency') || !CURRENCIES.includes(input.currency)) throw Error('币种仅支持 CNY、USD 或 EUR。');
    const price = {...identity, currency: input.currency,
      inputPerMillion: priceValue(own(input, 'inputPerMillion') ? input.inputPerMillion : null),
      outputPerMillion: priceValue(own(input, 'outputPerMillion') ? input.outputPerMillion : null),
      cachedInputPerMillion: priceValue(own(input, 'cachedInputPerMillion') ? input.cachedInputPerMillion : null), updatedAt: Date.now()};
    if (!Array.isArray(state.modelPrices)) state.modelPrices = [];
    state.modelPrices = state.modelPrices.filter(p => p.baseUrl !== identity.baseUrl || p.model !== identity.model);
    state.modelPrices.push(price);
    return copy(price);
  }
  const localDay = at => { const date = new Date(at); date.setHours(0, 0, 0, 0); return date.getTime(); };
  function previousDay(at, days) { const date = new Date(localDay(at)); date.setDate(date.getDate() - days); return date.getTime(); }
  function dayName(at) { const date = new Date(at); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
  const tokenValue = value => Number.isSafeInteger(value) && value >= 0 && value <= TOKEN_LIMIT ? value : null;
  function usageMetrics() {
    return {requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0,
      known: {inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0},
      unknownUsageRequests: 0, unpricedRequests: 0, costPartialRequests: 0, estimatedCosts: {}};
  }
  function addMetrics(target, source) {
    for (const field of ['requests', 'unknownUsageRequests', 'unpricedRequests', 'costPartialRequests', ...TOKEN_FIELDS]) target[field] += source[field];
    for (const field of TOKEN_FIELDS) target.known[field] += source.known[field];
    for (const currency of CURRENCIES) if (own(source.estimatedCosts, currency)) target.estimatedCosts[currency] = (target.estimatedCosts[currency] || 0) + source.estimatedCosts[currency];
  }
  function publicMetrics(metrics) {
    const output = {requests: metrics.requests};
    for (const field of TOKEN_FIELDS) output[field] = metrics.known[field] || !metrics.requests ? metrics[field] : null;
    Object.assign(output, {unknownUsageRequests: metrics.unknownUsageRequests, unpricedRequests: metrics.unpricedRequests,
      costPartialRequests: metrics.costPartialRequests, estimatedCosts: {...metrics.estimatedCosts},
      partial: !!(metrics.unknownUsageRequests || metrics.unpricedRequests || metrics.costPartialRequests)});
    return output;
  }
  function recordUsage(state, input, options = {}) {
    const identity = modelIdentity(input), now = Date.now();
    if (!own(input, 'id') || typeof input.id !== 'string' || !input.id.trim() || input.id.length > 200 || /[\u0000-\u001f\u007f]/.test(input.id) ||
        !own(input, 'at') || !Number.isSafeInteger(input.at) || input.at <= 0 || input.at > now) throw Error('用量记录缺少有效身份或时间。');
    const cutoff = previousDay(now, USAGE_DAYS - 1);
    if (input.at < cutoff) return {recorded: false, reason: 'outside-retention'};
    const ledger = state.usage?.version === 1 ? state.usage : {version: 1, firstRecordedAt: null, lastRecordedAt: null, daily: [], recent: [], seen: []};
    if (ledger.seen.some(entry => entry.id === input.id)) return {recorded: false, reason: 'duplicate'};
    const event = {id: input.id, at: input.at, ...identity,
      purpose: own(input, 'purpose') && ['grouping', 'progress', 'naming', 'test'].includes(input.purpose) ? input.purpose : 'grouping',
      trigger: own(input, 'trigger') && input.trigger === 'automatic' ? 'automatic' : 'manual',
      status: own(input, 'status') && ['response', 'error', 'cancelled'].includes(input.status) ? input.status : 'response',
      recordCount: tokenValue(own(input, 'recordCount') ? input.recordCount : null),
      attempt: own(input, 'attempt') && Number.isSafeInteger(input.attempt) && input.attempt >= 0 && input.attempt <= 100 ? input.attempt : null};
    for (const field of TOKEN_FIELDS) event[field] = tokenValue(own(input, field) ? input[field] : null);
    if (event.inputTokens !== null && event.outputTokens !== null) {
      const sum = event.inputTokens + event.outputTokens;
      if (event.totalTokens === null) event.totalTokens = sum;
      else if (event.totalTokens < sum) event.totalTokens = null;
    }
    if (event.cachedInputTokens !== null && (event.inputTokens === null || event.cachedInputTokens > event.inputTokens)) event.cachedInputTokens = null;
    if (!plainObject(options) || Object.keys(options).some(key => key !== 'pricing')) throw Error('请求单价快照格式不正确。');
    const configured = own(options, 'pricing') ? options.pricing : (Array.isArray(state.modelPrices) ? state.modelPrices : []).find(p => p.baseUrl === identity.baseUrl && p.model === identity.model);
    event.pricing = null;
    if (configured !== null && configured !== undefined) {
      if (!plainObject(configured) || Object.keys(configured).some(key => !['baseUrl', 'model', 'currency', 'inputPerMillion', 'outputPerMillion', 'cachedInputPerMillion', 'updatedAt'].includes(key))) throw Error('请求单价快照格式不正确。');
      const pricedIdentity = modelIdentity(configured);
      if (pricedIdentity.baseUrl !== identity.baseUrl || pricedIdentity.model !== identity.model || !own(configured, 'currency') || !CURRENCIES.includes(configured.currency)) throw Error('请求单价快照与模型身份不一致。');
      event.pricing = {currency: configured.currency,
        inputPerMillion: priceValue(own(configured, 'inputPerMillion') ? configured.inputPerMillion : null),
        outputPerMillion: priceValue(own(configured, 'outputPerMillion') ? configured.outputPerMillion : null),
        cachedInputPerMillion: priceValue(own(configured, 'cachedInputPerMillion') ? configured.cachedInputPerMillion : null)};
    }
    event.currency = event.pricing?.currency || null; event.cost = null; event.costPartial = false;
    const price = event.pricing;
    if (price && CURRENCIES.includes(price.currency) && event.inputTokens !== null && event.outputTokens !== null &&
        typeof price.inputPerMillion === 'number' && Number.isFinite(price.inputPerMillion) && price.inputPerMillion >= 0 && price.inputPerMillion <= 1000000 &&
        typeof price.outputPerMillion === 'number' && Number.isFinite(price.outputPerMillion) && price.outputPerMillion >= 0 && price.outputPerMillion <= 1000000) {
      const cached = event.cachedInputTokens || 0;
      const cachePriceKnown = typeof price.cachedInputPerMillion === 'number' && Number.isFinite(price.cachedInputPerMillion) && price.cachedInputPerMillion >= 0 && price.cachedInputPerMillion <= 1000000;
      const cachedRate = cachePriceKnown ? price.cachedInputPerMillion : price.inputPerMillion;
      event.cost = ((event.inputTokens - cached) * price.inputPerMillion + cached * cachedRate + event.outputTokens * price.outputPerMillion) / 1000000;
      event.costPartial = event.cachedInputTokens === null || cached > 0 && !cachePriceKnown;
    }
    const metrics = usageMetrics(); metrics.requests = 1;
    for (const field of TOKEN_FIELDS) if (event[field] !== null) { metrics[field] = event[field]; metrics.known[field] = 1; }
    metrics.unknownUsageRequests = ['inputTokens', 'outputTokens', 'totalTokens'].some(field => event[field] === null) ? 1 : 0;
    metrics.unpricedRequests = event.cost === null ? 1 : 0;
    metrics.costPartialRequests = event.costPartial ? 1 : 0;
    if (event.cost !== null) metrics.estimatedCosts[event.currency] = event.cost;
    const startAt = localDay(event.at);
    let day = ledger.daily.find(day => day.startAt === startAt);
    if (!day) { day = {date: dayName(startAt), startAt, models: []}; ledger.daily.push(day); }
    let model = day.models.find(model => model.baseUrl === identity.baseUrl && model.model === identity.model);
    if (!model) { model = {...identity, metrics: usageMetrics()}; day.models.push(model); }
    addMetrics(model.metrics, metrics);
    ledger.daily = ledger.daily.filter(day => day.startAt >= cutoff).sort((a, b) => a.startAt - b.startAt);
    ledger.seen = ledger.seen.filter(entry => entry.at >= cutoff); ledger.seen.push({id: event.id, at: event.at});
    ledger.recent = [...ledger.recent.filter(entry => entry.at >= cutoff), event].sort((a, b) => b.at - a.at).slice(0, USAGE_RECENT);
    ledger.firstRecordedAt = Math.min(ledger.firstRecordedAt || event.at, event.at);
    ledger.lastRecordedAt = Math.max(ledger.lastRecordedAt || event.at, event.at);
    state.usage = ledger;
    return {recorded: true, event: copy(event)};
  }
  function usageReport(state, {days = 30, now = Date.now()} = {}) {
    if (![1, 7, 30].includes(days) || !Number.isSafeInteger(now) || now <= 0 || !Number.isFinite(new Date(now).getTime())) throw Error('用量范围仅支持今天、近 7 天或近 30 天。');
    const from = previousDay(now, days - 1), today = localDay(now), ledger = state.usage?.version === 1 ? state.usage : {daily: [], recent: [], firstRecordedAt: null};
    const collect = start => {
      const total = usageMetrics(), models = new Map(), daily = [];
      for (const day of ledger.daily.filter(day => day.startAt >= start && day.startAt <= today)) {
        const sum = usageMetrics();
        for (const entry of day.models) {
          const key = JSON.stringify([entry.baseUrl, entry.model]);
          if (!models.has(key)) models.set(key, {baseUrl: entry.baseUrl, model: entry.model, metrics: usageMetrics()});
          addMetrics(models.get(key).metrics, entry.metrics); addMetrics(sum, entry.metrics);
        }
        addMetrics(total, sum); daily.push({date: day.date, ...publicMetrics(sum)});
      }
      return {totals: publicMetrics(total), models: [...models.values()].map(({metrics, ...identity}) => ({...identity, ...publicMetrics(metrics)})), daily: daily.sort((a, b) => a.date.localeCompare(b.date))};
    };
    const report = collect(from), firstRecordedAt = ledger.firstRecordedAt || null;
    const forecastFrom = previousDay(now, 6), basisFrom = Math.max(forecastFrom, firstRecordedAt || now), basisDays = Math.max(0, (now - basisFrom) / 86400000);
    const basis = collect(forecastFrom).totals, available = basisDays >= 1;
    const forecast = {available, days: 30, basisDays, basisRequests: basis.requests, partial: basis.partial, totals: null,
      reason: available ? '根据最近最多 7 天的已记录使用量日均推算，仅为估算。' : '累计记录不足 24 小时，暂不预测。'};
    if (available) {
      const factor = 30 / basisDays;
      forecast.totals = {...basis, estimatedCosts: Object.fromEntries(Object.entries(basis.estimatedCosts).map(([currency, amount]) => [currency, amount * factor]))};
      for (const field of ['requests', ...TOKEN_FIELDS, 'unknownUsageRequests', 'unpricedRequests', 'costPartialRequests']) forecast.totals[field] = basis[field] === null ? null : basis[field] * factor;
    }
    return {days, from, to: now, firstRecordedAt, ...report,
      recent: copy(ledger.recent.filter(event => event.at >= from && event.at <= now).slice(0, USAGE_RECENT)), forecast,
      pricing: copy(Array.isArray(state.modelPrices) ? state.modelPrices : [])};
  }
  function defaultUser() {
    return {projectId: null, tags: [], alias: '', sessionName: '', summaryOverride: null, sourceOverride: null,
      legacyTypeTags: [],
      archived: false, saved: false, archivedAt: null, archivedActivityAt: null, revision: 0,
      manual: {projectId: false, tags: false, summary: false}};
  }
  function normalizeTypeTags(tags) {
    if (!Array.isArray(tags)) return [];
    const strings = tags.filter(value => typeof value === 'string').map(value => value.trim());
    const exact = strings.find(value => TYPE_LABELS.includes(value));
    if (exact) return [exact];
    for (const value of strings) {
      const mapped = TYPE_ALIASES.get(value) || (/^prd$/i.test(value) ? '需求规划' : undefined);
      if (mapped) return [mapped];
    }
    return [];
  }
  function normalizeTypes(state) {
    let changed = 0, backedUp = 0;
    for (const record of state.records || []) {
      if (!record.user) continue;
      const previous = Array.isArray(record.user.tags) ? record.user.tags : [];
      const normalized = normalizeTypeTags(previous);
      if (JSON.stringify(previous) === JSON.stringify(normalized)) continue;
      if (!Array.isArray(record.user.legacyTypeTags) || !record.user.legacyTypeTags.length) {
        record.user.legacyTypeTags = previous.filter(value => typeof value === 'string'); backedUp++;
      }
      record.user.tags = normalized;
      record.user.revision = (Number.isSafeInteger(record.user.revision) ? record.user.revision : 0) + 1;
      changed++;
    }
    return {changed, backedUp};
  }
  function normalizeRecord(input) {
    if (!input || typeof input !== 'object' || !['web', 'session'].includes(input.kind)) throw Error('记录类型必须为 web 或 session。');
    const id = text(input.id, 600);
    if (!id) throw Error('记录缺少稳定标识。');
    const source = input.source || {};
    return {
      id, kind: input.kind, originId: text(input.originId || id, 600), connectorId: text(input.connectorId || 'import', 100),
      source: {id: text(source.id || 'unknown', 160), label: text(source.label || '来源待识别', 80), icon: text(source.icon || '◇', 8)},
      title: text(input.title || '未命名会话', 500), url: webUrl(input.url),
      sourceTitle: input.kind === 'session' ? text(input.sourceTitle ?? (input.titleBasis ? '' : input.title), 500) : '',
      namingVersion: Number.isSafeInteger(input.namingVersion) && input.namingVersion > 0 ? input.namingVersion : 0,
      titleBasis: text(input.titleBasis || (input.kind === 'web' ? 'browser-title' : input.title ? 'source-title' : 'unknown'), 100),
      firstMessage: input.kind === 'session' ? text(input.firstMessage, 1200) : '',
      latestMessage: input.kind === 'session' ? text(input.latestMessage, 1200) : '',
      createdAt: time(input.createdAt), createdAtBasis: text(input.createdAtBasis || 'unknown', 100),
      earliestActivityAt: time(input.earliestActivityAt), updatedAt: time(input.updatedAt), syncedAt: time(input.syncedAt),
      status: ['running', 'waiting', 'ended', 'error', 'unknown', 'open'].includes(input.status) ? input.status : 'unknown',
      statusLive: input.statusLive === true, statusObservedAt: time(input.statusObservedAt),
      summary: text(input.summary, 2500), next: text(input.next, 1000),
      timeline: Array.isArray(input.timeline) ? input.timeline.filter(t => t && text(t.text)).slice(-30).map(t => ({text: text(t.text, 1500), at: time(t.at)})) : [],
      parentId: text(input.parentId, 600) || null, locator: text(input.locator, 2000),
      capabilities: {history: input.capabilities?.history === true, open: input.capabilities?.open === true && !!webUrl(input.url)},
      observations: Array.isArray(input.observations) ? input.observations.filter(o => o && text(o.connectionId)).map(o => ({connectionId: text(o.connectionId, 200), allowAI: o.allowAI === true, includeSummary: o.includeSummary === true, includeNaming: o.includeNaming === true,
        ...(o.historyDays !== undefined ? {historyDays: [3, 7, 30].includes(o.historyDays) ? o.historyDays : 30} : {})})) : [],
      user: defaultUser(), binding: null, pending: null, error: '', contentRevision: 0
    };
  }
  const find = (state, id) => state.records.find(r => r.id === id);
  function upsert(state, inputs) {
    let inserted = 0;
    for (const input of inputs) {
      const next = normalizeRecord(input), old = find(state, next.id);
      if (!old) { state.records.push(next); inserted++; continue; }
      if (old.kind !== next.kind) throw Error('同一记录标识不能改变内容类型。');
      const observations = new Map(old.observations.map(o => [o.connectionId, o]));
      next.observations.forEach(o => observations.set(o.connectionId, o));
      const late = next.updatedAt ? (!old.updatedAt || next.updatedAt >= old.updatedAt) : !old.updatedAt;
      const facts = late ? next : {...old, source: next.source, locator: next.locator || old.locator};
      const contentKeys = ['title', 'sourceTitle', 'titleBasis', 'namingVersion', 'firstMessage', 'latestMessage', 'url', 'summary', 'next', 'updatedAt', 'timeline'];
      const changed = contentKeys.some(key => JSON.stringify(old[key]) !== JSON.stringify(facts[key]));
      const contentRevision = (old.contentRevision || 0) + (changed ? 1 : 0);
      Object.assign(old, facts, {user: old.user, binding: old.binding, pending: old.pending, error: old.error,
        contentRevision,
        observations: [...observations.values()], syncedAt: Math.max(old.syncedAt || 0, next.syncedAt || 0) || null,
        createdAt: old.createdAt || next.createdAt, createdAtBasis: old.createdAt ? old.createdAtBasis : next.createdAtBasis});
    }
    return inserted;
  }
  function historyWindowDays(record, connections = []) {
    if (record.kind !== 'session' || ['standard-import', 'import'].includes(record.connectorId)) return null;
    const configs = new Map(connections.map(c => [c.id, c]));
    const windows = (record.observations || []).filter(o => !o.connectionId.startsWith('import:')).map(o => {
      // Imports have no scanning window. A disconnected local connection keeps
      // its last known window; older caches without a window default to 30 days.
      const days = configs.get(o.connectionId)?.historyDays ?? o.historyDays;
      return [3, 7, 30].includes(days) ? days : 30;
    });
    return windows.length ? Math.max(...windows) : 30;
  }
  function withinHistory(record, connections = [], now = Date.now()) {
    const days = historyWindowDays(record, connections);
    if (days === null) return true;
    const at = time(record.updatedAt);
    return at !== null && at <= now && at >= now - days * 86400000;
  }
  function groupLimit(value = 5) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 50) throw Error('最多分组数需为 1 到 50 的整数。');
    return value;
  }
  function groupScope(record, state, {epoch, now = Date.now()} = {}) {
    if (record.parentId || record.user.archived) return false;
    if (record.kind === 'web') return record.connectorId === 'browser' && record.binding?.live === true && (!epoch || record.binding.epoch === epoch);
    if (record.kind !== 'session' || !withinHistory(record, state.connections, now)) return false;
    return historyWindowDays(record, state.connections) !== null || time(record.updatedAt) !== null && record.updatedAt <= now && record.updatedAt >= now - 3 * 86400000;
  }
  function groupMovable(record) {
    return !record.pending && !record.user.manual?.projectId && (record.kind === 'web'
      ? !record.observations.some(observation => observation.allowAI !== true)
      : record.observations.length > 0 && record.observations.every(observation => observation.allowAI === true));
  }
  function groupingPlan(state, options = {}) {
    const maxGroups = groupLimit(options.maxGroups ?? state.groupSettings?.maxGroups ?? 5);
    const active = state.records.filter(record => groupScope(record, state, options));
    const groups = state.projects.map((project, order) => {
      const members = active.filter(record => record.user.projectId === project.id);
      return {...copy(project), count: members.length, protected: members.some(record => !groupMovable(record)), order};
    }).filter(project => project.count).sort((a, b) => Number(b.protected) - Number(a.protected) || b.count - a.count || a.order - b.order);
    const protectedCount = groups.filter(project => project.protected).length;
    const keepIds = groups.slice(0, Math.max(maxGroups, protectedCount)).map(project => project.id);
    return {maxGroups, groups, protectedCount, keepIds, overLimit: groups.length > maxGroups,
      mergeIds: active.filter(record => record.user.projectId && !keepIds.includes(record.user.projectId) && groupMovable(record)).map(record => record.id),
      error: protectedCount > maxGroups ? {code: 'GROUP_LIMIT_PROTECTED', message: `已有 ${protectedCount} 个人工固定或不可自动调整的分组，超过上限 ${maxGroups}。请提高上限，或手动调整这些归属后重试。`} : null};
  }
  function publicItem(record, now = Date.now(), connections = []) {
    const r = record, u = r.user, days = historyWindowDays(r, connections);
    let status = r.status;
    if (r.kind === 'web') status = r.binding?.live ? 'open' : 'unknown';
    else if (!r.statusLive || !r.statusObservedAt || now - r.statusObservedAt > 60000) status = 'unknown';
    return {...copy(r), originalTitle: r.title, title: u.alias || u.sessionName || r.sourceTitle || r.title,
      titleBasis: u.alias ? 'manual-alias' : u.sessionName ? 'generated-name' : r.titleBasis || 'unknown',
      needsSessionName: r.kind === 'session' && !u.alias && !u.sessionName && !r.sourceTitle && !!r.firstMessage && !!r.latestMessage,
      outsideHistoryRange: !withinHistory(r, connections, now),
      historyExpiresAt: days !== null && time(r.updatedAt) !== null ? r.updatedAt + days * 86400000 : null,
      sourceId: u.sourceOverride?.id || r.source.id, sourceName: u.sourceOverride?.label || r.source.label,
      sourceIcon: u.sourceOverride?.icon || r.source.icon, projectId: u.projectId, tags: [...u.tags],
      summary: u.summaryOverride !== null ? u.summaryOverride : r.summary,
      archived: u.archived, archivedAt: u.archivedAt, saved: u.saved, revision: u.revision, manual: {...u.manual},
      needsBinding: r.kind === 'web' && !r.binding?.live, status,
      archivedHasUpdates: u.archived && (r.updatedAt || 0) > (u.archivedActivityAt || 0)};
  }
  function saveProject(state, input) {
    const name = text(input.name, 60); if (!name) throw Error('请输入项目名称。');
    const old = input.id && state.projects.find(p => p.id === input.id);
    if (input.id && !old) throw Error('项目不存在。');
    const color = /^#[0-9a-f]{6}$/i.test(input.color || '') ? input.color : COLORS[state.projects.length % COLORS.length];
    if (old) { old.name = name; old.color = color; return old; }
    const project = {id: uid('project:'), name, color}; state.projects.push(project); return project;
  }
  function userPatch(state, id, patch, manual = true) {
    const record = find(state, id); if (!record) throw Error('内容已不存在。');
    const u = record.user, before = copy(u);
    const known = new Set(['projectId', 'tags', 'alias', 'sessionName', 'summary', 'sourceName']);
    if (Object.keys(patch).some(key => !known.has(key))) throw Error('不支持修改该字段。');
    if ('sessionName' in patch && (record.kind !== 'session' || record.sourceTitle || u.alias || u.sessionName || !text(patch.sessionName, 80) || typeof patch.sessionName !== 'string' || patch.sessionName.length > 80)) throw Error('会话已有名称或建议名称无效，不能自动改名。');
    if ('projectId' in patch) {
      const pid = patch.projectId || null;
      if (pid && !state.projects.some(p => p.id === pid)) throw Error('目标项目不存在。');
      u.projectId = pid; if (manual) u.manual.projectId = true;
    }
    if ('tags' in patch) {
      if (!Array.isArray(patch.tags) || patch.tags.length > 1 || patch.tags.some(t => !TYPE_LABELS.includes(t))) throw Error('请选择一个支持的主类型，或清空类型。');
      u.tags = [...patch.tags];
      if (manual) u.manual.tags = true;
    }
    if ('alias' in patch) u.alias = text(patch.alias, 500);
    if ('sessionName' in patch) u.sessionName = text(patch.sessionName, 80);
    if ('summary' in patch) { u.summaryOverride = text(patch.summary, 2500); if (manual) u.manual.summary = true; }
    if ('sourceName' in patch) {
      const label = text(patch.sourceName, 80);
      u.sourceOverride = label ? {id: 'user:' + label, label, icon: rIcon(record), basis: 'user-confirmed'} : null;
    }
    u.revision++;
    return {id, before, after: copy(u)};
  }
  // Learning is local workspace data. Model projections are built separately
  // and recheck both capture-time and current source permissions.
  const learningNorm = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const learningWords = value => [...new Set((Array.isArray(value) ? value : String(value || '').split(/[\n,，]/)).map(v => text(v, 120)).filter(Boolean))].slice(0, 30);
  const learningGeneric = value => /^(ai|agent|agents|claude|claude code|codex|mana|ai mana|github|github\.com|google\.com|youtube\.com|docs|project|task|new|code|develop|development|implement|fix|test|research|design|update|please|help|the|and|for|with|方案|设计|开发|调研|文档|工具|项目|任务|测试|需求|产品|使用|咨询|其他|未归类|开发实现|方案设计|需求规划|调研分析|测试排障|文档整理|使用咨询)$/i.test(learningNorm(value));
  function learningTitle(record) { if (record.kind === 'web') return record.title || ''; return record.user.alias || record.user.sessionName || record.sourceTitle || record.title || ''; }
  function learningCanSend(record) {
    return !!record && (record.kind === 'web' ? !record.observations.some(o => o.allowAI !== true) : record.observations.length > 0 && record.observations.every(o => o.allowAI === true)) &&
      (record.kind === 'web' || record.sourceTitle || record.user.alias || record.observations.every(o => o.includeNaming === true));
  }
  function ensureLearning(state) {
    if (!state.learning) state.learning = {version: 1, revision: 0, profiles: [], rules: [], feedback: [], metrics: {ruleAssignments: 0, modelAssignments: 0, corrections: 0}};
    const l = state.learning;
    l.outcomes ||= []; l.costs ||= {}; l.unknownCostRequests ||= 0; l.classificationRequests ||= 0;
    for (const p of state.projects) {
      const profile = l.profiles.find(x => x.id === p.id);
      if (profile) { profile.name = p.name; profile.color = p.color; }
      else l.profiles.push({...copy(p), description: '', keywords: [], excludes: [], urls: [], deleted: false});
    }
    if (!l.seeded) {
      for (const r of state.records) if (r.user.manual?.projectId && r.user.projectId) l.feedback.push({id: uid('feedback:'), recordId: r.id, to: r.user.projectId, from: null, operationId: null, seed: true, active: true, at: Date.now(), title: text(learningTitle(r), 250), modelAllowed: !!learningCanSend(r)});
      l.seeded = true;
    }
    return l;
  }
  function learningUrl(value) {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw Error('网址规则请填写不含账号、参数和锚点的 HTTP(S) 域名与路径。');
    return u.origin + u.pathname.replace(/\/$/, '');
  }
  function learningHit(haystack, needle) {
    const h = learningNorm(haystack), n = learningNorm(needle); if (!n) return false;
    if (/^[\x00-\x7f]+$/.test(n)) return new RegExp('(^|[^a-z0-9_])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9_])', 'i').test(h);
    return h.includes(n);
  }
  function learningRuleMatches(rule, record) {
    const title = learningTitle(record), urls = rule.urls || [], words = rule.keywords || [];
    if ((rule.excludes || []).some(word => learningHit(title, word))) return false;
    return words.some(word => learningHit(title, word)) || urls.some(prefix => {
      try { const u = new URL(record.url), p = new URL(prefix); return u.origin === p.origin && (u.pathname === p.pathname || u.pathname.startsWith(p.pathname.replace(/\/$/, '') + '/')); } catch { return false; }
    });
  }
  function learningProfileSave(state, id, input) {
    const l = ensureLearning(state), p = l.profiles.find(x => x.id === id && !x.deleted);
    if (!p) throw Error('分组已不存在。');
    for (const field of ['keywords', 'excludes', 'urls']) if (own(input, field)) p[field] = field === 'urls' ? learningWords(input[field]).map(learningUrl) : learningWords(input[field]);
    if (own(input, 'description')) p.description = text(input.description, 500);
    const idRule = 'profile-rule:' + p.id;
    if (p.keywords.length || p.urls.length) {
      const oldRule = l.rules.find(r => r.id === idRule);
      const rule = {id: idRule, projectId: p.id, origin: 'user', status: 'active', keywords: copy(p.keywords), urls: copy(p.urls), excludes: copy(p.excludes)};
      if (oldRule) { rule.status = oldRule.status; Object.assign(oldRule, rule); } else l.rules.push(rule);
    } else { const oldRule = l.rules.find(r => r.id === idRule); if (oldRule) oldRule.status = 'paused'; }
    l.revision++; return copy(p);
  }
  function learningRuleSave(state, input) {
    const l = ensureLearning(state), old = input.id && l.rules.find(r => r.id === input.id);
    if (input.id && !old) throw Error('规则已不存在。');
    const projectId = input.projectId || old?.projectId, p = l.profiles.find(p => p.id === projectId && !p.deleted);
    if (!p) throw Error('目标分组已删除。');
    const rule = {id: old?.id || uid('rule:'), projectId, origin: 'user', status: 'active', keywords: [], excludes: [], urls: [], ...copy(old || {})};
    for (const field of ['keywords', 'excludes', 'urls']) if (own(input, field)) rule[field] = field === 'urls' ? learningWords(input[field]).map(learningUrl) : learningWords(input[field]);
    if (input.confirm === true) rule.origin = 'user';
    if (input.status !== undefined) { if (!['active', 'paused', 'deleted'].includes(input.status)) throw Error('规则状态不正确。'); rule.status = input.status; }
    if (!rule.keywords.length && !rule.urls.length) throw Error('请填写关键词或具体网址范围。');
    if (old) Object.assign(old, rule); else l.rules.push(rule);
    l.revision++; learningRecompute(state); return copy(rule);
  }
  function learningRecompute(state) {
    const l = ensureLearning(state);
    for (const p of l.profiles.filter(p => !p.deleted)) {
      const positives = l.feedback.filter(f => f.active && f.to === p.id && !f.seed);
      const candidates = new Set([...p.keywords, p.name].filter(w => !learningGeneric(w) && learningNorm(w).length >= 2));
      for (const f of positives) for (const word of (f.title.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || []))
        if (!learningGeneric(word) && (learningHit(p.name, word) || p.keywords.some(k => learningHit(k, word)))) candidates.add(word);
      for (const keyword of candidates) {
        const supports = positives.filter(f => learningHit(f.title, keyword));
        if (!supports.length) continue;
        let rule = l.rules.find(r => r.origin === 'learned' && r.projectId === p.id && r.keywords.length === 1 && learningNorm(r.keywords[0]) === learningNorm(keyword));
        if (!rule) { rule = {id: uid('rule:'), projectId: p.id, origin: 'learned', status: 'candidate', keywords: [keyword], excludes: [], urls: [], supportIds: []}; l.rules.push(rule); }
        if (['paused', 'deleted'].includes(rule.status)) continue;
        rule.supportIds = supports.map(f => f.id);
        const counter = l.feedback.some(f => f.active && f.to !== p.id && learningHit(f.title, keyword));
        const clash = l.rules.some(r => r.projectId !== p.id && r.status === 'active' && (r.keywords.some(k => learningNorm(k) === learningNorm(keyword)) || supports.some(f => { const record = find(state, f.recordId); return record && learningRuleMatches(r, record); })));
        rule.status = new Set(supports.map(f => f.recordId)).size >= 3 && new Set(supports.map(f => f.operationId)).size >= 3 && !counter && !clash ? 'active' : 'candidate';
      }
    }
    for (const rule of l.rules.filter(r => r.origin === 'learned' && r.status === 'active')) {
      const support = l.feedback.filter(f => f.active && rule.supportIds?.includes(f.id));
      if (new Set(support.map(f => f.recordId)).size < 3 || new Set(support.map(f => f.operationId)).size < 3 || l.feedback.some(f => f.active && f.to !== rule.projectId && rule.keywords.some(k => learningHit(f.title, k)))) rule.status = 'candidate';
    }
  }
  function learningFeedback(state, record, before, operationId = uid('operation:')) {
    const l = ensureLearning(state);
    if (before.projectId === record.user.projectId) return null;
    const priorRule = before.groupingEvidence?.ruleId;
    if (priorRule) { const rule = l.rules.find(r => r.id === priorRule && r.origin === 'learned'); if (rule) rule.status = 'paused'; }
    const supersedes = l.feedback.filter(f=>f.active && f.recordId===record.id).map(f=>f.id);
    l.feedback.forEach(f=>{if(supersedes.includes(f.id))f.active=false;});
    const event = {supersedes, id: uid('feedback:'), recordId: record.id, from: before.projectId, to: record.user.projectId, operationId, seed: false, active: true, at: Date.now(), title: text(learningTitle(record), 250), modelAllowed: !!learningCanSend(record)};
    l.feedback.push(event); if (['rule','model'].includes(before.groupingEvidence?.source)) { l.metrics.corrections++; const outcome=l.outcomes.find(o=>o.id===record.id); if(outcome)outcome.corrected=true; }
    record.user.groupingEvidence = {source: 'manual', at: event.at};
    l.revision++; learningRecompute(state); return event.id;
  }
  function learningScope(record, state, options = {}) {
    if (!groupScope(record, state, options) || record.pending) return false;
    if (record.kind === 'web') return true;
    return record.observations.some(o => state.connections.some(c => c.id === o.connectionId && c.enabled !== false) || record.connectorId === 'standard-import');
  }
  function learningMatch(state, record) {
    const l = ensureLearning(state);
    if (record.user.manual?.projectId) return {status: 'fixed'};
    const eligible = l.rules.filter(r => r.status === 'active' && l.profiles.some(p => p.id === r.projectId && !p.deleted) && learningRuleMatches(r, record) &&
      !l.profiles.find(p => p.id === r.projectId)?.excludes.some(w => learningHit(learningTitle(record), w)));
    const user = eligible.filter(r => r.origin === 'user'), pool = user.length ? user : eligible;
    const targets = [...new Set(pool.map(r => r.projectId))];
    if (targets.length > 1) return {status: 'conflict', message: '多条规则指向不同分组，等待进一步判断。'};
    if (!targets.length) return {status: 'none'};
    return {status: 'matched', projectId: targets[0], ruleId: pool[0].id, origin: pool[0].origin, reason: pool[0].keywords.length ? '命中关键词：' + pool[0].keywords.join('、') : '命中网址规则'};
  }
  function learningApply(state, ids, options = {}) {
    const l = ensureLearning(state), entries = [], excluded = [], selected = new Set(ids), suggestions = [];
    for (const r of state.records) {
      if (!selected.has(r.id) || !learningScope(r, state, options) || r.user.manual?.projectId || !options.history && r.user.projectId) continue;
      if (!r.user.projectId && !l.outcomes.some(o=>o.id===r.id)) l.outcomes.push({id:r.id,source:null,corrected:false});
      const match = learningMatch(state, r);
      if (match.status !== 'matched') { if (match.status === 'conflict') excluded.push({id: r.id, reason: match.message}); continue; }
      const p = l.profiles.find(p => p.id === match.projectId && !p.deleted), plan = groupingPlan(state, options);
      if (!p || !plan.groups.some(g => g.id === p.id) && plan.groups.length >= plan.maxGroups) { excluded.push({id: r.id, reason: '规则目标没有可用分组名额，原归属保留。'}); continue; }
      if (r.user.projectId === p.id) continue;
      if (options.preview) {
        suggestions.push({id: uid('suggestion:'), recordId: r.id, kind: 'local-rule', revision: r.user.revision, observedUpdatedAt: r.updatedAt, contentRevision: r.contentRevision, policyRevision: state.policyRevision, learningRevision: l.revision, patch: {projectId: p.id}, ruleId: match.ruleId, reason: match.reason}); continue;
      }
      if (!state.projects.some(x => x.id === p.id)) state.projects.push({id: p.id, name: p.name, color: p.color});
      const entry = userPatch(state, r.id, {projectId: p.id}, false);
      r.user.groupingEvidence = {previousProjectId: entry.before.projectId, source: 'rule', ruleId: match.ruleId, ruleVersion: l.revision, reason: match.reason, appliedRevision: r.user.revision};
      entry.after = copy(r.user); entries.push(entry); l.metrics.ruleAssignments++; const outcome=l.outcomes.find(o=>o.id===r.id); if(outcome&&!outcome.source)outcome.source='rule';
    }
    pushUndo(state, entries, '规则归组'); return {applied: entries.length, ids: entries.map(e => e.id), excluded, suggestions};
  }
  function learningRollbackPreview(state, ruleId) {
    const l = ensureLearning(state), suggestions = [];
    for (const r of state.records) {
      const e = r.user.groupingEvidence;
      if (e?.source !== 'rule' || e.ruleId !== ruleId || e.appliedRevision !== r.user.revision || r.user.manual?.projectId || r.user.archived) continue;
      if (e.previousProjectId && !l.profiles.some(p => p.id === e.previousProjectId && !p.deleted)) continue;
      suggestions.push({id: uid('suggestion:'), recordId: r.id, kind: 'rule-rollback', ruleId, revision: r.user.revision, observedUpdatedAt: r.updatedAt, contentRevision: r.contentRevision, policyRevision: state.policyRevision, learningRevision: l.revision, patch: {projectId: e.previousProjectId || null}, reason: '撤回此规则的归组；后续有修改的记录会跳过。'});
    }
    return suggestions;
  }
  function learningModelProjects(state, projects) {
    const l = ensureLearning(state);
    return projects.map(p => {
      const profile = l.profiles.find(x => x.id === p.id && !x.deleted), examples = [];
      for (const polarity of ['positive', 'negative']) for (const f of [...l.feedback].reverse()) {
        if (examples.filter(e => e.polarity === polarity).length >= (polarity === 'positive' ? 2 : 1)) break;
        const r = find(state, f.recordId);
        if (!f.active || !f.modelAllowed || !learningCanSend(r) || r?.user.projectId !== f.to || (polarity === 'positive' ? f.to !== p.id : f.from !== p.id || f.to === p.id) || examples.some(e => e.recordId === f.recordId)) continue;
        examples.push({id: f.id, recordId: f.recordId, polarity, title: text(f.title, 160)});
      }
      return {...p, description: profile?.description || '', keywords: profile?.keywords || [], excludes: profile?.excludes || [], examples: examples.map(({recordId, ...e}) => e)};
    });
  }

  function rIcon(r) { return r.source.icon || '◇'; }
  function pushUndo(state, entries, label, projects = []) {
    if (!entries.length && !projects.length) return;
    state.undo.push({entries, label, projects}); state.undo = state.undo.slice(-30);
  }
  function pruneEmptyProjects(state, keepIds = []) {
    const occupied = new Set([...keepIds, ...state.records.map(r => r.user.projectId).filter(Boolean)]);
    const removed = state.projects.filter(project => !occupied.has(project.id));
    if (!removed.length) return 0;
    const ids = new Set(removed.map(project => project.id));
    // Empty groups leave the workspace automatically. Preserve only the
    // definitions needed to undo a move, so undo never restores dangling IDs.
    for (const operation of state.undo) {
      const referenced = new Set((operation.entries || []).flatMap(entry => [entry.before?.projectId, entry.after?.projectId]));
      const backups = new Map((operation.projectBackups || []).map(project => [project.id, project]));
      for (const project of removed) if (referenced.has(project.id)) backups.set(project.id, copy(project));
      if (backups.size) operation.projectBackups = [...backups.values()];
    }
    state.projects = state.projects.filter(project => !ids.has(project.id));
    state.suggestions = state.suggestions.filter(suggestion => !ids.has(suggestion.patch?.projectId));
    return removed.length;
  }
  function undo(state) {
    const entry = state.undo.pop(); if (!entry) throw Error('没有可撤销的修改。');
    let restored = 0, conflicts = 0;
    for (const e of entry.entries) {
      const record = find(state, e.id);
      if (!record || record.user.revision !== e.after.revision) { conflicts++; continue; }
      if (e.before.projectId && !state.projects.some(project => project.id === e.before.projectId)) {
        const backup = entry.projectBackups?.find(project => project.id === e.before.projectId);
        if (!backup) { conflicts++; continue; }
        state.projects.push(copy(backup));
      }
      const revision = record.user.revision + 1;
      const restoredUser = {...copy(e.before), revision};
      const previousTags = Array.isArray(restoredUser.tags) ? restoredUser.tags : [];
      restoredUser.tags = normalizeTypeTags(previousTags);
      if (JSON.stringify(previousTags) !== JSON.stringify(restoredUser.tags) &&
          (!Array.isArray(restoredUser.legacyTypeTags) || !restoredUser.legacyTypeTags.length)) restoredUser.legacyTypeTags = previousTags.filter(value => typeof value === 'string');
      record.user = restoredUser; restored++;
      if (e.feedbackId && state.learning) { const f = state.learning.feedback.find(f => f.id === e.feedbackId); if (f) { f.active = false; for(const prior of state.learning.feedback) if(f.supersedes?.includes(prior.id) && prior.to===record.user.projectId)prior.active=true; } state.learning.revision++; learningRecompute(state); }
    }
    for (const p of entry.projects || []) {
      if (!state.records.some(r => r.user.projectId === p.id)) state.projects = state.projects.filter(x => x.id !== p.id);
    }
    return {restored, conflicts, message: `已撤销 ${restored} 条修改${conflicts ? `；${conflicts} 条因后续修改已跳过` : ''}`};
  }
  function applySuggestions(state, suggestions, options = {}) {
    // Quota checks can fail after an earlier item in the same preview. Stage
    // the whole application so a rejected batch never leaves partial edits.
    const staged = {...state, learning: state.learning ? copy(state.learning) : undefined, projects: copy(state.projects), suggestions: copy(state.suggestions), undo: copy(state.undo),
      records: state.records.map(record => ({...record, user: copy(record.user)}))};
    const result = applySuggestionsInPlace(staged, suggestions, options);
    for (let index = 0; index < state.records.length; index++) {
      if (state.records[index].user.revision !== staged.records[index].user.revision) state.records[index].user = staged.records[index].user;
    }
    state.learning = staged.learning; state.projects = staged.projects; state.suggestions = staged.suggestions; state.undo = staged.undo;
    return result;
  }
  function applySuggestionsInPlace(state, suggestions, options = {}) {
    if (!Array.isArray(suggestions)) throw Error('整理建议格式错误。');
    const entries = [], created = [], conflicts = [], applied = [];
    for (const s of suggestions) {
      const stored = state.suggestions.find(p => p.id === s.id && p.recordId === s.recordId);
      const record = find(state, s.recordId);
      const rollback = stored?.kind === 'rule-rollback';
      const localRule = stored?.kind === 'local-rule';
      const allowed = record && (localRule || rollback ? learningScope(record, state, options) : (record.kind === 'web' ? !record.observations.some(o => o.allowAI !== true) : record.observations.length > 0 && record.observations.every(o => o.allowAI === true)));
      if (!stored || !record || !allowed || record.user.archived || !withinHistory(record, state.connections) || record.user.revision !== stored.revision || record.updatedAt !== stored.observedUpdatedAt || (stored.contentRevision !== undefined && stored.contentRevision !== record.contentRevision) || (stored.policyRevision !== undefined && stored.policyRevision !== state.policyRevision)) { conflicts.push(s.recordId); continue; }
      const patch = {...s.patch};
      if (stored.learningRevision !== undefined && stored.learningRevision !== ensureLearning(state).revision) { conflicts.push(s.recordId); continue; }
      if (rollback && (JSON.stringify(patch) !== JSON.stringify(stored.patch) || record.user.groupingEvidence?.ruleId !== stored.ruleId || record.user.groupingEvidence?.appliedRevision !== record.user.revision)) { conflicts.push(s.recordId); continue; }
      if (rollback && patch.projectId && !state.projects.some(p => p.id === patch.projectId)) { const p = state.learning.profiles.find(p => p.id === patch.projectId && !p.deleted); if (!p) { conflicts.push(s.recordId); continue; } state.projects.push({id:p.id,name:p.name,color:p.color}); }
      if (localRule) {
        const match = learningMatch(state, record);
        if (Object.keys(patch).length !== 1 || match.status !== 'matched' || patch.projectId !== match.projectId || stored.ruleId !== match.ruleId) { conflicts.push(s.recordId); continue; }
        if (!state.projects.some(p => p.id === patch.projectId)) {
          const profile = state.learning.profiles.find(p => p.id === patch.projectId && !p.deleted);
          if (!profile) { conflicts.push(s.recordId); continue; }
          state.projects.push({id: profile.id, name: profile.name, color: profile.color});
        }
      }
      const merging = stored.kind === 'grouping-merge';
      if (stored.kind === 'grouping-review' && (JSON.stringify(patch) !== JSON.stringify(stored.patch) || Object.keys(patch).some(k=>!['projectId','projectName'].includes(k)))) throw Error('历史归属预览只能应用原项目建议。');
      if (merging && (Object.keys(patch).length !== 1 || !own(patch, 'projectId') && !own(patch, 'projectName'))) throw Error('合并分组建议只能修改项目归属。');
      if (('projectId' in patch || 'projectName' in patch) && record.user.manual?.projectId) { conflicts.push(s.recordId); continue; }
      if (stored.kind === 'progress') {
        if (Object.keys(patch).length !== 1 || !own(patch, 'summary') || typeof patch.summary !== 'string' || patch.summary.length > 600) throw Error('进展建议只能修改一句近况。');
        if (record.kind !== 'session' || record.user.manual?.summary || !record.observations.every(o => o.includeSummary === true)) { conflicts.push(s.recordId); continue; }
      }
      if (stored.kind === 'naming' && Object.keys(patch).some(key => key !== 'sessionName')) throw Error('命名建议只能修改会话名称。');
      if (Object.keys(patch).some(k => !['projectId', 'projectName', 'tags', 'summary', 'sessionName'].includes(k))) throw Error('建议包含不可修改字段。');
      if ('sessionName' in patch && (!('sessionName' in stored.patch) || !publicItem(record).needsSessionName || !record.observations.every(o => o.includeNaming === true))) { conflicts.push(s.recordId); continue; }
      let plannedProject = null;
      if (patch.projectName) {
        const name = text(patch.projectName, 60);
        const matches = state.projects.filter(p => p.name === name);
        if (matches.length > 1) throw Error('目标项目名称有歧义，请重新整理。');
        plannedProject = matches[0] || {name};
        patch.projectId = plannedProject.id || null; delete patch.projectName;
      }
      if ('projectId' in patch) {
        const profile = state.learning?.profiles.find(p=>p.id===patch.projectId);
        if (profile?.deleted || profile?.excludes.some(w=>learningHit(learningTitle(record),w))) { conflicts.push(s.recordId); continue; }
        const plan = groupingPlan(state, options);
        if (merging) {
          if (plan.error) throw Object.assign(Error(plan.error.message), {code: plan.error.code});
          const allowedIds = stored.allowedProjectIds || options.allowedProjectIds || plan.keepIds;
          if (!groupScope(record, state, options) || !groupMovable(record) || !patch.projectId || !allowedIds.includes(patch.projectId) || !plan.keepIds.includes(patch.projectId))
            throw Object.assign(Error('保留分组或人工归属已变化，请重新合并。'), {code: 'GROUP_LIMIT_CONFLICT'});
        } else if ((!patch.projectId && plannedProject || patch.projectId && !plan.groups.some(project => project.id === patch.projectId)) && plan.groups.length >= plan.maxGroups) {
          throw Object.assign(Error(`当前已有 ${plan.groups.length} 个在用分组，达到上限 ${plan.maxGroups}。请使用已有分组，或提高上限后重新整理。`), {code: 'GROUP_LIMIT_REACHED'});
        }
        if (plannedProject && !plannedProject.id) {
          const project = saveProject(state, plannedProject); created.push(copy(project)); patch.projectId = project.id;
        }
      }
      // Both explicit preview application and automatic organization use the
      // same revision, permission and source-content checks above.
      const entry = userPatch(state, record.id, patch, false);
      if ('projectId' in patch) {
        record.user.groupingEvidence = {previousProjectId: entry.before.projectId, source: rollback ? 'rollback' : localRule ? 'rule' : 'model', ruleId: stored.ruleId || null, ruleVersion: stored.learningRevision ?? 0, reason: stored.reason || '', evidence: stored.evidence || null, appliedRevision: record.user.revision};
        entry.after = copy(record.user);
        if (state.learning && !rollback) { state.learning.metrics[localRule ? 'ruleAssignments' : 'modelAssignments']++; const outcome=state.learning.outcomes.find(o=>o.id===record.id); if(outcome&&!outcome.source)outcome.source=localRule?'rule':'model'; }
      }
      entries.push(entry); applied.push(stored.id);
    }
    pushUndo(state, entries, suggestions.length && suggestions.every(s => state.suggestions.find(p => p.id === s.id)?.kind === 'grouping-merge') ? '合并分组' : 'AI 整理', created);
    state.suggestions = state.suggestions.filter(s => !applied.includes(s.id));
    return {applied: entries.length, conflicts, message: `已应用 ${entries.length} 条建议${conflicts.length ? `；${conflicts.length} 条已变化，请重新预览` : ''}`};
  }
  function importRecords(datasetId, input) {
    const dataset = typeof datasetId === 'string' ? datasetId.trim() : '';
    if (!dataset) throw Error('请输入数据集名称，以便重复导入时更新同一记录。');
    if (dataset.length > 100) throw Error('数据集名称最多 100 个字符。');
    if (typeof input !== 'string' || input.length > 10 * 1024 * 1024) throw Error('导入文件最多 10 MB。');
    // Length-prefixed namespaces preserve Unicode and delimiters without URL-encoding expansion.
    // Never truncate an identity: a rejected overlong ID is safer than silently merging records.
    const importedId = (value, prefix = 'import') => {
      if (typeof value !== 'string' || !value.trim()) throw Error('缺少稳定 id');
      const id = `${prefix}:${dataset.length}:${dataset}:${value.trim()}`;
      if (id.length > 600) throw Error('数据集名称与 id 合计过长，请缩短后重试');
      return id;
    };
    let parsed, isJson = false;
    try { parsed = JSON.parse(input); isJson = true; } catch {}
    let rows, warnings = [];
    if (isJson) rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.records) ? parsed.records : Array.isArray(parsed?.items) ? parsed.items : [parsed];
    else rows = input.split(/\r?\n/).map((line, n) => {
      if (!line.trim()) return null;
      try { return JSON.parse(line); } catch { warnings.push(`第 ${n + 1} 行不是有效 JSON，已跳过。`); return null; }
    });
    if (rows.length > 10000) throw Error('单次导入最多 10000 条记录。');
    const sourceStyles = {};
    if (isJson && plainObject(parsed) && own(parsed, 'sourceStyles')) {
      if (!plainObject(parsed.sourceStyles)) warnings.push('来源外观格式不正确，已跳过。');
      else for (const [sourceId, style] of Object.entries(parsed.sourceStyles)) {
        try {
          if (!validSourceStyle(style)) throw Error('图标或颜色无效');
          saveSourceStyle({sourceStyles}, {sourceId, ...style});
        } catch (error) { warnings.push(`来源外观 ${sourceId}：${error.message}，已跳过。`); }
      }
    }
    const projects = [], projectMap = new Map();
    if (Array.isArray(parsed?.projects)) {
      if (parsed.projects.length > 10000) throw Error('单次导入最多 10000 个项目。');
      for (let n = 0; n < parsed.projects.length; n++) {
        try {
          const project = parsed.projects[n], id = importedId(project?.id, 'import-project');
          const name = text(project.name, 60);
          if (!name) throw Error('项目名称为空');
          if (projectMap.has(project.id.trim())) throw Error('项目 id 重复');
          projectMap.set(project.id.trim(), id);
          projects.push({id, name, color: COLORS.includes(project.color) ? project.color : COLORS[0]});
        } catch (e) { warnings.push(`第 ${n + 1} 个项目：${e.message}`); }
      }
    }
    const restoreUser = (raw, record) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const user = defaultUser();
      const own = key => Object.prototype.hasOwnProperty.call(raw, key);
      const manual = raw.manual && typeof raw.manual === 'object' && !Array.isArray(raw.manual) ? raw.manual : null;
      user.projectId = typeof raw.projectId === 'string' ? projectMap.get(raw.projectId.trim()) || null : null;
      const originalTags = Array.isArray(raw.tags) ? raw.tags.filter(tag => typeof tag === 'string') : [];
      user.tags = normalizeTypeTags(originalTags);
      user.legacyTypeTags = Array.isArray(raw.legacyTypeTags) && raw.legacyTypeTags.length ? raw.legacyTypeTags.filter(tag => typeof tag === 'string') :
        JSON.stringify(originalTags) !== JSON.stringify(user.tags) ? originalTags : [];
      user.alias = text(raw.alias, 500);
      user.sessionName = record.kind === 'session' ? text(raw.sessionName, 80) : '';
      user.summaryOverride = typeof raw.summaryOverride === 'string' ? text(raw.summaryOverride, 2500) : null;
      const override = raw.sourceOverride;
      if (override && typeof override === 'object' && text(override.label, 80)) {
        const label = text(override.label, 80);
        user.sourceOverride = {id: text(override.id, 160) || 'user:' + label, label,
          icon: text(override.icon, 8) || record.source.icon, basis: 'user-confirmed'};
      }
      user.saved = raw.saved === true;
      user.archived = raw.archived === true;
      user.archivedAt = time(raw.archivedAt);
      user.archivedActivityAt = time(raw.archivedActivityAt);
      user.revision = Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
      user.manual = manual ? {projectId: manual.projectId === true, tags: manual.tags === true, summary: manual.summary === true}
        : {projectId: own('projectId'), tags: own('tags'), summary: user.summaryOverride !== null};
      return user;
    };
    const records = [], ids = new Set();
    for (let n = 0; n < rows.length; n++) {
      const row = rows[n]; if (!row) continue;
      try {
        const id = importedId(row.id);
        if (ids.has(id)) throw Error('数据集内 id 重复');
        const r = normalizeRecord({...row, id, originId: row.id, connectorId: 'standard-import',
          parentId: row.parentId ? importedId(row.parentId) : null,
          source: row.source || {id: 'import:' + dataset, label: dataset, icon: '▤'}, status: 'unknown',
          statusLive: false, syncedAt: Date.now(), createdAtBasis: row.createdAt ? (row.createdAtBasis || 'import-declared') : 'unknown',
          observations: [{connectionId: 'import:' + dataset, allowAI: row.allowAI === true, includeSummary: row.includeSummary === true, includeNaming: row.includeNaming === true}]});
        if (row.kind === 'web' && !r.url) throw Error('网页缺少有效 http(s) 网址');
        // Organisation is restored only on first import; subsequent sync preserves local edits.
        r.importUser = restoreUser(row.user, r);
        if (r.importUser) r.user = copy(r.importUser);
        if (row.user?.projectId && !r.user.projectId) warnings.push(`第 ${n + 1} 条：关联项目未包含在文件中，已放入待整理。`);
        ids.add(r.id); records.push(r);
      } catch (e) { warnings.push(`第 ${n + 1} 条：${e.message}`); }
    }
    return {records, projects, sourceStyles, warnings};
  }
  return {learningRollbackPreview, ensureLearning, learningProfileSave, learningRuleSave, learningRecompute, learningFeedback, learningMatch, learningApply, learningScope, learningModelProjects, learningCanSend, COLORS, SOURCE_COLORS, SOURCE_ICONS, TYPE_LABELS, normalizeTypeTags, normalizeTypes, recordUsage, saveModelPricing, usageReport, sourceAppearance, saveSourceStyle, resetSourceStyle, initial, copy, text, time, uid, webUrl, defaultUser, normalizeRecord, find, upsert,
    publicItem, historyWindowDays, withinHistory, groupLimit, groupScope, groupMovable, groupingPlan, saveProject, userPatch, pushUndo, pruneEmptyProjects, undo, applySuggestions, importRecords};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = TaskOutCore;
