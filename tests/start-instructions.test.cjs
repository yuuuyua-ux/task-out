'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const now = Date.UTC(2026, 8, 17, 10, 0, 0);
const existing = {runId: 'fixture-run', mode: 'background'};
const options = {port: 49123, now, launcherPath: '/Applications/Task Out/scripts/Start Task Out.command', restartPath: '/Applications/Task Out/scripts/Restart Task Out.command'};
const render = async (runtime, changes = {}, mode = existing) => (await import('../scripts/start-instructions.mjs')).startupInstructions(mode, runtime, {...options, ...changes});

test('startup instructions provide standalone copyable address, code and actual launcher path', async () => {
  const lines = await render({runId: existing.runId, pairingCode: '12345678', pairExpires: now + 600000});
  assert.ok(lines.includes('http://127.0.0.1:49123')); assert.ok(lines.includes('12345678')); assert.ok(lines.includes(options.launcherPath)); assert.ok(lines.includes(options.restartPath));
  assert.match(lines.join('\n'), /有效截止：/); assert.match(lines.join('\n'), /剩余 10 分 0 秒/);
  assert.match(lines.join('\n'), /无需重新配对/); assert.match(lines.join('\n'), /现在可以关闭终端窗口/);
  const actual = await render(null, {launcherPath: undefined, restartPath: undefined});
  assert.ok(actual.includes(path.join(__dirname, '../scripts/Start Task Out.command')));
  assert.ok(actual.includes(path.join(__dirname, '../scripts/Restart Task Out.command')));
});

test('reusing a service reports remaining validity and keeps its original expiry', async () => {
  const runtime = {runId: existing.runId, pairingCode: '12345678', pairExpires: now + 600000};
  const before = await render(runtime), reused = await render(runtime, {reused: true, now: now + 190000});
  assert.match(reused.join('\n'), /继续使用现有服务/); assert.match(reused.join('\n'), /剩余 6 分 50 秒/);
  assert.doesNotMatch(reused.join('\n'), /10 分钟有效/);
  assert.equal(before.find(line => line.startsWith('有效截止')).split('；')[0], reused.find(line => line.startsWith('有效截止')).split('；')[0]);
});

test('expired, consumed and stale runtime codes are never printed and explain how to get a new code', async () => {
  for (const runtime of [
    {runId: existing.runId, pairingCode: 'DO_NOT_PRINT', pairExpires: now},
    {runId: existing.runId},
    {runId: 'old-run', pairingCode: 'DO_NOT_PRINT', pairExpires: now + 600000}, null
  ]) {
    const lines = await render(runtime, {reused: true}), message = lines.join('\n');
    assert.equal(message.includes('DO_NOT_PRINT'), false); assert.match(message, /npm restart/); assert.match(message, /npm start 只会复用/); assert.match(message, /无需重新配对/);
  }
  assert.match((await render({runId: existing.runId, pairingCode: 'expired', pairExpires: now - 1})).join('\n'), /已过期/);
});

test('foreground or old services never claim the terminal can be closed', async () => {
  const message = (await render(null, {reused: true}, {runId: 'old', mode: 'foreground'})).join('\n');
  assert.match(message, /旧版或前台模式/); assert.doesNotMatch(message, /现在可以关闭终端窗口/);
});

test('non-interactive launchers reuse Node checks and exit without waiting for input or starting a real service', {skip: process.platform !== 'darwin'}, async t => {
  const fs = require('node:fs/promises'), os = require('node:os'), {execFile} = require('node:child_process'), {promisify} = require('node:util');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-out-launcher-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const fakeNode = path.join(dir, 'fake node');
  await fs.writeFile(fakeNode, '#!/bin/sh\nif [ "$1" = "-p" ]; then printf true; exit 0; fi\nprintf "%s\\n" "$@"\n', {mode: 0o700});
  for (const [file, forwarded] of [['Start Task Out.command', []], ['Restart Task Out.command', ['--restart']]]) {
    const launcher = path.join(__dirname, '../scripts', file);
    assert.ok((await fs.stat(launcher)).mode & 0o111);
    await promisify(execFile)('/bin/zsh', ['-n', launcher], {timeout: 3000});
    // execFile supplies pipes, not a TTY. A misplaced unconditional read would
    // wait on its open stdin and fail this deadline.
    const result = await promisify(execFile)('/bin/zsh', [launcher], {env: {...process.env, TASK_OUT_NODE: fakeNode}, timeout: 3000});
    assert.deepEqual(result.stdout.trim().split('\n'), [path.join(__dirname, '../scripts/start.mjs'), ...forwarded]);
    assert.doesNotMatch(result.stdout + result.stderr, /按回车关闭/);
  }
});
