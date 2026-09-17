import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Store } from './store.mjs';
import { connectorCatalog, discover, directoryDiagnostic, getConnector, scan, storageRoot } from './connectors/registry.mjs';
import { selectDirectory } from './directory-picker.mjs';
import { within } from './connectors/jsonl.mjs';
import { HISTORY_DAYS, historyDays as normalizeHistoryDays, currentRecords } from './history.mjs';

export const VERSION = '1.0.0';
const sha256 = value => createHash('sha256').update(value).digest('hex');
export const defaultDataDir = () => process.env.TASK_OUT_DATA_DIR || (process.platform === 'darwin' ?
  path.join(os.homedir(), 'Library', 'Application Support', 'Task Out') : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'task-out'));
const extensionOrigin = value => typeof value === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(value);
const httpError = (message, status = 400, code = 'INVALID_REQUEST') => Object.assign(new Error(message), { status, code });
const directoryError = (error, root, connectorId, subject) => {
  const diagnostic = directoryDiagnostic(error, root, connectorId, subject);
  return httpError(diagnostic.message, diagnostic.code === 'READ_PERMISSION' ? 403 : 400, diagnostic.code);
};
const sameCode = (left, right) => typeof left === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

async function bodyJSON(req) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw httpError('需要 application/json 请求', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) throw httpError('请求内容超过 128 KB', 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpError('JSON 格式不正确'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError('请求需要 JSON 对象');
  return body;
}

export async function startServer({ port = Number(process.env.TASK_OUT_PORT || 4518), dataDir = defaultDataDir(), pairingCode = String(randomInt(10000000, 100000000)), pairingTtlMs = 10 * 60 * 1000, directoryPicker = selectDirectory, polling = true, mode = 'foreground', onReady = () => {}, onPaired = () => {}, onClosed = () => {} } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须是 0–65535 的整数');
  const store = new Store(dataDir);
  const runId = randomUUID(), startedAt = Date.now();
  let actualPort = port, attempts = 0, pairExpires = Date.now() + pairingTtlMs, pairUsed = false, closed = false, stopping = false, closePromise;
  let sequence = Promise.resolve();
  const exclusive = action => { const next = sequence.then(action); sequence = next.catch(() => {}); return next; };

  async function config(input, existing = null) {
    const connectorId = input.connectorId ?? existing?.connectorId;
    const connector = getConnector(connectorId);
    if (existing && connectorId !== existing.connectorId) throw httpError('更换格式需要新建连接');
    const rawRoot = input.root ?? existing?.root;
    if (typeof rawRoot !== 'string' || !path.isAbsolute(rawRoot) || rawRoot.length > 4096) throw httpError('请填写绝对目录路径');
    let root;
    try {
      root = await fs.realpath(rawRoot);
      if (!(await fs.stat(root)).isDirectory()) throw Object.assign(new Error(), {code: 'ENOTDIR'});
      await fs.access(root, fs.constants.R_OK | fs.constants.X_OK);
      // Toggling a flag must not silently authorize a root redirected since
      // setup. Only an explicit path submission may replace the saved scope.
      if (existing && input.root === undefined) root = existing.root;
    } catch (error) {
      if (existing && input.root === undefined && input.connectorId === undefined && input.storageId === undefined) root = existing.root;
      else throw directoryError(error, rawRoot, connectorId);
    }
    if (root === path.parse(root).root || root === os.homedir() || root === path.dirname(os.homedir())) throw httpError('请选择具体的会话数据目录，不能扫描整个主目录或磁盘');
    const canonicalStore = storageRoot(root, connectorId);
    const overlap = store.all('connections').find(item => item.connectorId === connectorId &&
      (item.canonicalStore === canonicalStore || within(item.root, root) || within(root, item.root)));
    const storageId = existing?.storageId || overlap?.storageId || input.storageId || canonicalStore;
    if (typeof storageId !== 'string' || storageId.length > 4096) throw httpError('存储身份不正确');
    const historyDays = input.historyDays ?? normalizeHistoryDays(existing?.historyDays);
    if (!HISTORY_DAYS.includes(historyDays)) throw httpError('获取范围需要为近 3、7 或 30 天');
    const pollIntervalMs = input.pollIntervalMs ?? existing?.pollIntervalMs ?? 60000;
    if (pollIntervalMs !== 0 && (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 5000 || pollIntervalMs > 86400000)) throw httpError('刷新间隔至少 5000 毫秒，或设为 0 仅手动');
    const name = input.name ?? existing?.name ?? connector.name;
    if (typeof name !== 'string' || !name.trim() || name.length > 120) throw httpError('连接名称需要 1–120 个字符');
    let identity = input.identity === null ? null : input.identity ?? existing?.identity ?? null;
    if (identity && (typeof identity !== 'object' || !/^[\w.-]{1,80}$/.test(identity.id) || typeof identity.label !== 'string' || !identity.label.trim() || identity.label.length > 80)) throw httpError('来源身份需要有效的 id 和显示名称');
    if (identity) identity = { id: identity.id, label: identity.label.trim(), icon: typeof identity.icon === 'string' && /^[\w-]{1,40}$/.test(identity.icon) ? identity.icon : 'message' };
    let metadataRoot = existing?.metadataRoot || '', canonicalMetadataRoot = existing?.canonicalMetadataRoot || metadataRoot;
    if (input.metadataRoot !== undefined) {
      if (typeof input.metadataRoot !== 'string') throw httpError('名称元数据目录需要是路径字符串');
      const requested = input.metadataRoot.trim();
      if (requested && connectorId !== 'codex-rollout') throw httpError('此连接器不支持独立名称元数据目录');
      if (requested && (!path.isAbsolute(requested) || requested.length > 4096)) throw httpError('名称元数据目录需要是绝对路径');
      if (requested) {
        try {
          metadataRoot = await fs.realpath(requested);
          if (!(await fs.stat(metadataRoot)).isDirectory()) throw Object.assign(new Error(), {code: 'ENOTDIR'});
          await fs.access(metadataRoot, fs.constants.R_OK | fs.constants.X_OK);
        } catch (error) { throw directoryError(error, requested, connectorId, '名称资料目录'); }
        canonicalMetadataRoot = metadataRoot;
      } else { metadataRoot = ''; canonicalMetadataRoot = ''; }
    }
    for (const key of ['enabled', 'allowAI', 'includeSummary', 'includeNaming']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw httpError(`${key} 必须是布尔值`);
    const allowAI = input.allowAI ?? existing?.allowAI ?? false;
    const enabled = input.enabled ?? existing?.enabled ?? false;
    return { ...existing, id: existing?.id || randomUUID(), connectorId, root, canonicalRoot: root, canonicalStore, storageId, name: name.trim(), historyDays, pollIntervalMs, metadataRoot, canonicalMetadataRoot,
      allowAI, includeSummary: allowAI && (input.includeSummary ?? existing?.includeSummary ?? false), includeNaming: allowAI && (input.includeNaming ?? existing?.includeNaming ?? false), enabled, identity,
      capabilities: connector.capabilities, status: enabled ? 'pending' : 'paused', lastSyncedAt: existing?.lastSyncedAt ?? null, errors: existing?.errors || [] };
  }

  async function preview(connection) {
    let result;
    try { result = await scan(connection); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw directoryError(error, connection.root, connection.connectorId);
      throw error;
    }
    if (!result.format.recognizedFiles && result.format.unreadableFiles)
      throw httpError('会话文件无法读取，请检查系统文件访问权限后重新预览。', 403, 'READ_PERMISSION');
    if (!result.format.recognizedFiles && (result.format.jsonlFiles || result.format.otherFiles))
      throw httpError('这个目录没有可识别的会话格式，请选择对应来源的数据目录，或改用标准导入。', 400, 'UNSUPPORTED_FORMAT');
    const records = [...new Map(result.records.map(record => [record.id, record])).values()].sort((a, b) => Number(!!a.parentId) - Number(!!b.parentId) || (b.updatedAt || 0) - (a.updatedAt || 0));
    const diagnostics = [...result.diagnostics];
    if (!records.length && !diagnostics.some(value => value.code === 'READ_PERMISSION') && !result.summary.scanTruncated) diagnostics.push({code: 'NO_RECENT_SESSIONS',
      message: `近 ${connection.historyDays} 天没有找到可显示的会话，可以保留此来源等待新会话。`,
      action: '可扩大到近 7 或 30 天，或启用后等待来源产生新会话。'});
    if (result.summary.scanTruncated) diagnostics.push({code: 'PREVIEW_INCOMPLETE',
      message: '此次预览达到读取上限，数量仅覆盖已读取部分。', action: '选择更具体的目录，或启用后继续增量同步。'});
    return {records: records.slice(0, 10), warnings: result.warnings, capabilities: result.capabilities,
      summary: {...result.summary, sampleLimited: records.length > 10}, diagnostics, canEnable: true};
  }

  async function sync(connectionId, dueOnly = false) {
    const connections = store.all('connections').filter(item => (!connectionId || item.id === connectionId) && item.enabled);
    const errors = [], observedRecords = [];
    for (const connection of connections) {
      if (dueOnly && (!connection.pollIntervalMs || Date.now() - (connection.lastAttemptAt || 0) < connection.pollIntervalMs)) continue;
      try {
        const result = await scan(connection, {
          loadCursor: key => store.get('cursors', key), saveCursor: (key, cursor) => store.put('cursors', cursor, key), removeCursor: key => store.remove('cursors', key),
        });
        for (const record of result.records) store.mergeRecord(record);
        observedRecords.push(...result.observedRecords);
        store.put('connections', { ...connection, status: result.warnings.length ? 'partial' : 'ready', lastSyncedAt: Date.now(), lastAttemptAt: Date.now(), count: result.records.length, errors: result.warnings });
        for (const warning of result.warnings) errors.push({ connectionId: connection.id, message: warning });
      } catch (error) {
        const message = ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? '数据目录离线或不可读取，已保留缓存' : error.message;
        store.put('connections', { ...connection, status: 'offline', lastAttemptAt: Date.now(), errors: [message] });
        errors.push({ connectionId: connection.id, message });
      }
    }
    // Include restrictive observations even when that connection's narrower
    // window does not return the record. Another connection may admit it.
    store.mergeObservations(observedRecords);
    const allConnections = store.all('connections');
    return { records: currentRecords(store.all('records'), allConnections), connections: allConnections, errors };
  }

  const server = http.createServer(async (req, res) => {
    const browserOrigin = req.headers.origin;
    const extensionId = req.headers['x-task-out-extension'];
    let origin = browserOrigin;
    const send = (status, value) => {
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (extensionOrigin(origin)) Object.assign(headers, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
      res.writeHead(status, headers); res.end(JSON.stringify(value));
    };
    try {
      if (![ `127.0.0.1:${actualPort}`, `localhost:${actualPort}` ].includes(req.headers.host)) throw httpError('仅接受本机地址', 403);
      // Chrome's privileged MV3 fetch may omit Origin. In that case the
      // explicit extension id selects the identity still protected by the
      // pairing code/token. A present browser Origin always takes precedence:
      // websites (including opaque/null origins) cannot use this fallback.
      if (browserOrigin !== undefined) {
        if (!extensionOrigin(browserOrigin)) throw httpError('来源未授权', 403);
        if (extensionId !== undefined && (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId) || browserOrigin !== `chrome-extension://${extensionId}`))
          throw httpError('扩展身份与来源不一致', 403);
      } else if (extensionId !== undefined) {
        if (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)) throw httpError('扩展身份不正确', 403);
        origin = `chrome-extension://${extensionId}`;
      }
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && pathname === '/health') {
        if (origin && !extensionOrigin(origin)) throw httpError('来源未授权', 403);
        send(200, { name: 'Task Out', version: VERSION, paired: store.tokenCount() > 0, instanceId: store.instanceId, runId, state: stopping ? 'stopping' : 'running', mode, startedAt }); return;
      }
      if (!extensionOrigin(origin)) throw httpError('需要受支持的扩展来源', 403);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Task-Out-Extension', 'Access-Control-Max-Age': '600' }); res.end(); return;
      }
      if (stopping) throw httpError('本机服务正在停止，已读取的记录会保留', 503);
      if (req.method === 'POST' && pathname === '/pair') {
        const input = await bodyJSON(req);
        if (pairUsed) throw httpError('这个配对码已经使用，请使用已保存的连接；如需重新配对，请重启本机服务取得新码。', 429, 'PAIR_CODE_USED');
        if (Date.now() > pairExpires || attempts >= 10) throw httpError('配对码已过期或尝试次数过多，请重启本机服务取得新码。', 429, 'PAIR_CODE_EXPIRED');
        attempts++;
        if (!sameCode(input.code, pairingCode)) throw httpError('配对码不正确，请复制启动窗口中的最新配对码后重试。', 401, 'PAIR_CODE_INVALID');
        const token = randomBytes(32).toString('hex'); store.addToken(sha256(token), origin);
        pairExpires = 0; pairUsed = true; // One successful pairing consumes the launch code.
        await Promise.resolve().then(onPaired).catch(() => {});
        send(200, { token }); return;
      }
      const bearer = String(req.headers.authorization || '').match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      if (!bearer || !store.authenticate(sha256(bearer), origin)) throw httpError('连接凭据已失效或尚未配对，请在接入引导中重新配对；已有记录仍会保留。', 401, 'CONNECTION_EXPIRED');
      if (req.method === 'POST' && pathname === '/v1/directories/select') {
        const input = await bodyJSON(req);
        if (Object.keys(input).length) throw httpError('目录选择不接受路径或脚本参数，请在系统窗口中选择。');
        send(200, await directoryPicker()); return;
      }
      if (req.method === 'GET' && pathname === '/v1/service') {
        send(200, { state: 'running', mode, startedAt, canStop: true }); return;
      }
      if (req.method === 'POST' && pathname === '/v1/service/stop') {
        await bodyJSON(req);
        stopping = true;
        // Send acknowledgement before closing this connection; wait for active
        // scans and writes to finish before closing SQLite. Tokens stay valid.
        res.once('finish', () => { void close().catch(() => {}); });
        send(200, { state: 'stopping' }); return;
      }
      if (req.method === 'DELETE' && pathname === '/v1/pair') { store.revokeToken(sha256(bearer)); send(200, { revoked: true }); return; }
      if (req.method === 'GET' && pathname === '/v1/connectors') { send(200, { connectors: connectorCatalog() }); return; }
      if (req.method === 'GET' && pathname === '/v1/connections') { send(200, { connections: store.all('connections') }); return; }
      if (req.method === 'POST' && pathname === '/v1/discover') {
        const input = await bodyJSON(req);
        if (input.roots !== undefined && (!Array.isArray(input.roots) || input.roots.length > 20 || input.roots.some(root => typeof root !== 'string' || !path.isAbsolute(root)))) throw httpError('发现范围需要不超过 20 个绝对目录');
        const candidates = await discover(input);
        const existing = store.all('connections');
        send(200, { candidates: candidates.map(candidate => ({ ...candidate, connected: existing.some(c => candidate.connectorIds.includes(c.connectorId) && c.root === candidate.root) })), diagnostics: candidates.diagnostics }); return;
      }
      if (req.method === 'POST' && pathname === '/v1/test') {
        const input = await bodyJSON(req);
        const connection = await config(input);
        send(200, await preview(connection)); return;
      }
      if (req.method === 'POST' && pathname === '/v1/connections') {
        const input = await bodyJSON(req);
        const result = await exclusive(async () => {
          const connection = await config(input);
          const duplicate = store.all('connections').find(c => c.connectorId === connection.connectorId && c.root === connection.root);
          if (duplicate) throw httpError('该目录已接入，请继续使用或编辑已有连接。', 409, 'CONNECTION_EXISTS');
          // Revalidate without writing cursors or records, even if the caller
          // skipped the preview screen. Unsupported formats cannot be enabled.
          await preview(connection);
          store.put('connections', connection);
          return connection;
        });
        send(201, { connection: result }); return;
      }
      const connectionMatch = pathname.match(/^\/v1\/connections\/([^/]+)$/);
      if (connectionMatch && ['PATCH', 'DELETE'].includes(req.method)) {
        const id = decodeURIComponent(connectionMatch[1]);
        const input = req.method === 'PATCH' ? await bodyJSON(req) : null;
        const result = await exclusive(async () => {
          const existing = store.get('connections', id);
          if (!existing) throw httpError('连接不存在', 404);
          if (req.method === 'DELETE') { store.remove('connections', id); store.updatePermissions(id); return { removed: true, cachedRecordsRetained: true }; }
          // Pausing and restricting AI must remain possible while the disk is offline.
          const updated = await config(input, existing);
          const duplicate = store.all('connections').find(connection => connection.id !== id && connection.connectorId === updated.connectorId && connection.root === updated.root);
          if (duplicate) throw httpError('该目录已接入，请继续使用或编辑已有连接。', 409, 'CONNECTION_EXISTS');
          if (input.root !== undefined || input.enabled === true && !existing.enabled) {
            try { await preview(updated); }
            catch (error) {
              // Re-enabling an existing offline source keeps its authorized
              // scope and cache. Explicitly choosing a new root must validate.
              if (input.root !== undefined || error.code === 'UNSUPPORTED_FORMAT') throw error;
            }
          }
          store.put('connections', updated); store.updatePermissions(id, updated);
          return { connection: updated };
        });
        send(200, result); return;
      }
      if (req.method === 'POST' && pathname === '/v1/sync') {
        const input = await bodyJSON(req);
        if (input.connectionId && !store.get('connections', input.connectionId)) throw httpError('连接不存在', 404);
        if (input.dueOnly !== undefined && typeof input.dueOnly !== 'boolean') throw httpError('dueOnly 需要是布尔值');
        send(200, await exclusive(() => sync(input.connectionId, input.dueOnly === true))); return;
      }
      const recordMatch = pathname.match(/^\/v1\/records\/([^/]+)$/);
      if (req.method === 'GET' && recordMatch) {
        const record = store.get('records', decodeURIComponent(recordMatch[1]));
        if (!record) throw httpError('记录不存在', 404);
        send(200, { record }); return;
      }
      throw httpError('接口不存在', 404);
    } catch (error) { if (!res.headersSent) send(error.status || 400, { error: error.status ? error.message : '操作失败，请检查连接配置或格式后重试。', code: error.status ? error.code || 'INVALID_REQUEST' : 'OPERATION_FAILED' }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (error) { store.close(); throw error; }
  actualPort = server.address().port;
  let interval, pollPending = false;
  if (polling) {
    interval = setInterval(() => {
      if (closed || stopping || pollPending) return;
      pollPending = true;
      exclusive(() => sync(null, true)).catch(() => {}).finally(() => { pollPending = false; });
    }, 5000);
    interval.unref();
  }
  const close = () => {
    if (closePromise) return closePromise;
    stopping = true; closed = true; clearInterval(interval);
    closePromise = (async () => {
      await new Promise(resolve => server.close(resolve)); await sequence; store.close(); await onClosed();
    })();
    return closePromise;
  };
  try { await onReady({ port: actualPort, pairingCode, pairExpires, dataDir, instanceId: store.instanceId, runId, startedAt }); }
  catch (error) { await close(); throw error; }
  return { server, store, port: actualPort, pairingCode, close };
}
