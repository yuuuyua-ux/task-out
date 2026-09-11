'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let controller = null;
  let loadedConfig;
  function status(text = '') {
    const message = typeof text === 'string' ? text.trim() : '';
    $('aiStatus').textContent = message;
    $('aiStatus').hidden = !message;
  }
  function selection() {
    $('viewDomain').setAttribute('aria-pressed', String(TabOutAI.mode === 'domain'));
    $('viewTopic').setAttribute('aria-pressed', String(TabOutAI.mode === 'topic'));
    $('aiViewHint').textContent = '最近访问的排在前面';
    $('topicHelp').hidden = TabOutAI.mode !== 'topic';
  }
  async function openSettings() {
    loadedConfig = await TabOutAI.config();
    $('aiBase').value = loadedConfig.baseUrl;
    $('aiModel').value = loadedConfig.model;
    $('aiRules').value = loadedConfig.rules;
    $('aiKey').value = '';
    $('aiKey').placeholder = loadedConfig.apiKey ? '已保存，留空保持不变' : '填写 API Key';
    $('aiFormError').textContent = '';
    $('aiDialog').showModal();
  }
  $('aiSettings').addEventListener('click', () => openSettings().catch(e => status(e.message)));
  $('aiDismiss').addEventListener('click', () => $('aiDialog').close());
  $('aiForget').addEventListener('click', async () => {
    try {
      loadedConfig.apiKey = '';
      await chrome.storage.local.set({llmConfig: {...loadedConfig, apiKey: ''}});
      $('aiKey').value = ''; $('aiKey').placeholder = '填写 API Key';
      $('aiFormError').textContent = '已清除本扩展保存的 Key。';
    } catch { $('aiFormError').textContent = '清除失败，请重试。'; }
  });
  $('aiForm').addEventListener('submit', async e => {
    e.preventDefault();
    const next = { baseUrl: $('aiBase').value, model: $('aiModel').value, rules: $('aiRules').value, apiKey: $('aiKey').value.trim() };
    try {
      next.baseUrl = TabOutAI.endpoint(next.baseUrl);
      // Never silently send a saved key to a newly selected gateway.
      if (!next.apiKey && next.baseUrl === TabOutAI.endpoint(loadedConfig.baseUrl)) next.apiKey = loadedConfig.apiKey;
      if (!next.apiKey || !next.model.trim()) throw new Error('请填写 Key 和模型；更换网关时需要重新填写 Key。');
      const granted = await chrome.permissions.request({origins: [new URL(next.baseUrl).origin + '/*']});
      if (!granted) throw new Error('未授权访问网关，设置未保存。');
      await TabOutAI.saveConfig(next);
      chrome.runtime.sendMessage({type:'ai-schedule'});
      $('aiKey').value = ''; $('aiDialog').close();
      status('模型设置已保存。');
    } catch (err) { $('aiFormError').textContent = err.message; }
  });
  $('viewDomain').addEventListener('click', async () => {
    if (controller) return;
    await TabOutAI.setMode('domain'); await renderDashboard(); selection(); status();
  });
  $('viewTopic').addEventListener('click', async () => {
    if (controller) return;
    if (!TabOutAI.hasGroups) { status('还没有 AI 分类，请先点击“整理待分类页签”。'); return; }
    await TabOutAI.setMode('topic'); await renderDashboard(); selection(); status();
  });
  $('aiCancel').addEventListener('click', () => { controller?.abort(); chrome.runtime.sendMessage({type:'ai-cancel'}); });
  $('aiRun').addEventListener('click', async () => {
    if (controller) return;
    controller = new AbortController();
    const signal = controller.signal;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller?.abort(); chrome.runtime.sendMessage({type:'ai-cancel'}); }, 120000);
    for (const id of ['aiRun','viewDomain','viewTopic','aiSettings']) $(id).disabled = true;
    $('aiCancel').hidden = false;
    try {
      await fetchOpenTabs();
      status('正在整理待分类页签…');
      const reply = await chrome.runtime.sendMessage({type: 'ai-run'});
      if (!reply?.ok) throw new Error(reply?.error || '分类失败');
      const count = reply.count;
      await renderDashboard(); selection();
      status('整理完成，共 ' + count + ' 个主题。');
    } catch (err) {
      status(signal.aborted ? (timedOut ? '请求超过 2 分钟，请重试。原有分类保留。' : '已取消，原有分类保留。') : err.message);
    } finally {
      clearTimeout(timer); controller = null;
      for (const id of ['aiRun','viewDomain','viewTopic','aiSettings']) $(id).disabled = false;
      $('aiCancel').hidden = true;
    }
  });
  chrome.storage.local.get('autoClassify').then(v => { $('aiAuto').checked = v.autoClassify !== false; });
  $('aiAuto').addEventListener('change', async () => {
    await chrome.storage.local.set({autoClassify: $('aiAuto').checked});
    await chrome.runtime.sendMessage({type:'ai-schedule'});
    status($('aiAuto').checked ? '自动分类已开启，连续新增页签会合并处理。' : '自动分类已关闭，可以手动整理。');
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && (changes.aiView || changes.tabRecency)) update();
    if (area === 'session' && changes.aiAutoStatus && !controller) status(changes.aiAutoStatus.newValue);
  });
  let refresh;
  const update = () => { clearTimeout(refresh); refresh = setTimeout(async () => { if (!controller) { await renderDashboard(); selection(); } }, 350); };
  chrome.tabs.onCreated.addListener(update);
  chrome.tabs.onRemoved.addListener(update);
  chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url || info.title) update(); });
  window.addEventListener('focus', update);
  TabOutAI.project([], []).then(() => {
    selection();
  });
})();
