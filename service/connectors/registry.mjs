import fs from 'node:fs/promises';
import { constants, readdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { listJSONL, readJSONL, within } from './jsonl.mjs';
import { readCodexNames } from './codex-names.mjs';
import { meaningfulMessage, messageContent } from './message-text.mjs';
import { HISTORY_DAYS, historyDays, inHistory } from '../history.mjs';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const cut = (value, size = 500) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, size) : '';
const time = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 8640000000000000 ? parsed : null;
};
const textContent = value => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter(v => ['text', 'input_text', 'output_text'].includes(v?.type)).map(v => v.text || '').join('\n');
};
function activity(state, stamp) {
  const at = time(stamp);
  if (at !== null) { state.earliest = Math.min(state.earliest ?? at, at); state.latest = Math.max(state.latest ?? at, at); }
  return at;
}
function message(state, role, text, stamp) {
  const {text: cleaned, incompleteRequest} = messageContent(role, text);
  // An incomplete actual request is not an empty context envelope. Keep its
  // missing first-message basis unknown instead of promoting a later turn.
  if (role === 'user' && !cleaned && incompleteRequest && !state.firstMessage) state.preventFirstMessageCapture = true;
  if (!cleaned) return;
  const at = activity(state, stamp);
  // Do not use inherited system/developer instructions as a session's title.
  if (role === 'user' && !state.title && !state.preventFirstMessageCapture) state.title = cut(cleaned, 120);
  if (role === 'user' && !state.firstMessage && !state.preventFirstMessageCapture) state.firstMessage = cleaned;
  state.latestMessage = cleaned;
  if (role === 'assistant') state.summary = cut(cleaned, 500);
  const prior = state.timeline.at(-1);
  if (prior?.text === cleaned && prior?.at === at) return;
  state.timeline.push({ role, text: cleaned, at });
  if (state.timeline.length > 60) state.timeline.shift();
}
const NAMING_VERSION = 3;
const empty = () => ({ namingVersion: NAMING_VERSION, title: '', sourceTitle: '', sourceTitleSeen: false, firstMessage: '', latestMessage: '', summary: '', created: null, createdAtBasis: 'unknown', earliest: null, latest: null, timeline: [], metadataFound: false, entrypoints: [], clientNames: [] });

function codexReducer(expectedId) {
  return (state, entry) => {
    const payload = entry.payload || {};
    if (entry.type === 'session_meta') {
      // Forked rollouts can contain another session_meta later. Neither its
      // id nor a payload.session_id is the identity of this physical rollout.
      if (typeof payload.id !== 'string' || payload.id.toLowerCase() !== expectedId || state.metadataFound) return;
      state.metadataFound = true;
      state.created = time(payload.timestamp || entry.timestamp);
      state.createdAtBasis = state.created ? (payload.timestamp ? 'session_meta.timestamp' : 'session_meta.event_timestamp') : 'unknown';
      activity(state, payload.timestamp || entry.timestamp);
      state.originator = cut(payload.originator, 80);
      state.cwd = cut(payload.cwd, 600);
      const subagent = payload.source?.subagent;
      state.parentOriginId = payload.parent_thread_id || payload.parent_session_id || subagent?.spawn?.parent_thread_id || subagent?.parent_thread_id || null;
      return;
    }
    // Replayed parent history in a fork is context, not newly created activity.
    if (state.created && time(entry.timestamp) && time(entry.timestamp) < state.created) return;
    activity(state, entry.timestamp);
    if (entry.type === 'event_msg' && payload.type === 'user_message') message(state, 'user', payload.message, entry.timestamp);
    else if (entry.type === 'event_msg' && payload.type === 'agent_message') message(state, 'assistant', payload.message, entry.timestamp);
    else if (entry.type === 'response_item' && payload.type === 'message' && ['user', 'assistant'].includes(payload.role))
      message(state, payload.role, textContent(payload.content), entry.timestamp);
  };
}

