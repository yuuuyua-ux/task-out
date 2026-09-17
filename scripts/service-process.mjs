import { startServer } from '../service/server.mjs';
import { writeRuntime, removeRuntime } from './service-runtime.mjs';

let runtime, running;
try {
  running = await startServer({
    mode: process.connected ? 'background' : 'foreground',
    async onReady(details) {
      runtime = { pid: process.pid, ...details };
      delete runtime.dataDir;
      await writeRuntime(runtime);
      if (process.connected) process.send({ type: 'ready', port: details.port });
      else {
        console.log(`Task Out 本机服务：http://127.0.0.1:${details.port}`);
        console.log(`首次配对码：${details.pairingCode}（10 分钟有效，仅能使用一次）`);
        console.log('当前为前台调试模式，按 Ctrl+C 停止。日常使用请运行 npm start。');
      }
    },
    async onPaired() {
      if (!runtime) return;
      delete runtime.pairingCode; delete runtime.pairExpires;
      await writeRuntime(runtime);
    },
    async onClosed() { if (runtime) await removeRuntime(runtime); }
  });
  const stop = () => { void running.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch (error) {
  const message = error.code === 'EADDRINUSE' ? '服务端口已被占用。' : '服务启动失败，请检查 Node.js 版本和本机数据目录权限。';
  if (process.connected) process.send({ type: 'error', message }, () => process.disconnect());
  else console.error(message);
  process.exitCode = 1;
}
