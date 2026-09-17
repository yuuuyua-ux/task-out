import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const extensionRoot = path.join(root, 'extension');
const issues = [], javascript = [];

async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(file)) javascript.push(file);
  }
}
await Promise.all(['extension', 'service', 'scripts', 'tests'].map(name => walk(path.join(root, name))));
for (const file of javascript.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0 || result.error) issues.push(`${path.relative(root, file)}：${result.stderr?.trim() || result.error?.message || '语法检查未完成'}`);
}

async function resource(value, from, label) {
  if (typeof value !== 'string' || !value || /^[a-z][\w+.-]*:|^\/\//i.test(value)) { issues.push(`${label} 需要本地资源路径`); return; }
  const resolved = path.resolve(path.dirname(from), value.split(/[?#]/)[0]);
  if (resolved !== extensionRoot && !resolved.startsWith(extensionRoot + path.sep)) { issues.push(`${label} 超出 extension/ 范围`); return; }
  try { if (!(await fs.stat(resolved)).isFile()) throw new Error(); }
  catch { issues.push(`${label} 不存在：${value}`); }
}

try {
  const manifestPath = path.join(extensionRoot, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.manifest_version !== 3) issues.push('manifest 必须使用 Chrome MV3');
  if (!manifest.background?.service_worker) issues.push('manifest 缺少后台 service_worker');
  else await resource(manifest.background.service_worker, manifestPath, '后台脚本');
  const entries = Object.values(manifest.chrome_url_overrides || {});
  if (!manifest.chrome_url_overrides?.newtab) issues.push('manifest 缺少新标签页入口');
  if (manifest.action?.default_popup) entries.push(manifest.action.default_popup);
  for (const entry of entries) await resource(entry, manifestPath, 'HTML 入口');
  const actionIcons = typeof manifest.action?.default_icon === 'string' ? [manifest.action.default_icon] : Object.values(manifest.action?.default_icon || {});
  for (const icon of [...Object.values(manifest.icons || {}), ...actionIcons]) await resource(icon, manifestPath, '扩展图标');
  for (const group of manifest.content_scripts || []) for (const entry of [...(group.js || []), ...(group.css || [])]) await resource(entry, manifestPath, '内容脚本资源');

  const indexPath = path.join(extensionRoot, 'index.html');
  const html = await fs.readFile(indexPath, 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi)];
  if (!scripts.length) issues.push('index.html 没有脚本入口');
  for (const match of scripts) await resource(match[2], indexPath, '页面脚本');
  for (const match of html.matchAll(/<link\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi)) await resource(match[2], indexPath, '页面样式或图标');
  if (manifest.background?.service_worker) {
    const workerPath = path.resolve(extensionRoot, manifest.background.service_worker);
    const worker = await fs.readFile(workerPath, 'utf8');
    for (const call of worker.matchAll(/\bimportScripts\s*\(([^)]*)\)/g)) for (const quoted of call[1].matchAll(/(["'])(.*?)\1/g)) await resource(quoted[2], workerPath, '后台依赖');
  }
} catch (error) { issues.push(`入口检查失败：${error.message}`); }

if (issues.length) { console.error(issues.join('\n')); process.exitCode = 1; }
else console.log(`检查通过：${javascript.length} 个 JavaScript 文件语法与扩展入口资源有效。`);