function claudeReducer(expectedId, parentOriginId, flatSubagent = false) {
  return (state, entry) => {
    if (entry.sessionId && entry.sessionId !== expectedId && !parentOriginId && !flatSubagent) return;
    if (['session_meta', 'session-start', 'session_start'].includes(entry.type) ||
        ['user', 'assistant'].includes(entry.type) && entry.message && typeof entry.message === 'object' ||
        entry.type === 'custom-title' && typeof entry.customTitle === 'string') state.formatFound = true;
    if (entry.entrypoint && !state.entrypoints.includes(entry.entrypoint)) state.entrypoints.push(cut(entry.entrypoint, 80));
    const client = entry.clientName || entry.client?.name;
    if (client && !state.clientNames.includes(client)) state.clientNames.push(cut(client, 80));
    if (entry.type === 'summary' && !state.summary) state.summary = cut(entry.summary, 500);
    if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
      state.sourceTitle = cut(entry.customTitle, 500); state.sourceTitleSeen = true;
      state.sourceTitleUpdatedAt = time(entry.timestamp);
      state.title = state.sourceTitle || cut(state.firstMessage, 120);
      return; // A rename is catalog metadata, not a new conversation activity.
    }
    if (['session_meta', 'session-start', 'session_start'].includes(entry.type)) {
      const created = time(entry.createdAt || entry.timestamp);
      if (created && !state.created) { state.created = created; state.createdAtBasis = 'explicit_session_start'; }
    }
    activity(state, entry.timestamp);
    if (entry.parentSessionId) state.parentOriginId = entry.parentSessionId;
    if (parentOriginId) state.parentOriginId = parentOriginId;
    if (flatSubagent && entry.sessionId?.match(UUID)) state.parentOriginId = entry.sessionId.toLowerCase();
    if (['user', 'assistant'].includes(entry.type)) {
      const role = entry.message?.role || entry.type;
      // Tool results and local-command/system wrappers are not a new task.
      if (entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) return;
      message(state, role, textContent(entry.message?.content), entry.timestamp);
    }
  };
}

