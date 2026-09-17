import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startupInstructions } from './start-instructions.mjs';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor !== 24 || nodeMinor < 12) {
  console.error('Task Out 需要 Node.js 24（至少 24.12.0，低于 25），请从 https://nodejs.org/ 安装对应版本。');
  process.exit(1);
}
const port = Number(process.env.TASK_OUT_PORT || 4518);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('TASK_OUT_PORT 需要是 1–65535 的端口号。'); process.exit(1);
}
const { health, readRuntime, stopService } = await import('./service-runtime.mjs');
const { defaultDataDir } = await import('../service/server.mjs');

async function describe(existing, reused = false) {
  const runtime = await readRuntime(port);
  for (const line of startupInstructions(existing, runtime, {port, reused})) console.log(line);
}
async function launch() {
  const directory = defaultDataDir(); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const log = await fs.open(path.join(directory, 'service.log'), 'a', 0o600);
  await log.chmod(0o600);
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./service-process.mjs', import.meta.url))], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), detached: true, env: process.env,
      stdio: ['ignore', log.fd, log.fd, 'ipc']
    });
    await new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => { child.kill('SIGTERM'); finish(Error('后台启动超时，请稍后重试。')); }, 15000);
      const finish = error => {
        if (done) return; done = true;
        clearTimeout(timer); child.removeAllListeners('message'); child.removeAllListeners('exit');
        if (child.connected) child.disconnect(); child.unref();
        error ? reject(error) : resolve();
      };
      child.once('error', finish);
      child.once('exit', () => finish(Error('后台服务未能启动，请检查运行环境。')));
      child.on('message', value => { if (value?.type === 'ready') finish(); else if (value?.type === 'error') finish(Error(value.message)); });
    });
  } finally { await log.close(); }
}
try {
  const action = process.argv[2] || '';
  if (!['', '--stop', '--restart', '--foreground'].includes(action)) throw Error('支持 npm start、npm stop、npm restart 或 npm run service:foreground。');
  if (action === '--stop' || action === '--restart') {
    const stopped = await stopService(port);
    console.log(stopped ? 'Task Out 本机服务已停止，记录与配对保留。' : 'Task Out 本机服务未运行。');
    if (action === '--stop') process.exit(0);
  }
  const existing = await health(port);
  if (existing?.name === 'Task Out') await describe(existing, true);
  else if (action === '--foreground') await import('./service-process.mjs');
  else {
    try { await launch(); }
    catch (error) {
      const raced = await health(port);
      if (raced?.name !== 'Task Out') throw error;
      await describe(raced, true); process.exit(0);
    }
    const started = await health(port);
    if (started?.name !== 'Task Out') throw Error('后台服务启动后未通过连接检查，请重试。');
    await describe(started);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
