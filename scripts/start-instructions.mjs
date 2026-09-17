import { fileURLToPath } from 'node:url';

// Keep the launch instructions testable without starting or stopping a service.
export function startupInstructions(existing, runtime, {port, reused = false, now = Date.now(),
  launcherPath = fileURLToPath(new URL('./Start Task Out.command', import.meta.url)),
  restartPath = fileURLToPath(new URL('./Restart Task Out.command', import.meta.url))} = {}) {
  const lines = [
    reused ? `Task Out 本机服务已在 http://127.0.0.1:${port} 运行，继续使用现有服务。` : `Task Out 已在后台启动：http://127.0.0.1:${port}`,
    '一键启动脚本（双击运行）：', launcherPath,
    '服务地址（复制到 Task Out 设置中）：', `http://127.0.0.1:${port}`
  ];
  const current = runtime?.runId && runtime.runId === existing.runId;
  if (current && runtime.pairingCode && Number.isFinite(runtime.pairExpires) && runtime.pairExpires > now) {
    const seconds = Math.floor((runtime.pairExpires - now) / 1000);
    const deadline = new Date(runtime.pairExpires).toLocaleString('zh-CN', {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false});
    lines.push('首次配对码（复制下面这一行）：', String(runtime.pairingCode),
      `有效截止：${deadline}（本机时间）；剩余 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒，仅能使用一次。`,
      '在 Task Out「设置 → 管理会话来源」中填写服务地址与配对码。');
  } else {
    lines.push(current && runtime.pairingCode ? '首次配对码已过期。' : current ? '本次配对码已使用，或当前没有可用的配对码。' : '当前没有可用的首次配对码。');
  }
  lines.push('配对码过期或已使用时，双击以下脚本重启服务获取新码（原有配对保留）：', restartPath,
    '也可在项目目录运行 npm restart；再次双击 Start Task Out.command 或运行 npm start 只会复用现有服务。');
  lines.push('已完成配对的扩展在服务或电脑重启后仍可连接，无需重新配对。',
    existing.mode === 'background' ? '现在可以关闭终端窗口。需要停止时，在「设置 → 管理会话来源」点击「停止服务」。' : '当前服务为旧版或前台模式；请先在原终端停止，再运行本脚本，才能切换为后台运行。',
    '服务不会开机自启；电脑重启后再次双击上方的一键启动脚本即可。');
  return lines;
}