const commonFields = [
  { key: 'name', type: 'text', label: '连接名称', required: true },
  { key: 'root', type: 'path', label: '数据目录', required: true },
  { key: 'historyDays', type: 'select', label: '任务获取范围', default: 30, options: HISTORY_DAYS.map(value => ({ value, label: `近 ${value} 天有活动` })) },
  { key: 'pollIntervalMs', type: 'number', label: '本地读取间隔（毫秒，0 为手动）', default: 60000 },
  { key: 'allowAI', type: 'boolean', label: '允许标题参与 AI 整理', default: false },
  { key: 'includeSummary', type: 'boolean', label: '允许近况参与 AI 整理', default: false },
  { key: 'includeNaming', type: 'boolean', label: '允许首条与最新消息用于生成会话名称', default: false },
];
const capabilities = { discover: true, test: true, sync: true, history: true, open: false, realtime: false, archive: false };
export const registry = [
  { id: 'codex-rollout', version: 1, name: 'Codex rollout', displayName: 'Codex 会话', icon: 'terminal', configFields: [...commonFields,
      { key: 'metadataRoot', type: 'path', label: '名称元数据目录（可选，需显式选择）', default: '', description: '只读取所选目录内的 session_index.jsonl 和 state_*.sqlite，用于真实名称及首条消息；不会自动读取父目录。' }], capabilities,
    metadataRoots: () => [process.env.CODEX_HOME || path.join(os.homedir(), '.codex')],
    defaultRoots: () => [path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'), path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'archived_sessions')],
    identify(file) { const id = path.basename(file).match(UUID)?.[0]; return id ? { originId: id.toLowerCase(), reducer: codexReducer(id.toLowerCase()) } : null; },
    source(state) { return { id: 'codex', label: state.originator?.startsWith('codex') ? 'Codex' : 'Codex 格式会话', icon: 'terminal', evidence: state.originator || 'rollout format' }; },
  },
  { id: 'claude-jsonl', version: 1, name: 'Claude 格式 JSONL', displayName: 'Claude 兼容会话', icon: 'message', configFields: commonFields, capabilities,
    defaultRoots: () => [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')],
    identify(file) {
      const basename = path.basename(file, '.jsonl');
      const parent = path.basename(path.dirname(file)) === 'subagents' ? path.basename(path.dirname(path.dirname(file))).match(UUID)?.[0] : null;
      const flatSubagent = !parent && /^agent-/.test(basename);
      const id = basename.match(UUID)?.[0] || (/^agent-[a-z0-9_-]+$/i.test(basename) ? basename : null);
      return id ? { originId: parent ? `${parent.toLowerCase()}/${id}` : id.toLowerCase(), parentOriginId: parent?.toLowerCase(), flatSubagent, reducer: claudeReducer(id.toLowerCase(), parent?.toLowerCase(), flatSubagent) } : null;
    },
    source(state) {
      if (state.clientNames.length === 1) return { id: `client-${digest(state.clientNames[0])}`, label: state.clientNames[0], icon: 'message', evidence: 'clientName' };
      if (state.clientNames.length > 1 || state.entrypoints.length > 1) return { id: 'claude-unknown', label: '来源待识别', icon: 'message', evidence: 'conflicting client markers' };
      if (state.entrypoints[0] === 'cli') return { id: 'claude-cli', label: 'Claude CLI 入口', icon: 'terminal', evidence: 'entrypoint:cli' };
      if (state.entrypoints[0] === 'sdk-ts') return { id: 'claude-sdk', label: 'Claude SDK（客户端未知）', icon: 'message', evidence: 'entrypoint:sdk-ts; client unknown' };
      return { id: 'claude-unknown', label: '来源待识别', icon: 'message', evidence: 'Claude-compatible JSONL' };
    },
  },
];
export const getConnector = id => {
  const connector = registry.find(item => item.id === id);
  if (!connector) throw Object.assign(new Error('暂不支持这种会话格式，请选择已提供的来源，或使用标准导入。'), {code: 'UNSUPPORTED_FORMAT', status: 400});
  return connector;
};

export function directoryDiagnostic(error, root, connectorId, subject = '会话目录') {
  const permission = ['EACCES', 'EPERM', 'READ_PERMISSION'].includes(error?.code);
  const missing = ['ENOENT', 'ENOTDIR', 'DIRECTORY_NOT_FOUND'].includes(error?.code);
  return {code: permission ? 'READ_PERMISSION' : missing ? 'DIRECTORY_NOT_FOUND' : 'DIRECTORY_UNAVAILABLE',
    message: permission ? `无法读取${subject}，请检查系统的文件访问权限，或重新选择可读目录。` :
      missing ? `未找到${subject}，请确认来源已安装并产生过会话，或手动选择正确目录。` : `暂时无法检查${subject}，请确认目录仍可访问后重试。`,
    action: permission ? '检查系统文件访问权限，或重新选择可读目录。' : missing ? '启动来源应用产生会话，或手动选择数据目录。' : '确认目录可访问后重试。',
    ...(root ? {root} : {}), ...(connectorId ? {connectorId} : {})};
}

// Only list actual name-storage files. Discovery never opens their contents.
function nameRoots(roots, diagnostics = [], connectorId = 'codex-rollout') {
  const found = new Set(), visited = new Set();
  for (const requested of roots) {
    try {
      const root = realpathSync(requested);
      if (visited.has(root)) continue;
      visited.add(root);
      if (!statSync(root).isDirectory()) throw Object.assign(new Error(), {code: 'ENOTDIR'});
      const entries = readdirSync(root, {withFileTypes: true});
      if (entries.some(entry => entry.isFile() && (entry.name === 'session_index.jsonl' || /^state_\d+\.sqlite$/.test(entry.name)))) found.add(root);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) diagnostics.push(directoryDiagnostic(error, requested, connectorId, '名称资料目录'));
    }
  }
  return [...found];
}

// Codex rollouts identify themselves in the first complete session_meta line.
// Probe at most 1 MB before admitting a file into the parser or SQLite cursor
// cache. A UUID-shaped filename alone does not authorize reading its body.
async function codexHeader(file, root, expectedId) {
  const real = await fs.realpath(file);
  if (await fs.realpath(root) !== root || !within(root, real)) throw new Error('来源文件超出已配置的数据范围');
  const handle = await fs.open(real, 'r');
  try {
    if (!within(root, await fs.realpath(real))) throw new Error('来源文件超出已配置的数据范围');
    let prefix = Buffer.alloc(0), offset = 0;
    while (offset < 1024 * 1024) {
      const buffer = Buffer.alloc(16 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) return false;
      offset += bytesRead; prefix = Buffer.concat([prefix, buffer.subarray(0, bytesRead)]);
      const end = prefix.indexOf(10);
      if (end < 0) continue;
      try {
        const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(prefix.subarray(0, end)));
        return header.type === 'session_meta' && typeof header.payload?.id === 'string' && header.payload.id.toLowerCase() === expectedId;
      } catch { return false; }
    }
    return false;
  } finally { await handle.close(); }
}
export const connectorCatalog = () => registry.map(({ id, version, name, displayName, icon, configFields, capabilities, defaultRoots, metadataRoots }) => ({ id, version, name, displayName, icon, configFields, capabilities, defaultRoots: defaultRoots(), metadataRootSuggestions: nameRoots(metadataRoots?.() || []) }));

