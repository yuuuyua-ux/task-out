'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const picker = () => import('../service/directory-picker.mjs');

test('directory picker uses fixed macOS script without shell interpolation and preserves selected path', async () => {
  const {createDirectoryPicker, DIRECTORY_PICKER_TIMEOUT_MS} = await picker();
  const selected = '/Users/example/中文 空格/$(not-run)/'; let calls = 0;
  const select = createDirectoryPicker({platform: 'darwin', execFile: (file, args, options, callback) => {
    calls++; assert.equal(file, '/usr/bin/osascript'); assert.equal(args[0], '-e'); assert.equal(args.length, 2);
    assert.match(args[1], /choose folder/); assert.match(args[1], /with invisibles/); assert.equal(args[1].includes(selected), false);
    assert.equal(options.timeout, 120000); assert.equal(DIRECTORY_PICKER_TIMEOUT_MS, options.timeout);
    assert.equal(options.killSignal, 'SIGKILL'); assert.equal(options.shell, undefined);
    callback(null, selected + '\n', '');
  }});
  assert.deepEqual(await select(), {path: selected, cancelled: false}); assert.equal(calls, 1);
});

test('directory picker cancellation is a successful empty result and releases its lock', async () => {
  const {createDirectoryPicker} = await picker(); let calls = 0;
  const select = createDirectoryPicker({platform: 'darwin', execFile: (_file, _args, _options, callback) => {
    calls++; if (calls === 1) callback(null, '__TASK_OUT_DIRECTORY_CANCELLED__\n', '');
    else callback(Object.assign(Error('cancelled'), {code: 1}), '', 'execution error: User canceled. (-128)');
  }});
  assert.deepEqual(await select(), {path: '', cancelled: true}); assert.deepEqual(await select(), {path: '', cancelled: true});
});

test('unsupported platforms and unavailable tools give a manual path fallback without launching another command', async () => {
  const {createDirectoryPicker} = await picker();
  await assert.rejects(createDirectoryPicker({platform: 'linux', execFile: () => assert.fail('must not launch')})(),
    error => error.code === 'DIRECTORY_PICKER_UNAVAILABLE' && /手动填写/.test(error.message));
  const select = createDirectoryPicker({platform: 'darwin', execFile: () => {throw Object.assign(Error('PRIVATE_EXEC_FAILURE'), {code: 'ENOENT'});}});
  await assert.rejects(select(), error => error.code === 'DIRECTORY_PICKER_UNAVAILABLE' && !error.message.includes('PRIVATE_EXEC_FAILURE'));
});

test('only one directory picker can be active and a completed selection permits the next', async () => {
  const {createDirectoryPicker} = await picker(); let finish, calls = 0;
  const select = createDirectoryPicker({platform: 'darwin', execFile: (_file, _args, _options, callback) => {calls++; finish = callback;}});
  const first = select(); await assert.rejects(select(), {code: 'DIRECTORY_PICKER_BUSY'}); assert.equal(calls, 1);
  finish(null, '/selected/\n'); assert.deepEqual(await first, {path: '/selected/', cancelled: false});
  const second = select(); assert.equal(calls, 2); finish(null, '__TASK_OUT_DIRECTORY_CANCELLED__'); await second;
});

test('timeout kills only the child picker, returns a distinct error and releases the lock', async () => {
  const {createDirectoryPicker} = await picker(); let calls = 0;
  const select = createDirectoryPicker({platform: 'darwin', execFile: (_file, _args, options, callback) => {
    assert.equal(options.timeout, 120000); assert.equal(options.killSignal, 'SIGKILL'); calls++;
    if (calls === 1) callback(Object.assign(Error('terminated'), {killed: true, signal: 'SIGKILL'}));
    else callback(null, '/after-timeout/\n');
  }});
  await assert.rejects(select(), error => error.code === 'DIRECTORY_PICKER_TIMEOUT' && /手动填写/.test(error.message));
  assert.deepEqual(await select(), {path: '/after-timeout/', cancelled: false});
});

test('permission errors are sanitized and malformed native output cannot become a usable directory', async () => {
  const {createDirectoryPicker} = await picker();
  for (const nativeError of [{code: 'EPERM'}, {code: 1, stderr: 'Not authorized to send Apple events. (-1743)'}]) {
    const select = createDirectoryPicker({platform: 'darwin', execFile: (_file, _args, _options, callback) => callback(Object.assign(Error('PRIVATE_PATH'), nativeError))});
    await assert.rejects(select(), error => error.code === 'READ_PERMISSION' && /手动填写/.test(error.message) && !error.message.includes('PRIVATE_PATH'));
  }
  for (const stdout of ['', 'relative/path\n', '/invalid\0path']) {
    const select = createDirectoryPicker({platform: 'darwin', execFile: (_file, _args, _options, callback) => callback(null, stdout)});
    await assert.rejects(select(), {code: 'DIRECTORY_PICKER_UNAVAILABLE'});
  }
});
