'use strict';
(() => {
  let dragged = null;
  let suppressClickUntil = 0;
  let saving = false;
  const clearHighlights = () => document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
  function destination(event) {
    const card = event.target.closest?.('[data-drop-group]');
    return card?.dataset.dropGroup && card.dataset.dropGroup !== dragged?.source ? card : null;
  }
  function blankArea(event) {
    return !event.target.closest?.('.mission-card, button, a, input, select, textarea, dialog, .deferred-column') &&
      !!event.target.closest?.('body');
  }
  document.addEventListener('dragstart', event => {
    const chip = event.target.closest?.('.page-chip[data-tab-id]');
    if (!chip || TabOutAI.mode !== 'topic' || saving || event.target.closest('button')) { event.preventDefault(); return; }
    dragged = {tabId: Number(chip.dataset.tabId), source: chip.closest('[data-drop-group]')?.dataset.dropGroup, chip};
    window.TabOutDragActive = true;
    chip.classList.add('dragging-tab');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-tabout-tab', String(dragged.tabId));
    document.body.classList.add('dragging-topic-tab');
  });
  document.addEventListener('dragover', event => {
    if (!dragged) return;
    const card = destination(event);
    clearHighlights();
    if (blankArea(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
    if (card) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; card.classList.add('drop-target'); }
  });
  document.addEventListener('dragleave', event => {
    const card = event.target.closest?.('.drop-target');
    if (card && !card.contains(event.relatedTarget)) card.classList.remove('drop-target');
  });
  function finish() {
    dragged?.chip.classList.remove('dragging-tab');
    dragged = null;window.TabOutDragActive = false;
    document.body.classList.remove('dragging-topic-tab');clearHighlights();
    suppressClickUntil = Date.now() + 350;
  }
  document.addEventListener('drop', async event => {
    if (!dragged) return;
    event.preventDefault();
    const card = destination(event);
    const tabId = dragged.tabId;
    let group = card?.dataset.dropGroup;
    const createNew = !card && blankArea(event);
    finish();
    if (!group && !createNew) return;
    saving = true;
    try {
      if (createNew) {
        const before = (await chrome.storage.session.get('aiView')).aiView?.groups || [];
        const names = new Set(before.map(g => g.label));
        let name = '新分组', n = 2;
        while (names.has(name)) name = '新分组 ' + n++;
        const created = await chrome.runtime.sendMessage({type:'ai-edit',action:{kind:'create',name}});
        if (!created?.ok) throw new Error(created?.error || '新建分组失败');
        const after = (await chrome.storage.session.get('aiView')).aiView?.groups || [];
        group = after.find(g => g.label === name && !before.some(b => b.domain === g.domain))?.domain;
        if (!group) throw new Error('未找到新分组，请在调整分组中重试');
      }
      const reply = await chrome.runtime.sendMessage({type:'ai-edit',action:{kind:'move',tabId,group}});
      if (!reply?.ok) throw new Error(reply?.error || '移动失败');
      await renderDashboard();
      showToast(createNew ? '已新建分组并固定归属，可在调整分组中改名' : '已移动并固定归属，AI 不会再移动此页签');
    } catch(e) { showToast(e.message); }
    finally {saving = false;}
  });
  document.addEventListener('dragend', () => {finish();if (!saving) renderDashboard();});
  document.addEventListener('click', event => {
    if (Date.now() < suppressClickUntil) {event.preventDefault();event.stopImmediatePropagation();}
  }, true);
})();