export function storageRoot(root, connectorId) {
  let cursor = path.resolve(root);
  while (cursor !== path.dirname(cursor)) {
    const base = path.basename(cursor);
    if (connectorId === 'codex-rollout' && ['sessions', 'archived_sessions'].includes(base)) return path.dirname(cursor);
    if (connectorId === 'claude-jsonl' && base === 'projects') return path.dirname(cursor);
    cursor = path.dirname(cursor);
  }
  return path.resolve(root);
}

export async function discover({ connectorId, roots } = {}) {
  const candidates = [], diagnostics = [], seen = new Map();
  for (const connector of connectorId ? [getConnector(connectorId)] : registry) {
    for (const root of roots || connector.defaultRoots()) {
      try {
        const canonical = await fs.realpath(root);
        if (!(await fs.stat(canonical)).isDirectory()) throw Object.assign(new Error(), {code: 'ENOTDIR'});
        await fs.access(canonical, constants.R_OK | constants.X_OK);
        // Discovery reads only directory metadata, never session text.
        const previous = seen.get(canonical);
        if (previous) {
          if (!previous.connectorIds.includes(connector.id)) {
            previous.connectorIds.push(connector.id);
            previous.recognition = '此目录可能使用多种兼容格式，请选择格式后预览确认。';
          }
          continue;
        }
        const metadataRootSuggestions = connector.metadataRoots ? nameRoots([storageRoot(canonical, connector.id), ...connector.metadataRoots()], diagnostics, connector.id) : [];
        if (connector.metadataRoots && !metadataRootSuggestions.length) diagnostics.push({code: 'NAME_METADATA_NOT_FOUND', connectorId: connector.id, root: canonical,
          message: '暂未找到可用的会话名称资料位置，仍可接入日志并临时显示首条有效消息。',
          action: '如有独立名称存储，可在预览前手动选择名称资料目录；也可先继续。'});
        const candidate = {connectorId: connector.id, connectorIds: [connector.id], name: connector.name,
          displayName: connector.displayName || connector.name, icon: connector.icon, root: canonical,
          recognition: '已找到候选目录，尚未读取会话；格式与客户端身份将在预览时确认。',
          evidence: [roots ? '用户指定目录' : '当前用户环境与连接器默认位置', '目录存在且可访问'],
          capabilities: connector.capabilities, metadataRootSuggestions};
        seen.set(canonical, candidate); candidates.push(candidate);
      } catch (error) { diagnostics.push(directoryDiagnostic(error, root, connector.id)); }
    }
  }
  if (!candidates.length && !diagnostics.length) diagnostics.push({code: 'NO_SOURCES_FOUND', message: '暂未发现兼容会话目录。', action: '手动选择来源目录，或使用标准导入。'});
  Object.defineProperty(candidates, 'diagnostics', {value: diagnostics});
  return candidates;
}

