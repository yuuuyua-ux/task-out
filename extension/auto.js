'use strict';
(() => {
  let debounce;
  let job = null;
  let dirty = false;
  let lastRun = 0;
  const ALARM = 'tabout-auto-classify';
  const web = t => /^https?:\/\//.test(t.url || '');
  const report = text => chrome.storage.session.set({aiAutoStatus: text});
  async function enabled() { return (await chrome.storage.local.get('autoClassify')).autoClassify !== false; }
  function schedule() {
    clearTimeout(debounce);
    dirty = true;
    // Alarm is a recovery path if Chrome suspends the worker during debounce.
    chrome.alarms.create(ALARM, {delayInMinutes: 0.5});
    debounce = setTimeout(() => start(false).catch(() => {}), 8000);
  }
  async function start(manual) {
    if (typeof groupMigrationReady !== "undefined") await groupMigrationReady;
    if (job) { if (manual) throw new Error('正在自动分类，请稍后再试。'); dirty = true; return; }
    if (!manual && !await enabled()) { dirty = false; await chrome.alarms.clear(ALARM); return; }
    const cfg = await TabOutAI.config();
    if (!cfg.apiKey) { dirty = false; await chrome.alarms.clear(ALARM); return; }
    if (!manual && Date.now() - lastRun < 30000) {
      await chrome.alarms.create(ALARM, {when: lastRun + 30000}); return;
    }
    job = new AbortController();
    dirty = false;
    await chrome.alarms.clear(ALARM);
    clearTimeout(debounce);
    const controller = job;
    const timeout = setTimeout(() => controller.abort(), 115000);
    try {
      const tabs = (await chrome.tabs.query({})).filter(web);
      if (!tabs.length) return 0;
      const view = (await chrome.storage.session.get('aiView')).aiView;
      const known = new Set((view?.groups || []).flatMap(g => g.members.map(m => m.id + ':' + m.url)));
      if (!manual && tabs.every(t => known.has(t.id + ':' + t.url) || (view?.groups || []).some(g => g.members.some(m => m.id === t.id && m.manual)))) return;
      lastRun = Date.now();
      await report('正在自动归类新增或跳转的页签…');
      const count = await TabOutAI.run(tabs, controller.signal);
      if (!manual && view?.mode === 'domain') await TabOutAI.setMode('domain');
      await report('已整理为 ' + count + ' 个主题，按最近访问排序。');
      return count;
    } catch (e) {
      await report(controller.signal.aborted ? '分类已取消或超时；保留原有结果。' : '自动分类未完成：' + e.message + ' 原有结果保留。');
      if (manual) throw e;
    } finally {
      clearTimeout(timeout); job = null;
      if (dirty) schedule();
    }
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'ai-edit') { job?.abort(); TabOutAI.edit(message.action).then(() => respond({ok:true}),e => respond({ok:false,error:e.message})); return true; }
    if (message.type === 'ai-run') { start(true).then(count => respond({ok:true,count}),e => respond({ok:false,error:e.message})); return true; }
    if (message.type === 'ai-cancel') { dirty = false; clearTimeout(debounce); chrome.alarms.clear(ALARM); job?.abort(); respond({ok:true}); }
    if (message.type === 'ai-schedule') { schedule(); respond({ok:true}); }
  });
  chrome.tabs.onCreated.addListener(t => { if (web(t)) schedule(); });
  chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (web(tab) && (info.url || info.status === 'complete')) schedule(); });
  chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) start(false).catch(() => {}); });
  // Serialize updates so rapid tab switches cannot lose the newest timestamp.
  let recencyQueue = Promise.resolve();
  function touched(id) {
    const at = Date.now();
    recencyQueue = recencyQueue.then(async () => {
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (!tab || !web(tab)) return;
      const {tabRecency = {}} = await chrome.storage.session.get('tabRecency');
      tabRecency[id] = at;
      await chrome.storage.session.set({tabRecency});
    }).catch(() => {});
  }
  chrome.tabs.onActivated.addListener(({tabId}) => touched(tabId));
  chrome.windows.onFocusChanged.addListener(async windowId => {
    if (windowId < 0) return;
    const [tab] = await chrome.tabs.query({active:true,windowId});
    if (tab) touched(tab.id);
  });
  chrome.runtime.onStartup.addListener(schedule);
  chrome.runtime.onInstalled.addListener(schedule);
})();
