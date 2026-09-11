'use strict';
(() => {
 const $=id=>document.getElementById(id);
 document.addEventListener('click', event => {
  const button = event.target.closest('[data-rename-group]');
  if (!button || window.TabOutNameEditing) return;
  const original = button.textContent;
  const input = document.createElement('input');
  input.className = 'group-name-input';
  input.value = original;
  input.maxLength = 60;
  input.setAttribute('aria-label', '分组名称');
  input.title = '回车保存，Esc 取消';
  window.TabOutNameEditing = true;
  button.replaceWith(input);
  input.focus(); input.select();
  let finished = false;
  async function finish(cancel = false) {
   if (finished) return;
   finished = true;
   const name = input.value.trim();
   input.disabled = true;
   try {
    if (!cancel && name && name !== original) {
     const reply = await chrome.runtime.sendMessage({type:'ai-edit',action:{kind:'rename',group:button.dataset.renameGroup,name}});
     if (!reply?.ok) throw new Error(reply?.error || '改名失败，请重试');
     button.textContent = name;
     showToast('分组名称已保存');
    } else if (!cancel && !name) {
     showToast('分组名称不能为空，已保留原名称');
    }
   } catch (error) { showToast(error.message); }
   finally {
    input.replaceWith(button);
    window.TabOutNameEditing = false;
    await renderDashboard();
   }
  }
  input.addEventListener('keydown', event => {
   if (event.isComposing || event.keyCode === 229) return;
   if (event.key === 'Enter' || event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation(); finish(event.key === 'Escape');
   }
  });
  input.addEventListener('blur', () => finish());
 });
 async function populate() {
  const view=(await chrome.storage.session.get('aiView')).aiView || {};
  const groups=view.groups || [];
  const tabs=(await chrome.tabs.query({})).filter(t=>/^https?:/.test(t.url||''));
  function options(id,items) {
   const select=$(id), old=select.value;select.replaceChildren();
   for(const item of items) {const option=document.createElement('option');option.value=item.value;option.textContent=item.label;select.append(option);}
   if(items.some(i=>i.value===old))select.value=old;
  }
  options('editGroup',groups.map(g=>({value:g.domain,label:g.label})));
  options('moveTarget',groups.map(g=>({value:g.domain,label:g.label})));
  options('moveTab',tabs.map(t=>{const g=groups.find(g=>g.members.some(m=>m.id===t.id&&(m.manual||m.url===t.url)));return {value:String(t.id),label:'['+(g?.label||'待整理')+'] '+(t.title||t.url)};}));
  $('groupName').value=groups.find(g=>g.domain===$('editGroup').value)?.label||'';
 }
 $('manageGroups').addEventListener('click',async()=>{await populate();$('groupEditStatus').textContent='';$('groupsDialog').showModal();});
 $('editGroup').addEventListener('change',async()=>{const v=(await chrome.storage.session.get('aiView')).aiView;$('groupName').value=v?.groups.find(g=>g.domain===$('editGroup').value)?.label||'';});
 $('closeGroupEditor').addEventListener('click',()=>$('groupsDialog').close());
 async function edit(kind) {
  const action={kind,group:$(kind==='move'?'moveTarget':'editGroup').value,name:$('groupName').value,tabId:$('moveTab').value};
  const reply=await chrome.runtime.sendMessage({type:'ai-edit',action});
  $('groupEditStatus').textContent=reply?.ok?'已保存调整，AI 不会覆盖手动归属。':reply?.error||'操作失败';
  if(reply?.ok){await populate();await renderDashboard();}
 }
 for(const [id,kind] of [['renameGroup','rename'],['deleteGroup','delete'],['createGroup','create'],['moveGroupTab','move']])$(id).addEventListener('click',()=>edit(kind).catch(e=>$('groupEditStatus').textContent=e.message));
})();