export async function scan(connection, { loadCursor = () => null, saveCursor = () => {}, removeCursor = () => {}, maxRecords = Infinity, now = Date.now() } = {}) {
  const connector = getConnector(connection.connectorId);
  const listed = await listJSONL(connection.root, { expectedRoot: connection.canonicalRoot || connection.root });
  const records = [], warnings = [...listed.warnings], pendingNaming = [], observedRecords = [], diagnostics = [];
  const days = historyDays(connection.historyDays);
  let unknownTime = 0, futureTime = 0, recognizedFiles = 0, unreadableFiles = 0, scanTruncated = listed.warnings.some(value => /超过读取上限/.test(value));
  for (const file of listed.files) {
    const identity = connector.identify(file);
    if (!identity) continue;
    try {
      const key = `${connection.connectorId}:${file}`;
      const previous = await loadCursor(key);
      // Old, fully read files need only a filesystem metadata check. mtime is
      // used to detect change, never to determine conversation activity.
      let unchangedExpired = false;
      if (typeof previous?.state?.latest === 'number' && previous.state.latest > 0 && previous.state.latest < now - days * 86400000 && previous.offset === previous.size &&
        (connection.connectorId !== 'codex-rollout' || previous.state.metadataFound)) {
        const real = await fs.realpath(file);
        if (await fs.realpath(listed.root) !== listed.root || !within(listed.root, real)) throw new Error('来源文件超出已配置的数据范围');
        const stat = await fs.stat(real);
        unchangedExpired = stat.isFile() && stat.dev === previous.dev && stat.ino === previous.ino && stat.size === previous.size && stat.mtimeMs === previous.mtimeMs && stat.ctimeMs === previous.ctimeMs;
      }
      if (!unchangedExpired && connection.connectorId === 'codex-rollout' && !await codexHeader(file, listed.root, identity.originId)) {
        await removeCursor(key);
        warnings.push(`${path.basename(file)}: 未找到与文件身份匹配的首行 metadata，未读取正文`);
        continue;
      }
      if (previous && previous.state.namingVersion !== NAMING_VERSION) previous.state.preventFirstMessageCapture = true;
      const result = unchangedExpired ? { cursor: previous, warnings: [] } : await readJSONL(file, listed.root, previous, empty, identity.reducer, { expectedRoot: listed.root });
      warnings.push(...result.warnings.map(w => `${path.basename(file)}: ${w}`));
      if (result.cursor.offset < result.cursor.size) scanTruncated = true;
      const state = result.cursor.state;
      if (!unchangedExpired) await saveCursor(key, result.cursor);
      if (connection.connectorId === 'codex-rollout' && !state.metadataFound) { warnings.push(`${path.basename(file)}: 未找到与文件身份匹配的 metadata`); continue; }
      if (!state.timeline.length && !state.title && !state.metadataFound && !state.formatFound) continue;
      recognizedFiles++;
      if (!state.timeline.length && !state.title && !state.metadataFound) continue;
      const prefix = `${connection.connectorId}:${digest(connection.storageId)}`;
      const source = connection.identity ? { ...connection.identity, evidence: 'user-confirmed connection identity' } : connector.source(state);
      const proposedParent = identity.parentOriginId || state.parentOriginId;
      const parent = typeof proposedParent === 'string' && proposedParent.match(UUID)?.[0] === proposedParent ? proposedParent.toLowerCase() : null;
      const originId = identity.flatSubagent && parent ? `${parent}/${identity.originId}` : identity.originId;
      const id = `${prefix}:${originId}`;
      const observation = { connectionId: connection.id, source, historyDays: days, allowAI: connection.allowAI === true, includeSummary: connection.allowAI === true && connection.includeSummary === true, includeNaming: connection.allowAI === true && connection.includeNaming === true };
      observedRecords.push({ id, observation });
      if (!inHistory(state.latest, days, now)) {
        if (typeof state.latest !== 'number' || !Number.isFinite(state.latest) || state.latest <= 0) unknownTime++;
        else if (state.latest > now) futureTime++;
        continue;
      }
      const record = {
        id, originId, connectorId: connection.connectorId, kind: 'session', source,
        title: state.title || '未命名会话', sourceTitle: state.sourceTitle || '', titleBasis: state.sourceTitle ? 'claude-custom-title' : state.firstMessage || state.title ? 'first-message' : 'unknown',
        firstMessage: state.firstMessage || '', latestMessage: state.latestMessage || '', sourceNameChecked: state.sourceTitleSeen === true,
        createdAt: state.created, createdAtBasis: state.createdAtBasis,
        earliestActivityAt: state.earliest, updatedAt: state.latest, syncedAt: now, status: 'unknown',
        summary: state.summary, timeline: state.timeline, parentId: parent ? `${prefix}:${parent}` : null,
        locator: file, capabilities: { open: false, history: true, realtime: false },
        observations: [observation],
      };
      records.push(record);
      pendingNaming.push({ record, state, cursor: result.cursor, file, key, identity });
      if (records.length >= maxRecords) { scanTruncated = true; break; }
    } catch (error) {
      warnings.push(`${path.basename(file)}: ${error.message}`);
      if (['EACCES', 'EPERM'].includes(error.code)) { unreadableFiles++; diagnostics.push(directoryDiagnostic(error, file, connector.id)); }
    }
  }
  if (unknownTime) warnings.push(`${unknownTime} 条会话缺少可靠活动时间，未纳入近 ${days} 天任务`);
  if (futureTime) warnings.push(`${futureTime} 条会话的活动时间在未来，未纳入近期任务`);
  const metadata = connection.connectorId === 'codex-rollout' ? await readCodexNames(connection, records.map(r => r.originId), new Map(records.map(r => [r.originId, r.firstMessage]))) : null;
  if (metadata) warnings.push(...metadata.warnings);
  for (const pending of pendingNaming) {
    const { record, state, cursor, file, key, identity } = pending;
    let changed = false;
    if (state.namingVersion !== NAMING_VERSION) {
      const fromDB = metadata?.firstMessages.get(record.originId);
      state.firstMessage = meaningfulMessage('user', fromDB || '');
      if (!state.firstMessage || connection.connectorId === 'claude-jsonl') {
        // Upgrade old cursors from a bounded prefix, never replay all history.
        try {
          const prefix = await readJSONL(file, listed.root, null, empty, identity.reducer, { maxBytes: 1024 * 1024, expectedRoot: listed.root });
          state.firstMessage ||= prefix.cursor.state.firstMessage;
          if (prefix.cursor.state.sourceTitleSeen) { state.sourceTitle = prefix.cursor.state.sourceTitle; state.sourceTitleSeen = true; }
          if (connection.connectorId === 'claude-jsonl') {
            const tailTitle = await latestClaudeTitle(file, listed.root, identity.reducer);
            if (tailTitle !== null) { state.sourceTitle = tailTitle.sourceTitle; state.sourceTitleUpdatedAt = tailTitle.sourceTitleUpdatedAt; state.sourceTitleSeen = true; }
          }
        } catch { warnings.push(`${path.basename(file)}: 旧缓存命名依据补充失败，保留现有记录`); }
      }
      state.latestMessage = [...state.timeline].reverse().map(item => meaningfulMessage(item.role, item.text)).find(Boolean) || '';
      state.namingVersion = NAMING_VERSION; state.preventFirstMessageCapture = !state.firstMessage;
      state.title = state.sourceTitle || cut(state.firstMessage, 120);
      changed = true;
    }
    if (!state.firstMessage && metadata?.firstMessages.get(record.originId)) {
      state.firstMessage = meaningfulMessage('user', metadata.firstMessages.get(record.originId));
      if (state.firstMessage) { state.preventFirstMessageCapture = false; changed = true; }
    }
    record.firstMessage = cut(state.firstMessage, 1200);
    record.latestMessage = cut(state.latestMessage, 1200);
    record.namingVersion = NAMING_VERSION;
    const sourceName = metadata?.names.get(record.originId);
    record.sourceTitle = sourceName?.sourceTitle || state.sourceTitle || '';
    record.sourceTitleUpdatedAt = sourceName?.sourceTitleUpdatedAt ?? state.sourceTitleUpdatedAt ?? null;
    record.sourceNameChecked = metadata?.checked === true || state.sourceTitleSeen === true;
    record.titleBasis = sourceName?.titleBasis || (state.sourceTitle ? 'claude-custom-title' : record.firstMessage || state.title ? 'first-message' : 'unknown');
    record.title = record.sourceTitle || cut(record.firstMessage, 120) || state.title || '未命名会话';
    if (changed) await saveCursor(key, cursor);
  }
  const unique = [...new Map(records.map(record => [record.id, record])).values()];
  const sources = [...new Map(unique.map(record => [record.source.id, record.source])).values()];
  const summary = {mainCount: unique.filter(record => !record.parentId).length, childCount: unique.filter(record => record.parentId).length,
    totalCount: unique.length, truncated: scanTruncated, scanTruncated, partial: warnings.length > 0, sampleLimited: false,
    identity: sources.length === 1 ? sources[0] : sources.length > 1 ? {id: 'mixed', label: '多个客户端', icon: 'message', evidence: '所选目录内存在不同来源标记'} : null};
  return { records, observedRecords, warnings: warnings.slice(0, 100), capabilities: connector.capabilities, summary, diagnostics: diagnostics.slice(0, 100),
    format: {jsonlFiles: listed.files.length, recognizedFiles, unreadableFiles,
      otherFiles: listed.files.length ? false : await containsOtherFiles(listed.root)} };
}

