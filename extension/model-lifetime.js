'use strict';
const TaskOutModelLifetime = (() => {
  async function run(operation, {runtime = globalThis.chrome?.runtime, schedule = setTimeout, cancel = clearTimeout} = {}) {
    let finished = false, timer;
    // Chrome extension API calls reset the MV3 idle timer. Timers alone do
    // not: a slow model can otherwise lose its response and timeout handler.
    const pulse = () => {
      if (finished) return;
      try { Promise.resolve(runtime?.getPlatformInfo?.()).catch(() => {}); } catch {}
      timer = schedule(pulse, 20000);
      timer?.unref?.();
    };
    pulse();
    try { return await operation(); }
    finally { finished = true; cancel(timer); }
  }
  return {run};
})();
if (typeof module !== 'undefined') module.exports = TaskOutModelLifetime;
