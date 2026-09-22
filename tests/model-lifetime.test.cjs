const {test} = require('node:test');
const assert = require('node:assert/strict');
const {run} = require('../extension/model-lifetime.js');

test('pending model work pulses an extension API and stops on success or rejection', async () => {
  for (const fails of [false, true]) {
    let pulse, calls = 0, cancelled, settle;
    const pending = new Promise((resolve, reject) => { settle = () => fails ? reject(Error('timeout')) : resolve('saved'); });
    const result = run(() => pending, {
      runtime: {getPlatformInfo: async () => { calls++; }},
      schedule: (fn, delay) => { assert.equal(delay, 20000); pulse = fn; return 42; },
      cancel: id => { cancelled = id; }
    });
    assert.equal(calls, 1); pulse(); assert.equal(calls, 2);
    settle();
    if (fails) await assert.rejects(result, /timeout/); else assert.equal(await result, 'saved');
    assert.equal(cancelled, 42); pulse(); assert.equal(calls, 2);
  }
});

test('a failed keepalive API does not hide the actual model result', async () => {
  let cancelled = false;
  assert.equal(await run(async () => 'result', {
    runtime: {getPlatformInfo: () => Promise.reject(Error('unavailable'))},
    schedule: () => 1, cancel: () => { cancelled = true; }
  }), 'result');
  assert.equal(cancelled, true);
});