async function containsOtherFiles(root, dir = root, depth = 0) {
  if (depth > 16) return false;
  if (await fs.realpath(root) !== root || !within(root, await fs.realpath(dir))) throw new Error('来源目录已被重定向，请重新选择目录');
  for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
    if (entry.isSymbolicLink() || entry.name === '.DS_Store') continue;
    if (entry.isFile()) return true;
    if (entry.isDirectory() && await containsOtherFiles(root, path.join(dir, entry.name), depth + 1)) return true;
  }
  return false;
}

async function latestClaudeTitle(file, root, reduce) {
  const real = await fs.realpath(file);
  if (await fs.realpath(root) !== root || !within(root, real)) throw new Error('来源超出范围');
  const handle = await fs.open(real, 'r');
  try {
    if (await fs.realpath(root) !== root || !within(root, await fs.realpath(real))) throw new Error('来源超出范围');
    const stat = await handle.stat(), start = Math.max(0, stat.size - 256 * 1024), bytes = Buffer.alloc(stat.size - start);
    await handle.read(bytes, 0, bytes.length, start);
    const lines = bytes.toString('utf8').split('\n');
    if (start) lines.shift();
    lines.pop(); // An incomplete trailing line is not yet a valid rename event.
    const state = empty();
    for (const line of lines) {
      try { const entry = JSON.parse(line); if (entry.type === 'custom-title') reduce(state, entry); } catch {}
    }
    return state.sourceTitleSeen ? { sourceTitle: state.sourceTitle, sourceTitleUpdatedAt: state.sourceTitleUpdatedAt } : null;
  } finally { await handle.close(); }
}
