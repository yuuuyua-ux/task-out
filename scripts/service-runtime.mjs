import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultDataDir } from '../service/server.mjs';

export const runtimeFile = port => path.join(defaultDataDir(), `service-${port}.json`);
export async function readRuntime(port) {
  try { return JSON.parse(await fs.readFile(runtimeFile(port), 'utf8')); } catch { return null; }
}
export async function writeRuntime(value) {
  const filename = runtimeFile(value.port), temporary = `${filename}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
}
export async function removeRuntime(value) {
  if ((await readRuntime(value.port))?.runId === value.runId) await fs.rm(runtimeFile(value.port), { force: true });
}
export function health(port) {
  return new Promise(resolve => {
    const request = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1000 }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 8192) request.destroy(); });
      response.on('error', () => resolve(null));
      response.on('end', () => { try { resolve(response.statusCode === 200 ? JSON.parse(body) : null); } catch { resolve(null); } });
    });
    request.on('timeout', () => request.destroy()); request.on('error', () => resolve(null));
  });
}
export async function stopService(port) {
  const current = await health(port);
  if (!current) return false;
  const runtime = await readRuntime(port);
  // Never signal a PID from a stale file or another data directory.
  if (current.name !== 'Task Out' || !runtime?.runId || runtime.runId !== current.runId ||
      runtime.instanceId !== current.instanceId || !Number.isSafeInteger(runtime.pid) || runtime.pid <= 1) {
    throw Error('无法确认当前服务的启动身份。旧版本请在原启动终端按 Ctrl+C 停止，再运行一键启动脚本。');
  }
  process.kill(runtime.pid, 'SIGTERM');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const next = await health(port);
    const remaining = await readRuntime(port);
    if ((!next || next.runId !== runtime.runId) && remaining?.runId !== runtime.runId) return true;
    try { process.kill(runtime.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') { await removeRuntime(runtime); return true; } throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('服务仍在保存本轮同步，请稍后重新检查状态。');
}
