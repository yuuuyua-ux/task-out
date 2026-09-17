/* Task Out dashboard. Browser and model access stay behind the extension worker. */
(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const extension = !!(globalThis.chrome?.runtime?.id && chrome.runtime.sendMessage);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const unboundBrowser = item => item.kind==='web'&&item.connectorId==='browser'&&item.needsBinding===true;
  const icons = {
    web:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
    session:'<rect x="3" y="4" width="18" height="14" rx="4"/><path d="m8 18-3 3v-4m3-8h8m-8 4h5"/>',
    bookmark:'<path d="M6 3h12v18l-6-4-6 4V3Z"/>',
    close:'<path d="m6 6 12 12M6 18 18 6"/>',
    restore:'<path d="M3 5v6h6M3.5 11A9 9 0 1 1 6 19"/>',
    edit:'<path d="m14 5 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 15v5Z"/>',
    terminal:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',
    folder:'<path d="M3 7V5h7l2 3h9v12H3V7Z"/>',
    code:'<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16"/>',
    sparkles:'<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Zm7 0v4m-2-2h4"/>',
    info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
    archive:'<rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v13h14V8m-10 5h6"/>',
  };
  const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.session}</svg>`;
  const safeUrl = value => { try { const u = new URL(value); return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password ? u.href : ''; } catch { return ''; } };
  const validColor = value => /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(String(value)) ? value : '#ccb895';
  const dateValue = value => { const time = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value); return Number.isFinite(time) && time > 0 ? time : 0; };
  const fullDate = value => dateValue(value) ? new Date(dateValue(value)).toLocaleString('zh-CN',{hour12:false}) : '未知';
  const ago = value => { const t = dateValue(value); if (!t) return '时间未知'; const delta = Math.max(0, Date.now()-t); return delta<60000?'刚刚':delta<3600000?`${Math.floor(delta/60000)} 分钟前`:delta<86400000?`${Math.floor(delta/3600000)} 小时前`:delta<604800000?`${Math.floor(delta/86400000)} 天前`:new Date(t).toLocaleDateString('zh-CN'); };
  const emptyState = () => ({projects:[],items:[],connections:[],connectors:[],sourceStyles:{},migration:{pending:false},onboarding:{step:'start',draft:null},syncSettings:{intervalSeconds:60},model:{baseUrl:'',model:'',rules:'',hasKey:false,autoOrganize:true},organization:{status:'unconfigured'},bridge:{url:'http://127.0.0.1:4518',paired:false,status:'disconnected'},suggestions:[]});
  let state=emptyState(), dialogMode='', dialogContext={}, suggestions=[], aiRequest=0, toastTimer, snapshotSerial=0, loading=false, organizing=false;
  let ui={grouping:'project',scope:'active',query:'',kind:'all',source:'all',project:'all',tag:'all',range:'3',sort:'updatedAt',summaries:false};
  const previewUndo=[];
  let previewState=TaskOutCore.initial();
  const dialog=$('#dialog'), detail=$('#detail');
  const boardLayout=globalThis.TaskOutMasonry?.mount($('#board'));
  function status(item) {
    if(item.archived) return {text:'已归档',css:'archived'};
    if(unboundBrowser(item)) return {text:'未关联页签',css:'unknown'};
    if(item.kind==='web') return {text:item.status==='open'?'已打开':'网页',css:'open'};
    const raw=typeof item.status==='object'?item.status?.value:item.status;
    const statuses={running:['运行中','running'],waiting:['待处理','waiting'],waiting_user:['待处理','waiting'],needs_input:['待处理','waiting'],ended:['本轮结束','ended'],completed:['本轮结束','ended'],idle:['空闲','ended'],failed:['异常','waiting']};
    const s=statuses[raw]; return s?{text:s[0],css:s[1]}:{text:'状态未知',css:'unknown'};
  }
  const sourceName = item => item.sourceName || state.connectors.find(c=>c.id===item.sourceId)?.name || item.sourceId || '未知来源';
  const sourceId = item => item.sourceId || item.source?.id || 'unknown';
  const sourceColor = value => /^#[0-9a-f]{6}$/i.test(String(value)) ? value : '#597860';
  const customSourceStyle = id => state.sourceStyles&&Object.prototype.hasOwnProperty.call(state.sourceStyles,id)?state.sourceStyles[id]:null;
  function sourceInk(value) {
    const color=sourceColor(value),rgb=[1,3,5].map(offset=>parseInt(color.slice(offset,offset+2),16));
    const luminance=parts=>parts.map(part=>{const c=part/255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;}).reduce((sum,c,index)=>sum+c*[0.2126,0.7152,0.0722][index],0);
    const background=luminance(rgb.map((part,index)=>part*0.13+[255,253,250][index]*0.87));
    let ink=rgb;
    while((background+0.05)/(luminance(ink)+0.05)<3.5&&ink.some(part=>part>0))ink=ink.map(part=>Math.floor(part*0.8));
    return '#'+ink.map(part=>part.toString(16).padStart(2,'0')).join('');
  }
  function sourceIcon(item,appearance=TaskOutCore.sourceAppearance(state,item)) {
    const raw=appearance.icon || item.sourceIcon || state.connectors.find(c=>c.id===item.sourceId)?.icon;
    const value=raw==='message'?'session':raw;
    const glyph=Object.prototype.hasOwnProperty.call(icons,value)?svg(value):value&&typeof value==='string'&&!/[<>/]|https?:|data:/.test(value)&&[...value].length<=3?`<span>${esc(value)}</span>`:svg(item.kind==='web'?'web':'session');
    return `<span class="source-badge" style="--source-color:${sourceColor(appearance.color)};--source-ink:${sourceInk(appearance.color)}" data-source-id="${esc(sourceId(item))}" aria-hidden="true">${glyph}</span>`;
  }
  const projectsOptions = selected => `<option value="">未归类</option>${state.projects.map(p=>`<option value="${esc(p.id)}" ${p.id===selected?'selected':''}>${esc(p.name)}</option>`).join('')}`;
  const itemById = id => state.items.find(i=>i.id===id);
  function showToast(message,error=false) { clearTimeout(toastTimer); const toast=$('#toast');toast.textContent=message;toast.className=error?'error':'';toast.hidden=false;toastTimer=setTimeout(()=>toast.hidden=true,error?7500:4500); }
  async function api(action, fields={}) {
    if(!extension) return previewAction(action,fields);
    const result=await chrome.runtime.sendMessage({type:'task-out',action,...fields});
    if(!result || result.ok===false) throw Object.assign(Error(result?.error || '后台暂未响应，请在扩展管理页重新加载 Task Out。'),{code:result?.code,details:result?.details});
    return result;
  }
  function normalizeSnapshot(result) {
    const next=result.state || result;
    state={...emptyState(),...next,projects:Array.isArray(next.projects)?next.projects:[],items:Array.isArray(next.items)?next.items:[],connectors:Array.isArray(next.connectors)?next.connectors:[],connections:Array.isArray(next.connections)?next.connections:[],model:{...emptyState().model,...next.model},bridge:{...emptyState().bridge,...next.bridge}};
  }
  async function refreshSnapshot() {
    const serial=++snapshotSerial;
    try { const result=await api('snapshot');if(serial!==snapshotSerial)return;normalizeSnapshot(result);render(); }
    catch(error) {if(serial!==snapshotSerial)return;$('#connection-state').textContent='暂未连接后台';showToast(error.message,true);render();}
  }
  async function mutate(action,fields={},message='已保存') {
    const result=await api(action,fields);await refreshSnapshot();if(message)showToast(result.message || message);return result;
  }
  async function archiveRecords(action,ids,message) {
    if(action!=='archive')return mutate(action,{ids},message);
    let effects;
    try{effects=globalThis.TaskOutArchiveEffects?.prepare(ids);}catch{}
    try{
      const result=await api('archive',{ids});
      // A worker broadcast may already have replaced the real rows. Captured
      // overlays animate only records whose save and close both succeeded.
      try{effects?.finish((result.results||[]).filter(row=>row.ok===true).map(row=>row.id));}catch{}
      await refreshSnapshot();showToast(result.message||message);return result;
    }catch(error){try{effects?.cancel();}catch{}throw error;}
  }
  const historyDays = value => [3,7,30].includes(Number(value)) ? Number(value) : 30;
  const scopeLabels={active:'当前总览',recent:'最近发起',saved:'稍后查看',archived:'已归档',unbound:'历史网页'};
  function visibleItems({ignoreProject=false,ignoreTag=false}={}) {
    const query=ui.query.trim().toLocaleLowerCase();
    const now=Date.now();
    return state.items.filter(i=>!i.parentId).filter(i=>ui.scope==='archived'?i.archived:ui.scope==='saved'?i.saved&&!i.archived:ui.scope==='recent'?i.kind==='web'||!!dateValue(i.createdAt):ui.scope==='unbound'?unboundBrowser(i)&&!i.archived:!i.archived&&!unboundBrowser(i))
      .filter(i=>ui.kind==='all'||i.kind===ui.kind)
      .filter(i=>ui.source==='all'||i.sourceId===ui.source)
      .filter(i=>ignoreProject||ui.project==='all'||(i.projectId||'')===ui.project)
      .filter(i=>ignoreTag||ui.tag==='all'||(i.tags||[]).includes(ui.tag))
      .filter(i=>i.kind==='web'||!Number(ui.range)||(dateValue(i.updatedAt)&&dateValue(i.updatedAt)>=now-Number(ui.range)*86400000&&dateValue(i.updatedAt)<=now))
      .filter(i=>!query||[i.title,i.originalTitle,i.summary,sourceName(i),...(i.tags||[])].join(' ').toLocaleLowerCase().includes(query))
      .sort((a,b)=>ui.sort==='title'?String(a.title||'').localeCompare(String(b.title||''),'zh-CN'):dateValue(b[ui.scope==='recent'?'createdAt':ui.sort])-dateValue(a[ui.scope==='recent'?'createdAt':ui.sort]));
  }
  function renderSelect(selector,options,selected) { const select=$(selector);const html=options.map(([value,label])=>`<option value="${esc(value)}">${esc(label)}</option>`).join('');if(select.innerHTML!==html)select.innerHTML=html;select.value=selected; }
  function render() {
    $('#preview-notice').hidden=extension;
    $('#today').textContent=new Date().toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long'});
    $('#connection-state').textContent=!extension?'浏览器预览 · 临时数据':['connected','ready','已连接'].includes(state.bridge.status)?'本机服务已连接':state.bridge.paired?`本机服务 · ${state.bridge.status||'暂未连接'}`:'扩展独立运行 · 可连接本机服务';
    $$('[data-grouping]').forEach(b=>b.classList.toggle('active',b.dataset.grouping===ui.grouping));
    $$('[data-scope]').forEach(b=>b.classList.toggle('active',b.dataset.scope===ui.scope));
    const sources=[...new Map(state.items.map(i=>[i.sourceId||'unknown',sourceName(i)])).entries()];
    renderSelect('#source',[['all','全部来源'],...sources],ui.source);
    // Project and type choices come from the current view, not historical rows.
    // Ignore the type here so an obsolete type cannot reset a valid project.
    const availableProjectIds=new Set(visibleItems({ignoreProject:true,ignoreTag:true}).map(i=>i.projectId||''));
    if(ui.project!=='all'&&!availableProjectIds.has(ui.project))ui.project='all';
    renderSelect('#project',[['all','全部项目'],...(availableProjectIds.has('')?[['','未归类']]:[]),...state.projects.filter(p=>availableProjectIds.has(p.id)).map(p=>[p.id,p.name])],ui.project);
    $('#range').value=ui.range;
    // Ignore only the type's own selection so sibling types remain switchable.
    const usedTypes=new Set(visibleItems({ignoreTag:true}).flatMap(i=>i.tags||[]));
    const tags=TaskOutCore.TYPE_LABELS.filter(type=>usedTypes.has(type));
    if(ui.tag!=='all'&&!tags.includes(ui.tag))ui.tag='all';
    $('#tags').innerHTML=`<span>类型</span><button data-tag="all" class="${ui.tag==='all'?'active':''}">全部</button>${tags.map(t=>`<button data-tag="${esc(t)}" class="${ui.tag===t?'active':''}">${esc(t)}</button>`).join('')}`;
    const organization=organizationStatus();
    $('#organization-status').dataset.status=organization.status;
    $('#organization-status').innerHTML=`<span class="organization-dot" aria-hidden="true"></span><span>${esc(organization.label)}</span>${['unconfigured','error'].includes(organization.status)?`<a href="#" data-action="settings">${organization.status==='error'?'查看原因':'去设置'}</a>`:''}`;
    $('#view-hint').textContent=ui.scope==='unbound'?'这些旧记录未关联当前标签页，已有分类仍保留。点击标题可查看、重新关联或归档。':`${Number(ui.range)?`近 ${ui.range} 天有更新的对话`:'全部已获取对话'} · ${ui.scope==='active'?'全部已打开网页':'网页不受时间限制'}，时间筛选只影响对话`;
    const rows=visibleItems(),roots=state.items.filter(i=>i.kind==='session'&&!i.parentId),recent=roots.filter(i=>dateValue(i.createdAt)>=Date.now()-7*86400000&&dateValue(i.createdAt)<=Date.now()),unknown=roots.filter(i=>!dateValue(i.createdAt)).length;
    $('#stats').innerHTML=`<span>${extension?'人工整理优先保存 · 来源更新不会覆盖':'预览内容仅保留在本页'}${state.model.model?` · 模型 ${esc(state.model.model)}`:' · 尚未配置模型'}${state.historyExcluded?` · ${Number(state.historyExcluded)} 条会话不在获取范围`:''}</span><span>近 7 天发起的对话 <strong>${recent.length}</strong> · 对话创建时间未知 <strong>${unknown}</strong></span>`;
    $('#scope-title').textContent=scopeLabels[ui.scope];$('#item-count').textContent=`${rows.length} 条${ui.scope==='recent'?' · 包含已归档':''}`;
    const groups=new Map();
    for(const i of rows){const id=ui.grouping==='project'?(i.projectId||''):(i.sourceId||'unknown');if(!groups.has(id)){const project=state.projects.find(p=>p.id===id);groups.set(id,{id,name:ui.grouping==='project'?(project?.name||'未归类'):sourceName(i),color:ui.grouping==='source'?sourceColor(TaskOutCore.sourceAppearance(state,i).color):project?.color||'#cdbb9b',rows:[]});}groups.get(id).rows.push(i);}
    $('#board').innerHTML=groups.size?[...groups.values()].map(cardHTML).join(''):`<div class="board-empty"><h3>${state.items.length?'没有符合条件的记录':'从一页清楚的总览开始'}</h3><p>${state.items.length?'调整筛选条件，或在设置的数据管理中查看历史网页。':extension?'打开的网页将出现在这里。你也可以在设置中连接会话来源。':'在设置中导入记录，预览整理效果。'}</p>${state.items.length?'<button data-action="reset-filters">重置筛选</button>':''}</div>`;
    boardLayout?.update();
    if(detail.open){const item=itemById(detail.dataset.id),header=$('.detail-top',detail);if(item&&header)header.innerHTML=`${sourceIcon(item)} ${esc(sourceName(item))} · ${status(item).text}`;}
    const migration=state.migration||{};$('#migration').hidden=!migration.pending;$('#migration').innerHTML=migration.pending?'<div class="notice">发现上一版的主题与稍后查看记录。可先预览，再迁移为项目和归档记录。<button data-action="migration">预览迁移</button><button data-action="migration-skip">暂不迁移</button></div>':'';
    if(dialog.open&&dialogMode==='settings')showSettings();
  }
  function cardHTML(group) {
    const web=group.rows.filter(i=>i.kind==='web').length,session=group.rows.length-web;
    return `<article class="project-card" style="--group-color:${validColor(group.color)}" data-project-drop="${ui.grouping==='project'?esc(group.id):'__none__'}"><header class="project-card-head"><h3>${esc(group.name)}</h3><span class="card-count">${group.rows.length}</span>${ui.grouping==='project'&&group.id?`<button class="card-edit" data-action="project-edit" data-id="${esc(group.id)}" aria-label="编辑项目 ${esc(group.name)}">${svg('edit')}</button>`:''}</header><div class="card-composition">${session?`${session} 个会话`:''}${web&&session?' · ':''}${web?`${web} 个网页`:''}</div><div class="card-items">${group.rows.map(rowHTML).join('')}</div></article>`;
  }
  function rowHTML(item) {
    const title=item.title||item.originalTitle||'未命名记录',s=status(item),href=safeUrl(item.url||item.locator?.url);
    const needsResolution=ui.scope==='unbound'&&unboundBrowser(item);
    const titleHTML=item.kind==='web'&&href&&!needsResolution?`<a class="entry-title" href="${esc(href)}" target="_blank" rel="noopener noreferrer" ${extension?`data-action="open" data-id="${esc(item.id)}"`:''}>${esc(title)}</a>`:`<button class="entry-title" data-action="${item.kind==='web'&&!needsResolution?'open':'detail'}" data-id="${esc(item.id)}">${esc(title)}</button>`;
    return `<div class="group-row" draggable="true" data-record-id="${esc(item.id)}"><div class="entry-avatar" title="${esc(sourceName(item))} · ${item.kind==='web'?'网页':'会话'}">${sourceIcon(item)}</div><div class="entry-copy">${titleHTML}<div class="entry-meta"><span>${esc(sourceName(item))}</span><span>·</span><span class="status ${s.css}">${s.text}</span><span>·</span><time title="${esc(fullDate(item[ui.scope==='recent'?'createdAt':'updatedAt']))}">${esc(ago(item[ui.scope==='recent'?'createdAt':'updatedAt']))}</time></div><div class="entry-tags">${(item.tags||[]).filter(t=>TaskOutCore.TYPE_LABELS.includes(t)).slice(0,1).map(t=>`<button class="type-tag" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>${item.error?`<div class="entry-error" title="${esc(item.error)}">${esc(item.error)}</div>`:''}${item.archivedHasUpdates?'<div class="entry-summary">归档后有新活动</div>':''}${ui.summaries&&item.summary?`<div class="entry-summary" title="${esc(item.summary)}">${esc(item.summary)}</div>`:''}</div><div class="entry-actions">${item.kind==='web'?`<button data-action="detail" data-id="${esc(item.id)}" aria-label="详情：${esc(title)}" title="查看网页详情">${svg('info')}</button>`:''}<button class="${item.saved?'is-saved':''}" data-action="bookmark" data-id="${esc(item.id)}" aria-label="${item.saved?'取消稍后查看':'稍后查看'}：${esc(title)}" aria-pressed="${!!item.saved}" title="${item.saved?'取消稍后查看':'稍后查看'}">${svg('bookmark')}</button><button data-action="${item.archived?'restore':'archive'}" data-id="${esc(item.id)}" aria-label="${item.archived?'恢复':'归档'}：${esc(title)}" title="${item.archived?'恢复':'归档'}">${svg(item.archived?'restore':'close')}</button></div></div>`;
  }
  function openDialog(title,body,footer='',mode='') {
    const back=['model','usage','connections','source-styles','import','export','project','suggestions'].includes(mode)?'<button class="quiet settings-back" data-action="settings">返回设置</button>':'';
    dialogMode=mode;dialog.innerHTML=`<div class="modal-head"><h2 id="dialog-title">${esc(title)}</h2><button class="modal-close" data-action="dialog-close" aria-label="关闭弹窗">×</button></div><div class="modal-body">${body}<p id="dialog-error" class="form-error" role="alert"></p></div><div class="modal-foot">${back}${footer||'<button data-action="dialog-close">完成</button>'}</div>`;if(!dialog.open)dialog.showModal();
  }
  function organizationError() {
    const detail=String(state.organization?.message||'').trim();
    // Map known, sanitized failure messages to short explanations. Unknown
    // failures retain their original detail without inventing a diagnosis.
    const cases=[
      [/超时/,'模型响应超时','稍后重试；如果持续超时，可减少本次整理的内容或更换模型。'],
      [/HTTP\s*401|API Key (?:无效|格式)/i,'模型密钥无效或已过期','在模型设置中检查或更新 API Key，保存后重试。'],
      [/HTTP\s*403|模型接口拒绝访问|尚未授权访问此地址/i,'没有模型访问权限','检查模型服务的访问权限、API Key，以及 Chrome 是否允许扩展访问该地址。'],
      [/HTTP\s*404/i,'模型接口地址不可用（404）','检查模型服务地址是否正确，并确认该服务支持 OpenAI 兼容接口。'],
      [/HTTP\s*429|请求过于频繁或额度不足/i,'请求受限或模型额度不足','稍后重试，并检查模型服务的可用额度。'],
      [/HTTP\s*5\d\d/i,'模型服务暂时异常','稍后重试；如果持续失败，可在模型设置中切换可用服务。'],
      [/无法连接模型接口/,'无法连接模型服务','检查网络、模型服务地址和 Chrome 的访问授权，再重试。'],
      [/模型输出达到长度上限/,'模型返回内容不完整','减少本次整理的内容或简化分组偏好，再重试。'],
      [/模型未为.*返回.*名称/,'模型没有返回所需的会话名称','重试当前内容；如果反复失败，可在模型设置中更换模型。'],
      [/模型引用了不存在(?:或有歧义)?的项目|模型返回的分组无法识别/,'模型返回的分组无法识别','模型已响应，但分组结果未通过校验。可重试当前内容，已有整理保留。'],
      [/JSON|模型建议格式不正确|模型没有返回有效的最终结果|模型未完成建议输出|模型接口返回了异常内容/i,'模型返回内容不符合要求','重试当前内容；如果反复失败，请确认服务兼容性或更换模型。']
    ];
    const match=cases.find(([pattern])=>pattern.test(detail));
    const http=detail.match(/HTTP\s*(\d{3})/i)?.[1];
    return {reason:match?.[1]||(http?`模型请求失败（${http}）`:'暂时无法完成'),
      advice:match?.[2]||'查看详细错误，检查模型设置后重试。',
      detail:detail||'没有收到具体错误信息。可先重试，或在模型设置中测试连接。'};
  }
  function organizationStatus() {
    if(!extension)return {status:'preview',label:'预览模式 · 整理仅在已安装的扩展中运行'};
    if(organizing||state.organization?.status==='running')return {status:'running',label:'正在整理内容…'};
    if(!state.model.baseUrl||!state.model.model)return {status:'unconfigured',label:'配置模型后自动整理'};
    if(state.organization?.status==='error'){const error=organizationError();return {status:'error',label:`${state.model.autoOrganize===false?'整理失败':'自动整理失败'}：${error.reason}`,error};}
    if(state.model.autoOrganize===false||state.organization?.status==='paused')return {status:'paused',label:'自动整理已暂停'};
    const lastApplied=Number(state.organization?.lastApplied);
    return {status:'idle',label:Number.isFinite(lastApplied)&&lastApplied>0?`自动整理已开启 · 上次整理 ${lastApplied} 条`:'自动整理已开启'};
  }
  function showSettings() {
    const organization=organizationStatus(),busy=organization.status==='running';
    const rows=visibleItems(),batchCount=rows.filter(item=>ui.scope==='archived'?item.archived:!item.archived).length;
    const unbound=state.items.filter(item=>unboundBrowser(item)&&!item.archived&&!item.parentId).length;
    const enabled=state.connections.filter(connection=>connection.enabled!==false).length;
    dialogContext={};
    openDialog('设置',`<section class="settings-section"><h3>模型与自动整理</h3><p>${esc(organization.label)}${state.model.model?` · ${esc(state.model.model)}`:''}</p>${organization.status==='error'?`<div class="organization-error" role="alert"><p class="settings-error">${esc(organization.error.advice)}</p><p class="settings-note">已完成的整理会保留。${state.model.autoOrganize===false?'自动整理已暂停，可在下方手动重试。':'可在下方重试当前内容。'}</p><details class="usage"><summary>详细错误</summary><p class="pre-wrap">${esc(organization.error.detail)}</p></details></div>`:''}<p class="settings-note">网页自动整理，新会话归类一次并补全缺失名称；已有会话只更新进展，保留你的手动修改，整理后可撤销。</p><div class="settings-actions"><button data-action="model">配置模型与自动整理</button><button data-action="usage">用量与费用</button>${state.suggestions?.length?`<button data-action="pending-suggestions">查看待确认建议 · ${state.suggestions.length} 条</button>`:''}</div></section><section class="settings-section"><h3>会话来源</h3><p>${enabled?`已启用 ${enabled} 个来源`:'连接本机会话，与网页一起查看'}${state.bridge.paired?` · ${esc(state.bridge.status||'等待同步')}`:''}</p><div class="settings-actions">${!state.connections.length?`<button class="primary" data-action="onboarding-start">${state.onboarding?.draft||['pair','discover','preview','enable'].includes(state.onboarding?.step)?'继续接入本机会话':'接入本机会话'}</button>`:''}<button data-action="connections">管理会话来源</button><button data-action="source-styles">图标与颜色</button></div><form id="sync-settings-form" class="sync-settings"><label class="field">会话与进展刷新频率<select id="sync-interval">${[[30,'每 30 秒'],[60,'每分钟（默认）'],[120,'每 2 分钟'],[300,'每 5 分钟'],[0,'仅手动刷新']].map(([value,label])=>`<option value="${value}" ${value===(state.syncSettings?.intervalSeconds??60)?'selected':''}>${label}</option>`).join('')}</select></label><button type="submit">保存频率</button></form><p class="settings-note">新会话归类一次；已有会话只更新进展，项目和类型保持不变。网页继续自动整理。</p></section><section class="settings-section"><h3>手动操作</h3><p>操作范围：${esc(scopeLabels[ui.scope])}，当前筛选共 ${rows.length} 条。</p><div class="settings-actions"><button data-action="organize-now" ${busy?'disabled aria-busy="true"':''}>${busy?'正在整理…':organization.status==='error'?'重试整理当前内容':'重新整理当前内容'}</button><button data-action="progress-refresh" ${busy?'disabled':''}>刷新进展</button><button data-action="project-new">新建项目</button><button data-action="undo" ${!state.undoAvailable||busy?'disabled':''}>撤销最近整理</button>${batchCount?`<button class="danger" data-action="batch-archive" ${busy?'disabled':''}>${ui.scope==='archived'?'恢复':'归档'}当前 ${batchCount} 条</button>`:''}</div></section><section class="settings-section"><h3>数据管理</h3><div class="settings-actions">${unbound?`<button data-action="unbound">历史网页 · ${unbound} 条</button>`:''}<button data-action="import">导入记录</button><button data-action="export">导出备份</button></div>${unbound?'<p class="settings-note">历史网页是未关联当前标签页的旧记录，已有分类仍保留。可查看、重新关联或归档。</p>':''}<details class="usage"><summary>使用说明</summary><p>当前总览默认显示近 3 天有更新的对话和全部已打开网页，时间筛选只影响对话。点击网页直接打开，点击会话查看进展。拖动记录可调整项目；书签用于稍后查看，× 将记录归档。归档会话不会停止 Agent。自动整理遵循来源授权，生成的会话名称固定保存，不随新消息变化。获取范围和命名权限可在会话来源中调整。</p></details></section>`, '<button data-action="dialog-close">完成</button>','settings');
  }
  function sourceStyleItems() {
    return [...new Map(state.items.map(item=>[sourceId(item),item])).values()]
      .sort((a,b)=>sourceName(a).localeCompare(sourceName(b),'zh-CN'));
  }
  function showSourceStyles() {
    dialogContext={};
    const items=sourceStyleItems();
    openDialog('来源图标与颜色',`<p>为每个来源选择更容易辨认的图标和颜色，同一来源统一显示。名称和对话内容保持不变。</p>${!extension?'<p class="settings-note">当前为网页预览，外观调整仅在本页临时保存。</p>':''}<div class="source-style-list">${items.length?items.map(item=>`<article class="source-style-row" data-source-style-id="${esc(sourceId(item))}">${sourceIcon(item)}<div class="source-style-label"><strong>${esc(sourceName(item))}</strong><small>${customSourceStyle(sourceId(item))?'自定义外观':'跟随来源 · 默认配色'}</small></div><button data-action="source-style-edit" data-source-id="${esc(sourceId(item))}" aria-label="编辑 ${esc(sourceName(item))} 的图标与颜色">编辑</button></article>`).join(''):'<p class="detail-empty">来源出现后，就可以在这里调整外观。</p>'}</div>`,'<button data-action="dialog-close">完成</button>','source-styles');
  }
  function showSourceStyleEditor(id) {
    const item=sourceStyleItems().find(item=>sourceId(item)===id);
    if(!item)throw Error('此来源暂时没有可显示的记录。');
    const appearance=TaskOutCore.sourceAppearance(state,item);
    const inherited=TaskOutCore.sourceAppearance({...state,sourceStyles:{}},item);
    const icon=customSourceStyle(id)?.icon||'',color=sourceColor(appearance.color);
    dialogContext={sourceStyle:{sourceId:id,item,inherited},styleDraft:{icon,color}};
    const iconNames={'':'跟随来源',web:'网页',session:'对话',terminal:'终端',folder:'文件夹',code:'代码',sparkles:'星光'};
    const choices=[...new Set(['',...TaskOutCore.SOURCE_ICONS])];
    openDialog('编辑来源外观',`<p>只调整「${esc(sourceName(item))}」在 Task Out 中的显示，离线也可保存。</p><div id="source-style-preview" class="source-style-preview">${sourceIcon(item,appearance)}<strong>${esc(sourceName(item))}</strong></div><form id="source-style-form"><fieldset class="source-icon-field"><legend>图标</legend><div class="source-icon-choices">${choices.map(value=>`<label class="source-icon-option"><input type="radio" name="source-style-icon" value="${esc(value)}" ${icon===value?'checked':''}>${sourceIcon(item,{icon:value||inherited.icon,color})}<span>${esc(iconNames[value]||value)}</span></label>`).join('')}</div></fieldset><fieldset class="source-color-field"><legend>颜色</legend><div class="source-color-options">${TaskOutCore.SOURCE_COLORS.map(value=>`<button type="button" class="source-color-swatch" data-action="source-style-color" data-color="${sourceColor(value)}" style="--swatch-color:${sourceColor(value)}" aria-label="选择颜色 ${sourceColor(value)}" aria-pressed="${value.toLowerCase()===color.toLowerCase()}"></button>`).join('')}</div><label class="source-custom-color">自选颜色<input id="source-style-color" type="color" value="${color}"><output id="source-style-color-value" for="source-style-color">${color.toUpperCase()}</output></label></fieldset></form>`, '<button data-action="source-style-reset" class="quiet">恢复默认</button><button data-action="source-styles">取消</button><button class="primary" type="submit" form="source-style-form">保存</button>','source-style');
  }
  function updateSourceStylePreview() {
    const {sourceStyle,styleDraft:draft}=dialogContext;
    if(dialogMode!=='source-style'||!sourceStyle||!draft)return;
    $('#source-style-preview').innerHTML=`${sourceIcon(sourceStyle.item,{icon:draft.icon||sourceStyle.inherited.icon,color:draft.color})}<strong>${esc(sourceName(sourceStyle.item))}</strong>`;
    $('#source-style-color-value').textContent=draft.color.toUpperCase();
    $$('[data-action="source-style-color"]',dialog).forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.color.toLowerCase()===draft.color.toLowerCase())));
  }
  function chooseSourceStyleColor(color) {
    if(dialogMode!=='source-style'||!dialogContext.styleDraft||!/^#[0-9a-f]{6}$/i.test(String(color)))return;
    dialogContext.styleDraft.color=color.toLowerCase();
    $('#source-style-color').value=dialogContext.styleDraft.color;
    updateSourceStylePreview();
  }
  async function saveSourceStyle() {
    const {sourceStyle,styleDraft}=dialogContext;if(!sourceStyle||!styleDraft)throw Error('请重新选择来源。');
    await mutate('source-style-save',{sourceId:sourceStyle.sourceId,...styleDraft},'来源外观已保存');
    showSourceStyles();
  }
  async function resetSourceStyle() {
    const id=dialogContext.sourceStyle?.sourceId;if(!id)throw Error('请重新选择来源。');
    await mutate('source-style-reset',{sourceId:id},'已恢复来源默认外观');
    showSourceStyles();
  }
  async function organizeNow() {
    if(organizing||state.organization?.status==='running'){showToast('正在整理，请稍等');return;}
    if(!extension)throw Error('自动整理需在已安装的 Chrome 扩展中使用。');
    if(!state.model.baseUrl||!state.model.model){showModel();return;}
    const ids=visibleItems().filter(item=>!item.archived&&!item.parentId&&!unboundBrowser(item)).map(item=>item.id);
    if(!ids.length)throw Error('当前没有可整理的内容。');
    organizing=true;render();
    try{const result=await api('organize-now',{ids});await refreshSnapshot();showToast(result.message||`已整理 ${Number(result.applied)||0} 条`);}
    catch(error){await refreshSnapshot();throw error;}
    finally{organizing=false;render();}
  }
  function formValue(id){return $(`#${id}`,dialog)?.value?.trim()||'';}
  function formChecked(id){return !!$(`#${id}`,dialog)?.checked;}
  function dialogError(error){if(['onboarding','connection'].includes(dialogMode))return connectionError(error);const target=$('#dialog-error');if(target)target.textContent=error?.message||String(error);else showToast(error?.message||String(error),true);}
  function openProject(id='') {
    const project=state.projects.find(p=>p.id===id)||{name:'',color:'#cdbb9b'};dialogContext={id};
    openDialog(id?'编辑项目':'新建项目',`<p>项目用于整理工作，不绑定本地工作目录。</p><form id="project-form"><label class="field">项目名称<input id="project-name" required maxlength="80" value="${esc(project.name)}" autofocus></label><label class="field">卡片颜色<input id="project-color" type="color" value="${validColor(project.color)}"></label></form>`,`${id?'<button class="danger" data-action="project-delete">删除空项目</button>':''}<button data-action="dialog-close">取消</button><button class="primary" type="submit" form="project-form">保存项目</button>`,'project');
  }
  function openEditor(id) {
    const item=itemById(id);if(!item)return;dialogContext={id,initial:{title:item.title||item.originalTitle,projectId:item.projectId||'',tags:structuredClone(item.tags||[]),summary:item.summary||'',sourceName:sourceName(item)}};
    openDialog('调整记录',`<p>人工调整会保留，来源同步不会覆盖。</p><form id="record-form"><label class="field">显示标题<input id="record-alias" maxlength="300" value="${esc(item.title||item.originalTitle)}"></label><label class="field">项目<select id="record-project">${projectsOptions(item.projectId||'')}</select></label><label class="field">类型<select id="record-tags">${typeOptions(item.tags)}</select><small>每条记录选择一个主要类型。</small></label><label class="field">一句近况<textarea id="record-summary" rows="3">${esc(item.summary)}</textarea></label><label class="field">来源显示名称<input id="record-source" maxlength="80" value="${esc(sourceName(item))}"><small>仅为这条记录纠正来源名称，不改变原始存储。</small></label></form>`,'<button data-action="dialog-close">取消</button><button class="primary" type="submit" form="record-form">保存调整</button>','record');
  }
  const typeOptions = tags => `<option value="">未设置</option>${TaskOutCore.TYPE_LABELS.map(type=>`<option value="${esc(type)}" ${tags?.includes(type)?'selected':''}>${esc(type)}</option>`).join('')}`;
  const selectedType = text => {const value=String(text||'').trim();if(value&&!TaskOutCore.TYPE_LABELS.includes(value))throw Error('请选择一个有效类型。');return value?[value]:[];};
  function namingBasis(item) {
    const basis=item.titleBasis||'unknown';
    const labels={'manual-alias':'手动命名','generated-name':'AI 命名（已固定）','first-message':'首条消息（临时名称）',unknown:'未知'};
    if(basis==='manual-alias'||basis==='generated-name')return labels[basis];
    if(item.sourceTitle)return '原会话名称';
    return labels[basis]||'未知';
  }
  function namingHint(item) {
    if(item.kind!=='session'||!item.needsSessionName)return '';
    const provisional=item.titleBasis==='first-message'?'，暂用首条消息显示':'';
    return `<p>来源未提供会话原名${provisional}。在设置中授权首条和最新消息后，会自动补全固定名称，不随新消息变化。</p>`;
  }
  async function showDetail(id) {
    const fallback=itemById(id);if(!fallback)return;
    let item=fallback,children=state.items.filter(i=>i.parentId===id);
    try{const result=await api('record-detail',{id});item=result.item||item;children=result.children||children;}catch(error){showToast(`详情暂不可更新：${error.message}`,true);}
    const locator=typeof item.locator==='string'?item.locator:item.locator?Object.entries(item.locator).filter(([,v])=>['string','number'].includes(typeof v)).map(([k,v])=>`${k}: ${v}`).join('\n'):'';
    const events=Array.isArray(item.timeline)?item.timeline:[];
    const pendingRestore=item.kind==='web'&&item.connectorId==='browser'&&item.pending?.type==='restore';
    const needsBrowserResolution=item.kind==='web'&&item.connectorId==='browser'&&(item.needsBinding||pendingRestore);
    const canOpen=!pendingRestore&&(item.kind==='web'||item.capabilities?.open===true||item.capabilities?.openOrigin===true);
    const browserResolution=needsBrowserResolution?`<section class="browser-resolution" aria-label="页签关联"><h3>${pendingRestore?'上次恢复结果尚未确认':'这条记录尚未关联当前页签'}</h3><p>${pendingRestore?'先核对浏览器。网页若已打开，请关联对应页签；确认未打开后，才可重新恢复。':'若网页已在浏览器中打开，可手动关联具体页签，保留这条记录的整理结果。'}</p><div class="panel-actions"><button data-action="browser-candidates" data-id="${esc(id)}">关联已有页签</button>${pendingRestore?`<button data-action="restore-reset-review" data-id="${esc(id)}">确认未打开，重新恢复</button>`:''}</div></section>`:'';
    detail.dataset.id=id;
    detail.innerHTML=`<div class="modal-head"><span class="muted">${item.kind==='web'?'网页详情':'会话与进展'}</span><button class="modal-close" data-action="detail-close" aria-label="关闭详情">×</button></div><div class="modal-body"><div class="detail-top">${sourceIcon(item)} ${esc(sourceName(item))} · ${status(item).text}</div><h2 id="detail-title">${esc(item.title||item.originalTitle||'未命名记录')}</h2>${namingHint(item)}<div class="detail-tags">${(item.tags||[]).filter(t=>TaskOutCore.TYPE_LABELS.includes(t)).slice(0,1).map(t=>`<span class="type-tag">${esc(t)}</span>`).join(' ')}</div>${browserResolution}${item.error?`<div class="notice">操作未完成：${esc(item.error)}。原记录仍保留，可核对后重试。</div>`:''}<div class="summary-card">${esc(item.summary||(item.kind==='web'?'网页记录已保留，可调整项目、标签或归档。':'尚无近况摘要。来源启用同步后，可在此查看最近活动。'))}</div>${item.next?`<h3 class="dialog-section">下一步</h3><p class="pre-wrap">${esc(item.next)}</p>`:''}<dl class="detail-times"><dt>项目</dt><dd>${esc(state.projects.find(p=>p.id===item.projectId)?.name||'未归类')}</dd>${item.kind==='session'?`<dt>命名依据</dt><dd>${esc(namingBasis(item))}</dd>${item.sourceTitle?`<dt>来源原名</dt><dd>${esc(item.sourceTitle)}</dd>`:''}`:''}<dt>创建时间</dt><dd>${esc(fullDate(item.createdAt))}${item.createdAtBasis?` · ${esc(item.createdAtBasis)}`:''}</dd><dt>最近活动</dt><dd>${esc(fullDate(item.updatedAt))}</dd><dt>最近同步</dt><dd>${esc(fullDate(item.syncedAt))}</dd></dl>${item.kind==='web'?`<h3 class="dialog-section">网页地址</h3><div class="detail-locator">${esc(item.url||'未提供有效网址')}</div>`:'<p>历史记录只能证明已发生的活动，不能单独证明 Agent 此刻正在运行。</p>'}<h3 class="dialog-section">进展记录</h3><div class="timeline">${events.length?events.map(event=>`<div class="timeline-entry"><small>${esc(fullDate(event.at||event.timestamp||event.time))}${event.role?` · ${esc(event.role)}`:''}</small><p>${esc(event.text||event.content||event.summary||'')}</p></div>`).join(''):'<div class="detail-empty">暂无可展示的历史片段</div>'}</div>${children.length?`<h3 class="dialog-section">子会话 · ${children.length}</h3><div class="stack">${children.map(child=>`<div class="panel-card"><h3>${esc(child.title||child.originalTitle||'子会话')}</h3><p>${esc(child.summary||'未提供近况')}</p><small>${esc(sourceName(child))} · ${status(child).text}</small></div>`).join('')}</div>`:''}${locator?`<h3 class="dialog-section">定位信息</h3><div class="detail-locator pre-wrap">${esc(locator)}</div><p>尚未验证的原工具直达入口不会显示为可用。</p>`:''}</div><div class="modal-foot"><button data-action="record-edit" data-id="${esc(id)}">调整记录</button>${item.needsSessionName&&!item.archived?`<button data-action="name-sessions" data-id="${esc(id)}">生成会话名称</button>`:''}${canOpen?`<button class="primary" data-action="open" data-id="${esc(id)}">${item.kind==='web'?'打开网页':'回到原会话'}</button>`:''}${pendingRestore?'':`<button data-action="${item.archived?'restore':'archive'}" data-id="${esc(id)}">${item.archived?'恢复':'归档'}</button>`}</div>`;
    if(!detail.open)detail.showModal();
  }
  async function showBrowserCandidates(id) {
    const item=itemById(id);if(!item)return;
    if(detail.open)detail.close();
    dialogContext={id,tabs:[]};
    openDialog('关联已有页签',`<p>为「${esc(item.title||item.originalTitle)}」选择浏览器中对应的页签。仅关联你选择的页签，不会按相同网址自动合并。</p><p><span class="spinner" aria-hidden="true"></span>正在读取已打开的页签…</p>`,`<button data-action="resolution-back" data-id="${esc(id)}">返回详情</button>`,'browser-candidates-loading');
    const result=await api('browser-candidates',{id});
    if(!dialog.open||dialogMode!=='browser-candidates-loading'||dialogContext.id!==id)return;
    const tabs=Array.isArray(result.tabs)?result.tabs:[];dialogContext={id,tabs};
    openDialog('关联已有页签',`<p>为「${esc(item.title||item.originalTitle)}」选择对应页签。相同网址也可能是不同页签，请核对窗口与页签号。</p><div class="candidate-list">${tabs.length?tabs.map((tab,index)=>`<label class="candidate-option"><input type="radio" name="browser-candidate" value="${index}"><span><strong>${esc(tab.title||'未命名网页')}</strong><span class="candidate-url">${esc(tab.url||'未提供网址')}</span><small>窗口 ${esc(tab.windowId)} · 页签 ${esc(tab.tabId)}</small></span></label>`).join(''):'<div class="card-empty">没有可关联的已打开页签<small>可返回详情，核对后再打开或恢复网页。</small></div>'}</div><p class="candidate-note">若所选页签已有其他整理记录且资料冲突，将保留原记录并提示处理。</p>`,`<button data-action="resolution-back" data-id="${esc(id)}">返回详情</button>${tabs.length?'<button data-action="record-rebind" class="primary">关联所选页签</button>':''}`,'browser-candidates');
  }
  async function applyBrowserRebind() {
    const selected=$('input[name="browser-candidate"]:checked',dialog);
    if(!selected)throw Error('请选择一个具体页签。');
    const tab=dialogContext.tabs[Number(selected.value)];if(!tab)throw Error('候选页签已变化，请重新查看。');
    const id=dialogContext.id;
    await mutate('record-rebind',{id,tabId:tab.tabId},'已关联所选页签');
    dialog.close();await showDetail(id);
  }
  function reviewRestoreReset(id) {
    const item=itemById(id);if(!item)return;
    if(detail.open)detail.close();dialogContext={id};
    openDialog('核对上次恢复结果',`<p>请先在浏览器中检查「${esc(item.title||item.originalTitle)}」是否已打开。</p><p>若已打开，请返回详情并关联已有页签。只有确认未打开后，才清除这次未确认结果，再点击恢复。</p>`,`<button data-action="resolution-back" data-id="${esc(id)}">返回详情</button><button data-action="restore-reset-confirm" class="primary">确认网页未打开</button>`,'restore-reset');
  }
  function showModel() {
    const model=state.model;dialogContext={originalBase:model.baseUrl||'',hadKey:!!model.hasKey,forgetKey:false};
    openDialog('模型与自动整理',`<p>配置模型后，自动整理网页和已授权的新会话；已有会话只更新进展，保持项目与类型。缺少原名的会话按首条与最新消息生成固定名称，不发送完整历史。</p><p>已有配置时，地址、模型名称、Key 和分组偏好留空均保持原值。</p><p class="settings-note">测试只用虚构分类样例，不发送真实记录；测试通过不代表所有真实内容都能正确分类。</p><form id="model-form"><label class="field">模型服务地址（兼容 OpenAI 格式）<input id="model-base" type="url" ${model.baseUrl?'':'required'} value="${esc(model.baseUrl)}" placeholder="https://your-model-service.example/v1"><small>支持 HTTPS 或本机 HTTP；已有地址留空保持不变。</small></label><label class="field">模型名称<input id="model-name" ${model.model?'':'required'} value="${esc(model.model)}" placeholder="填写模型服务提供的模型名称"></label><label class="field">API Key<input id="model-key" type="password" autocomplete="new-password" placeholder="${model.hasKey?'已保存 · 留空保持原 Key':'本机无认证服务可留空'}"><small id="model-key-hint">Key 只保存在扩展本地，不进入导出和本机服务。更换地址时需填写新 Key 或明确清除，留空不会删除原配置。</small></label><label class="field">分组偏好<textarea id="model-rules" rows="3" placeholder="例如：优先归入已有项目，项目按工作目标区分">${esc(model.rules)}</textarea></label><label class="check-field"><input id="model-auto" type="checkbox" ${model.autoOrganize!==false?'checked':''}><span>自动整理<br><small class="muted">新会话归类一次并补全缺失名称，已有会话只更新进展；网页自动整理，可撤销，不覆盖手动修改。</small></span></label></form>`, '<button data-action="model-forget" class="danger">清除 Key</button><button data-action="model-test">保存并测试整理</button><button data-action="dialog-close">取消</button><button class="primary" form="model-form" type="submit">保存设置</button>','model');
  }
  async function requestOrigin(value) {
    if(!extension)throw Error('模型与来源连接需在已安装的 Chrome 扩展中使用。');
    const u=new URL(value);const local=['localhost','127.0.0.1','[::1]'].includes(u.hostname);
    if(u.protocol!=='https:'&&!(u.protocol==='http:'&&local))throw Error('请使用 HTTPS 地址；只有本机接口允许 HTTP。');
    if(u.username||u.password)throw Error('地址中不能包含账号或密码。');
    const granted=await chrome.permissions.request({origins:[`${u.origin}/*`]});if(!granted)throw Error('未授予该地址的访问权限，设置尚未保存。');
  }
  async function saveModel(test=false) {
    const baseUrl=formValue('model-base'),model=formValue('model-name');
    if(!(baseUrl||state.model.baseUrl)||!(model||state.model.model))throw Error('首次配置请填写模型服务地址和模型名称；已有配置留空表示不变。');
    await requestOrigin(baseUrl||state.model.baseUrl);
    const fields={autoOrganize:formChecked('model-auto')};
    for(const [field,value] of Object.entries({baseUrl,model,rules:formValue('model-rules')}))if(value)fields[field]=value;
    const key=formValue('model-key');if(key)fields.apiKey=key;
    if(dialogContext.forgetKey&&!key)fields.forgetKey=true;
    await mutate('model-save',fields,'模型设置已保存');
    if(test){const result=await api('model-test');$('#dialog-error').textContent=result.message||'分类样例测试已通过；实际整理结果仍需校验。';}else showSettings();
  }
  const usageNumber=value=>value===null||value===undefined?'未知':Number(value).toLocaleString('zh-CN',{maximumFractionDigits:0});
  function usageCosts(totals) {
    const values=Object.entries(totals?.estimatedCosts||{}).filter(([,value])=>Number.isFinite(value));
    if(!values.length)return totals?.requests?'未知':'暂无估算';
    return values.map(([currency,value])=>`${esc(currency)} ${value>0&&value<.0001?'＜0.0001':value.toLocaleString('zh-CN',{maximumFractionDigits:4})}`).join(' · ')+(totals?.partial?'（部分估算）':'');
  }
  let usageRequest=0;
  async function showUsage(days=30) {
    const request=++usageRequest;
    openDialog('用量与费用','<p>正在读取 Task Out 的模型调用记录…</p>','<button data-action="dialog-close">关闭</button>','usage');
    const {report}=await api('usage-report',{days});
    if(request!==usageRequest||dialogMode!=='usage'||!dialog.open)return;
    if(!report?.totals)throw Error('暂时无法读取用量，请稍后重试。');
    const totals=report.totals,models=report.models||[],prices=report.pricing||[];
    const identities=[...new Map([...models,...prices,...(state.model.baseUrl&&state.model.model?[state.model]:[])].map(model=>[JSON.stringify([model.baseUrl,model.model]),{baseUrl:model.baseUrl,model:model.model}])).values()];
    dialogContext={usageReport:report,days,identities};
    const maximum=Math.max(1,...(report.daily||[]).map(day=>day.requests));
    const trend=(report.daily||[]).length?`<div class="usage-trend" role="img" aria-label="每日模型调用次数"><div class="usage-bars">${report.daily.map(day=>`<div class="usage-bar-column" title="${esc(day.date)}：${usageNumber(day.requests)} 次调用，${usageNumber(day.totalTokens)} tokens"><span>${usageNumber(day.requests)}</span><i style="height:${Math.max(3,Math.round(day.requests/maximum*85))}px"></i><small>${esc(day.date.slice(5))}</small></div>`).join('')}</div></div>`:'<p class="detail-empty">此范围内暂无模型调用。</p>';
    const forecast=report.forecast||{};
    const purposes={grouping:'分组',progress:'进展',naming:'命名',test:'测试'},statuses={response:'已返回',error:'请求失败',cancelled:'已取消'};
    openDialog('用量与费用',`<p>仅统计 Task Out 的分组、进展、命名和测试调用，不包含 Codex 等原应用自身的用量。测试调用单独标注，也计入总量。</p><div class="segmented usage-period" aria-label="用量统计范围">${[[1,'今天'],[7,'近 7 天'],[30,'近 30 天']].map(([value,label])=>`<button data-action="usage-range" data-days="${value}" class="${days===value?'active':''}" aria-pressed="${days===value}">${label}</button>`).join('')}</div><div class="usage-totals"><div><small>模型调用</small><strong>${usageNumber(totals.requests)} 次</strong></div><div><small>总 tokens</small><strong>${usageNumber(totals.totalTokens)}</strong></div><div class="usage-cost-total"><small>估算费用</small><strong>${usageCosts(totals)}</strong></div></div><p class="usage-token-breakdown">输入 ${usageNumber(totals.inputTokens)} · 输出 ${usageNumber(totals.outputTokens)} · 缓存输入 ${usageNumber(totals.cachedInputTokens)} tokens</p>${totals.unknownUsageRequests||totals.unpricedRequests||totals.costPartialRequests?`<div class="notice">${totals.unknownUsageRequests?`${usageNumber(totals.unknownUsageRequests)} 次未返回完整用量，未知部分未计入 token 合计。<br>`:''}${totals.unpricedRequests?`${usageNumber(totals.unpricedRequests)} 次费用未知，需有单价与用量才能估算。<br>`:''}${totals.costPartialRequests?'部分调用缺少缓存用量或缓存单价，已按普通输入价估算，未计缓存优惠。':''}</div>`:''}<h3 class="dialog-section">每日调用趋势</h3>${trend}<h3 class="dialog-section">未来 30 天估算</h3><div class="panel-card"><p>${forecast.available?`约 ${usageNumber(forecast.totals?.requests)} 次调用 · ${usageNumber(forecast.totals?.totalTokens)} tokens<br><strong>${usageCosts(forecast.totals)}</strong>`:esc(forecast.reason||'累计记录不足 24 小时，暂不预测。')}</p>${forecast.available?`<small class="muted">${esc(forecast.reason)}${forecast.partial?' 部分用量或费用未知。':''}</small>`:''}</div><h3 class="dialog-section">按模型查看与定价</h3><div class="usage-models">${identities.length?identities.map((identity,index)=>{const model=models.find(row=>row.baseUrl===identity.baseUrl&&row.model===identity.model),price=prices.find(row=>row.baseUrl===identity.baseUrl&&row.model===identity.model);return `<article class="panel-card usage-model"><div class="panel-head"><h3>${esc(identity.model)}</h3><button data-action="pricing-edit" data-index="${index}">${price?'编辑单价':'设置单价'}</button></div><small class="usage-gateway">${esc(identity.baseUrl)}</small><p>${model?`${usageNumber(model.requests)} 次调用 · ${usageNumber(model.totalTokens)} tokens<br>${usageCosts(model)}`:'此范围暂无调用'}</p>${price?`<small class="muted">每百万 tokens：输入 ${usageNumberPrice(price.inputPerMillion)} · 输出 ${usageNumberPrice(price.outputPerMillion)} · 缓存输入 ${usageNumberPrice(price.cachedInputPerMillion)} ${esc(price.currency)}</small>`:'<small class="muted">单价未配置，费用未知</small>'}</article>`;}).join(''):'<p class="detail-empty">配置模型后即可设置单价。</p>'}</div><h3 class="dialog-section">最近调用 <span class="muted">最多 100 条</span></h3><div class="usage-events">${(report.recent||[]).map(event=>`<article class="usage-event"><div><strong>${esc(purposes[event.purpose]||'模型调用')}${event.purpose==='test'?'<span class="pill">测试</span>':''}</strong><small>${esc(fullDate(event.at))}</small></div><p>${esc(event.model)} · ${esc(event.trigger==='automatic'?'自动':'手动')} · ${esc(statuses[event.status]||'状态未知')}${event.attempt>1?` · 第 ${Number(event.attempt)} 次尝试`:''}</p><p>${usageNumber(event.totalTokens)} tokens · ${event.cost===null||event.cost===undefined?'费用未知':usageCosts({requests:1,estimatedCosts:{[event.currency]:event.cost},partial:event.costPartial})}</p><small>输入 ${usageNumber(event.inputTokens)} · 输出 ${usageNumber(event.outputTokens)} · 缓存输入 ${usageNumber(event.cachedInputTokens)} · ${usageNumber(event.recordCount)} 条记录</small></article>`).join('')||'<p class="detail-empty">暂无调用记录。</p>'}</div><p class="usage-footnote">${report.firstRecordedAt?`自 ${esc(fullDate(report.firstRecordedAt))} 开始记录；`:'升级后的首次模型调用开始记录；'}升级前未统计。费用按每次调用时保存的单价估算，不是实际账单；不同币种分别显示，不做汇率换算。</p>`,'<button data-action="dialog-close">完成</button>','usage');
  }
  const usageNumberPrice=value=>value===null||value===undefined?'未配置':esc(value);
  function showPricing(index) {
    const {usageReport,days,identities}=dialogContext,identity=identities?.[index];if(!identity)throw Error('模型列表已变化，请重新打开用量页面。');
    const price=(usageReport.pricing||[]).find(row=>row.baseUrl===identity.baseUrl&&row.model===identity.model)||{};
    dialogContext={identity,days};
    const input=(field,label)=>`<label class="field">${label}<input id="price-${field}" type="number" min="0" step="any" value="${esc(price[field]??'')}" placeholder="未配置"><small>每百万 tokens 的价格</small></label>`;
    openDialog('设置模型单价',`<p><strong>${esc(identity.model)}</strong><br><span class="usage-gateway">${esc(identity.baseUrl)}</span></p><p>不同模型服务地址与模型名称分别保存单价。留空保持已有单价，首次留空表示未配置；明确填 0 表示免费。</p><form id="pricing-form"><label class="field">币种<select id="price-currency">${['CNY','USD','EUR'].map(currency=>`<option value="${currency}" ${currency===(price.currency||'CNY')?'selected':''}>${currency}</option>`).join('')}</select></label>${input('inputPerMillion','输入单价')}${input('outputPerMillion','输出单价')}${input('cachedInputPerMillion','缓存输入单价')}</form><p class="settings-note">保存后用于新的调用估算，历史调用保留当时的单价。缓存用量或单价缺失时，按普通输入单价估算并标注，未计缓存优惠。</p>`,'<button data-action="pricing-back">返回</button><button type="submit" form="pricing-form" class="primary">保存单价</button>','pricing');
  }
  async function savePricing() {
    const {identity,days}=dialogContext,fields={...identity,currency:formValue('price-currency')};
    for(const field of ['inputPerMillion','outputPerMillion','cachedInputPerMillion']){const value=formValue('price-'+field);if(!value)continue;const number=Number(value);if(!Number.isFinite(number)||number<0)throw Error('单价必须为非负数字，留空保持不变。');fields[field]=number;}
    await mutate('pricing-save',fields,'模型单价已保存');await showUsage(days);
  }
  function showOrganize() {
    const rows=visibleItems().filter(i=>!i.archived);
    dialogContext={ids:rows.map(i=>i.id)};suggestions=Array.isArray(state.suggestions)?state.suggestions:[];
    if(suggestions.length)return showSuggestionList(suggestions,state.suggestionExcluded||[],dialogContext.ids);
    openDialog('AI 整理',`<p>对当前筛选的 <strong>${rows.length}</strong> 条未归档记录生成项目、类型与一句近况建议。缺少原名的会话，在授权首条和最新消息后可补充固定名称。生成后可逐条调整、选择应用或取消；来源权限不允许发送的内容会跳过。</p><div class="notice">${state.model.model?`使用 ${esc(state.model.model)} · ${esc(state.model.baseUrl)}`:'先在模型设置中填写模型服务地址与模型名称。'}<br>手动调整的字段会保持不变。归档、来源身份和执行操作不由模型决定。</div>`,`${state.model.model?'<button data-action="ai-generate" class="primary">生成建议</button>':'<button data-action="model" class="primary">配置模型</button>'}<button data-action="dialog-close">取消</button>`,'organize');
  }
  function showNaming(id) {
    const candidates=(id?[itemById(id)].filter(Boolean):visibleItems()).filter(item=>item.kind==='session'&&!item.archived&&!item.parentId&&item.needsSessionName);
    const allowed=candidates.filter(item=>item.observations?.length&&item.observations.every(o=>o.allowAI===true&&o.includeNaming===true));
    dialogContext={ids:allowed.map(item=>item.id),namingOnly:true};
    if(detail.open)detail.close();
    openDialog('补全会话名称',`<p>当前有 ${candidates.length} 条会话缺少原名，${allowed.length} 条已允许使用首条与最新消息生成名称。每条最多使用两段消息节选，不发送完整历史。</p><p>生成后可调整并应用；确认的名称固定保存，后续消息和同步不会改名，手动修改优先。</p>${candidates.length>allowed.length?'<div class="notice">部分来源尚未允许命名。请在连接来源中开启“允许标题发送给模型”和“允许首条与最新消息用于生成会话名称”。</div>':''}${!state.model.model?'<p>需要先配置模型服务地址和模型名称。</p>':''}`,`${allowed.length&&state.model.model?'<button data-action="ai-generate" class="primary">生成名称</button>':''}${!state.model.model?'<button data-action="model">配置模型</button>':''}${candidates.length>allowed.length?'<button data-action="connections">设置命名权限</button>':''}<button data-action="dialog-close">关闭</button>`,'naming');
  }
  async function generateSuggestions() {
    if(loading)return;const ids=dialogContext.ids||visibleItems().filter(i=>!i.archived).map(i=>i.id);if(!ids.length)throw Error('当前没有可整理的记录。');
    const namingOnly=dialogContext.namingOnly===true;const serial=++aiRequest;loading=true;
    openDialog(namingOnly?'正在生成会话名称':'正在生成建议','<p><span class="spinner" aria-hidden="true"></span>模型正在整理允许发送的记录。你可以随时取消。</p>','<button data-action="ai-cancel">取消生成</button>','ai-loading');
    try { const result=await api(namingOnly?'name-preview':'ai-preview',{ids});if(serial!==aiRequest)return;suggestions=result.suggestions||[];showSuggestionList(suggestions,result.excluded||[],ids); }
    catch(error){if(serial===aiRequest)throw error;}
    finally {if(serial===aiRequest)loading=false;}
  }
  function showSuggestionList(list,excluded=[],ids=[]) {
    dialogContext={ids};
    const content=list.map((s,index)=>{const item=itemById(s.recordId)||{};return `<article class="suggestion-card" data-suggestion-index="${index}"><label class="check-field"><input class="suggestion-selected" type="checkbox" checked><span>${esc(item.title||s.recordId)}</span></label><div class="suggestion-reason">${esc(s.reason||'模型建议')}</div>${Object.prototype.hasOwnProperty.call(s.patch||{},'sessionName')?`<label class="field">会话名称<input class="suggestion-session-name" maxlength="80" required value="${esc(s.patch.sessionName)}"><small>应用后固定，不随新消息变化。</small></label>`:''}${s.kind==='naming'?'':`<label class="field">项目<select class="suggestion-project">${projectsOptions(s.patch?.projectName?'':s.patch?.projectId??item.projectId??'')}<option value="__new__" ${s.patch?.projectName?'selected':''}>＋ 新建项目</option></select><input class="suggestion-project-name" ${s.patch?.projectName?'':'hidden'} placeholder="新项目名称" value="${esc(s.patch?.projectName)}"></label><label class="field">类型<select class="suggestion-tags">${typeOptions(s.patch?.tags||item.tags)}</select></label><label class="field">一句近况<textarea class="suggestion-summary" rows="2">${esc(s.patch?.summary??item.summary??'')}</textarea></label>`}</article>`;}).join('');
    openDialog('预览整理建议',`<p>已生成 ${list.length} 条建议${excluded.length?`，${excluded.length} 条因权限或状态限制跳过`:''}。仅应用勾选项，之后可撤销；预览后被修改的字段会提示冲突。</p>${excluded.length?`<details class="usage"><summary>查看跳过原因</summary>${excluded.map(e=>`<p>${esc(itemById(e.id)?.title||e.id)}：${esc(e.reason)}</p>`).join('')}</details>`:''}${content||'<div class="card-empty">没有可应用的建议</div>'}`,`<button data-action="ai-cancel">取消</button>${list.length?'<button data-action="ai-apply" class="primary">应用所选建议</button>':'<button data-action="dialog-close">完成</button>'}`,'suggestions');
  }
  async function applySuggestions() {
    const selected=$$('.suggestion-card',dialog).filter(card=>$('.suggestion-selected',card).checked).map(card=>{const s=suggestions[Number(card.dataset.suggestionIndex)];if(s.kind==='naming'){const name=$('.suggestion-session-name',card)?.value.trim()||'';if(!name||name.length>80)throw Error('会话名称需为 1–80 个字符。');return {...s,patch:{sessionName:name}};}const item=itemById(s.recordId)||{},project=$('.suggestion-project',card).value;const patch={...s.patch},tags=selectedType($('.suggestion-tags',card).value),summary=$('.suggestion-summary',card).value.trim();if(Object.prototype.hasOwnProperty.call(s.patch||{},'sessionName')){const name=$('.suggestion-session-name',card)?.value.trim()||'';if(!name||name.length>80)throw Error('会话名称需为 1–80 个字符。');patch.sessionName=name;}if('tags' in patch||JSON.stringify(tags)!==JSON.stringify(item.tags||[]))patch.tags=tags;if('summary' in patch||summary!==String(item.summary||''))patch.summary=summary;if(project==='__new__'){const name=$('.suggestion-project-name',card).value.trim();if(!name)throw Error('请填写新项目名称。');patch.projectName=name;delete patch.projectId;}else if('projectId' in patch||'projectName' in patch||project!==(item.projectId||'')){patch.projectId=project;delete patch.projectName;}return {...s,patch};});
    if(!selected.length)throw Error('请至少选择一条建议。');
    const result=await mutate('ai-apply',{suggestions:selected},'所选建议已应用');
    if(result.conflicts?.length){$('#dialog-error').textContent=`${result.conflicts.length} 条建议出现修改冲突，未覆盖新修改。请重新生成建议。`;return;}
    dialog.close();
  }
  async function service(method,path,body) { return api('service',{method,path,...(body?{body}:{})}); }
  function servicePanel(service={state:'checking'}) {
    const labels={checking:'正在检查',running:service.mode==='background'?'后台运行':service.mode==='legacy'?'运行中（旧版）':'前台运行',stopping:'正在停止',stopped:'已停止',offline:'未运行或无法连接'};
    return `<div class="panel-head"><h3>本机服务</h3><span class="pill">${esc(labels[service.state]||'状态未知')}</span></div><p>${esc(state.bridge.url||'http://127.0.0.1:4518')} · ${state.bridge.paired?'已配对':'未配对'}${service.startedAt?`<br>本次启动：${esc(fullDate(service.startedAt))}`:''}</p>${service.message?`<p>${esc(service.message)}</p>`:''}<p>${service.state==='running'&&service.mode==='background'?'可关闭终端窗口，服务仍会继续同步。':service.state==='stopped'?'已暂停本地会话同步，已读取记录和配对仍保留。':service.state==='offline'?'启动本机服务后刷新即可恢复同步。':'本机服务负责会话读取，网页与模型整理可独立使用。'}</p><div class="panel-actions"><button data-action="pair">${state.bridge.paired?'重新配对 / 更改地址':'输入配对码'}</button><button data-action="service-status">刷新状态</button>${service.canStop&&service.state==='running'?'<button data-action="service-stop" class="danger">停止服务</button>':''}</div><details class="usage"><summary>如何启动或重新启动</summary><p>打开「下载的 Task Out 文件夹 / scripts / Start Task Out.command」。启动成功后可以关闭终端窗口；重复启动会复用正在运行的服务。电脑重启后需再次启动，不设置开机自启。</p><p>如需新的配对码，在仓库目录运行 npm restart。旧版前台服务需先在原终端按 Ctrl+C 停止。</p></details>`;
  }
  let onboardingFlow=null,onboardingTimer,onboardingSaveQueue=Promise.resolve(),onboardingNavigation=0;
  const flowActive=()=>onboardingFlow?.active===true&&dialogMode==='onboarding';
  function onboardingSteps(step) {
    const steps=[['start','启动'],['pair','配对'],['discover','发现'],['preview','预览'],['enable','启用']],index=step==='done'?5:steps.findIndex(([key])=>key===step);
    return `<ol class="onboarding-steps" aria-label="接入进度">${steps.map(([key,label],i)=>`<li class="${i<index?'is-complete':i===index?'is-current':''}" ${i===index?'aria-current="step"':''}><span>${i<index?'✓':i+1}</span>${label}</li>`).join('')}</ol>`;
  }
  function openOnboarding(step,body,footer='') {
    onboardingFlow.step=step;onboardingNavigation++;
    openDialog('接入本机会话',`${onboardingSteps(step)}${body}<div id="onboarding-error" class="connection-error" role="alert" hidden></div>`,`${step==='done'?'':'<button class="quiet onboarding-exit" data-action="onboarding-exit">稍后继续</button>'}${footer}`,'onboarding');
  }
  const safeConfigField=field=>!['password','secret'].includes(String(field.type||'').toLowerCase())&&field.sensitive!==true&&field.secret!==true;
  function safeConnectionDraft(values={}) {
    const connector=state.connectors.find(item=>item.id===values.connectorId),fields=connector?.configFields||connector?.configuration?.fields||connector?.configSchema?.fields||[];
    const declared=Array.isArray(fields)?fields:[],blocked=new Set(declared.filter(field=>!safeConfigField(field)).map(field=>field.key||field.name));
    const allowed=new Set(['connectorId','root','name','historyDays','allowAI','includeSummary','includeNaming','metadataRoot','pollIntervalMs',...declared.filter(safeConfigField).map(field=>field.key||field.name)]),draft={};
    for(const [key,value] of Object.entries(values))if(allowed.has(key)&&!blocked.has(key)&&!/(?:token|secret|password|api.?key|pair.?code|content|messages|preview)/i.test(key)&&(typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)))draft[key]=value;
    if(values.identity&&typeof values.identity==='object')draft.identity={id:String(values.identity.id||''),label:String(values.identity.label||''),icon:String(values.identity.icon||'message')};else draft.identity=null;
    return draft;
  }
  function persistOnboarding(step=onboardingFlow?.step,draft=onboardingFlow?.draft??null) {
    clearTimeout(onboardingTimer);
    const saved={step,draft:draft?safeConnectionDraft(draft):null};state.onboarding=saved;
    onboardingSaveQueue=onboardingSaveQueue.catch(()=>{}).then(()=>api('onboarding-save',saved));return onboardingSaveQueue;
  }
  function saveOnboardingDraftSoon() {
    if(!flowActive()||onboardingFlow.step!=='preview')return;
    onboardingFlow.draft=connectionValues(false);onboardingFlow.preview=null;
    clearTimeout(onboardingTimer);onboardingTimer=setTimeout(()=>persistOnboarding('preview',onboardingFlow.draft).catch(dialogError),350);
  }
  async function exitOnboarding() {
    if(!onboardingFlow?.active)return;
    const flow=onboardingFlow,navigation=onboardingNavigation;
    if(flow.step==='preview'&&$('#connection-form'))flow.draft=connectionValues(false);
    await persistOnboarding(flow.step,flow.draft);
    if(onboardingFlow!==flow||!flowActive()||navigation!==onboardingNavigation)return;
    flow.active=false;dialog.close();showSettings();
  }
  async function loadConnectorCatalog() {
    const result=await service('GET','/v1/connectors');state.connectors=result.connectors||result.data?.connectors||[];
    if(!state.connectors.length)throw Object.assign(Error('本机服务尚未提供可读取的会话类型，请更新本机服务后重试。'),{code:'NO_CONNECTORS'});
  }
  async function beginOnboarding({fresh=false,manual=false}={}) {
    clearTimeout(onboardingTimer);
    if(!extension)return showConnections();
    const saved=fresh?{step:state.bridge.paired?'discover':'start',draft:null}:state.onboarding||{};
    onboardingFlow={active:true,step:saved.step||'start',draft:saved.draft?safeConnectionDraft(saved.draft):null,preview:null,candidates:[],warning:'',url:state.bridge.url||'http://127.0.0.1:4518'};
    if(!state.bridge.paired&&['pair','discover','preview','enable','done'].includes(onboardingFlow.step)){
      const flow=onboardingFlow,resumeStep=flow.step;openOnboarding('pair','<p><span class="spinner"></span>正在检查之前保存的本机连接，无需重复使用配对码…</p>');const navigation=onboardingNavigation;
      try{const {service:status}=await api('service-status');if(onboardingFlow!==flow||!flowActive()||navigation!==onboardingNavigation)return;
        await refreshSnapshot();if(onboardingFlow!==flow||!flowActive()||navigation!==onboardingNavigation)return;
        if(status?.paired===true){state.bridge.paired=true;flow.step=resumeStep;}
        else if(status?.state==='running')return showPair();
        else {await showOnboardingStart();connectionError(Object.assign(Error(status?.message||'请启动本机服务后继续。'),{code:status?.code||'SERVICE_OFFLINE'}));return;}
      }catch(error){if(onboardingFlow!==flow||!flowActive()||navigation!==onboardingNavigation)return;await showOnboardingStart();connectionError(error);return;}
    }
    if(state.bridge.paired&&(manual||onboardingFlow.draft&&['preview','enable'].includes(onboardingFlow.step))){
      openOnboarding('preview','<p><span class="spinner"></span>正在恢复来源配置…</p>');
      const flow=onboardingFlow,navigation=onboardingNavigation;
      try{await loadConnectorCatalog();if(onboardingFlow!==flow||!flowActive()||navigation!==onboardingNavigation)return;showConnectionEditor(flow.draft||{},true);await persistOnboarding('preview',flow.draft);}catch(error){if(onboardingFlow===flow&&flowActive())connectionError(error);}return;
    }
    if(state.bridge.paired||onboardingFlow.step==='discover'||onboardingFlow.step==='done')return discoverSources(true);
    if(onboardingFlow.step==='pair')return showPair();return showOnboardingStart();
  }
  async function showOnboardingStart() {
    if(!onboardingFlow?.active)onboardingFlow={active:true,draft:null,preview:null,candidates:[],url:state.bridge.url||'http://127.0.0.1:4518'};
    openOnboarding('start','<h3 class="onboarding-title">先启动本机会话服务</h3><p>浏览器扩展负责总览；本机服务负责读取你稍后选择的会话目录。</p><ol class="onboarding-instructions"><li>打开下载的 Task Out 文件夹，进入 <strong>scripts</strong>，双击 <strong>Start Task Out.command</strong>。</li><li>按启动窗口提示检查运行环境，看到“服务已启动”后，保留窗口中的配对码。</li><li>回到这里继续。配对完成后可以关闭启动窗口，服务会在后台运行。</li></ol><div class="onboarding-location">下载的 Task Out 文件夹 / scripts / Start Task Out.command</div><p class="settings-note">电脑重启后需要再启动一次。本步骤不会读取会话，也不会发送内容给模型。</p><div id="onboarding-start-status" role="status"></div>','<button data-action="onboarding-pair">已有配对码</button><button class="primary" data-action="onboarding-check">已启动，检查连接</button>');
    return persistOnboarding('start');
  }
  async function checkOnboardingService() {
    const flow=onboardingFlow,navigation=onboardingNavigation,active=()=>onboardingFlow===flow&&flowActive()&&flow.step==='start'&&navigation===onboardingNavigation;
    try{await requestOrigin(flow?.url||state.bridge.url||'http://127.0.0.1:4518');}catch(error){if(!active())return;if(/未授予/.test(error.message))error.code='EXTENSION_PERMISSION_DENIED';throw error;}
    if(!active())return;
    const result=await api('service-status'),status=result.service||{};if(!active())return;
    await refreshSnapshot();if(!active())return;
    if(status.state!=='running')throw Object.assign(Error(status.message||'尚未连接到本机服务，请先打开启动脚本。'),{code:status.code||'SERVICE_OFFLINE'});
    if(status.paired===true||state.bridge.paired){state.bridge.paired=true;return beginOnboarding();}
    flow.serviceReady=true;return showPair();
  }
  function connectionError(error) {
    const code=String(error?.code||''),message=error?.message||String(error),inFlow=flowActive();
    let title='这一步还没有完成',advice='已填写的配置会保留。根据提示调整后，再重试这一步。',action=inFlow&&onboardingFlow.step==='done'?'onboarding-refresh':'connection-retry',label=inFlow&&onboardingFlow.step==='done'?'刷新同步':'重试这一步';
    if(/PERMISSION_DENIED|permission-denied|EXTENSION_PERMISSION/.test(code)||/未授予该地址|Chrome.*权限/.test(message)){title='Chrome 尚未允许连接本机服务';advice='点击“重新授权并配对”，在 Chrome 提示中允许访问本机地址。只授予你填写的本机服务地址。';action='onboarding-pair';label='重新授权并配对';}
    else if(/^PAIR_CODE_/.test(code)){title='配对码不可用';advice=code==='PAIR_CODE_EXPIRED'?'配对码已过期。双击下载的 Task Out 文件夹 / scripts / Restart Task Out.command，取得新配对码后再填写。':code==='PAIR_CODE_USED'?'这份配对码已被使用。双击 scripts / Restart Task Out.command 取得新配对码，现有记录和配对会保留。':'请复制启动窗口中显示的完整配对码，检查是否漏字或多了空格。';action='onboarding-pair';label='重新填写配对码';}
    else if(code==='CONNECTION_EXPIRED'){title='本机连接授权已失效';advice='历史记录和整理结果仍保留。使用启动窗口中的当前配对码重新连接。';action='onboarding-pair';label='重新配对';}
    else if(code==='CONNECTION_EXISTS'){title='这份来源已经接入';advice='无需再次添加。请到已接入来源中查看、编辑或恢复同步。';action='connections';label='查看已接入来源';}
    else if(code==='DIRECTORY_NOT_FOUND'){title='没有找到所选目录';advice='目录可能已移动或删除。在高级设置中重新选择会话目录，然后预览。';action='connection-adjust';label='调整目录';}
    else if(code==='READ_PERMISSION'){title='暂时没有目录读取权限';advice='请为启动本机服务的终端授予所选目录的读取权限，或在高级设置中选择一个可读取的目录。';action='connection-adjust';label='查看目录设置';}
    else if(code==='UNSUPPORTED_FORMAT'){title='该目录没有兼容的会话文件';advice='请在高级设置中检查会话目录与读取方式，也可以返回发现页选择其他来源。';action='connection-adjust';label='检查读取方式';}
    else if(/SERVICE_OFFLINE|ECONNREFUSED|SERVICE_UNAVAILABLE/.test(code)||/无法连接本机服务|Failed to fetch|本机服务未/.test(message)){title='尚未连上本机服务';advice='请打开下载的 Task Out 文件夹 / scripts / Start Task Out.command。看到服务已启动后，再回到当前步骤重试。';action=inFlow?'onboarding-start-over':'connections';label=inFlow?'查看启动步骤':'查看服务状态';}
    const target=$(inFlow?'#onboarding-error':'#connection-error')||$('#dialog-error');
    if(target){target.hidden=false;target.innerHTML=`<h3>${esc(title)}</h3><p>${esc(advice)}</p><p class="connection-error-detail">${esc(message)}</p><button data-action="${action}">${esc(label)}</button>`;}else showToast(message,true);
  }
  async function connectionRetry() {
    if(!flowActive())return testConnection();
    if(onboardingFlow.step==='start')return checkOnboardingService();
    if(onboardingFlow.step==='pair')return submitPair();
    if(onboardingFlow.step==='discover')return discoverSources(true);
    if(onboardingFlow.step==='enable')return saveConnection();return testConnection();
  }
  function connectionAdjustment() {
    if(flowActive()&&onboardingFlow.step==='enable')showConnectionEditor(onboardingFlow.draft,true);
    const advanced=$('#connection-advanced');if(advanced)advanced.open=true;
    $('#connection-root')?.focus?.();
  }
  async function showConnections() {
    if(onboardingFlow)onboardingFlow.active=false;dialogContext={};
    if(!extension){openDialog('连接来源','<p>本机会话与网页管理需要 Chrome 扩展。在浏览器预览中可导入标准数据查看。</p>','<button data-action="import" class="primary">导入记录</button><button data-action="dialog-close">完成</button>','connections');return;}
    openDialog('连接来源',`<p>连接器负责读取兼容来源。路径、名称和发送给模型的内容均可配置；同一份存储不会因为多个客户端而重复导入。</p><div id="service-status-panel" class="panel-card">${servicePanel()}</div><div id="connection-list">${connectionCards()}</div>`, '<button data-action="onboarding-start" class="primary">接入会话来源</button><button data-action="connection-add">手动添加</button><button data-action="dialog-close">完成</button>','connections');
    try {
      const {service:status}=await api('service-status');if(dialogMode!=='connections')return;
      $('#service-status-panel').innerHTML=servicePanel(status);
      if(status.state!=='running'||!state.bridge.paired)return;
      const results=await Promise.allSettled([service('GET','/v1/connectors'),service('GET','/v1/connections')]);
      if(results[0].status==='fulfilled')state.connectors=results[0].value.connectors||results[0].value.data?.connectors||[];
      if(results[1].status==='fulfilled')state.connections=results[1].value.connections||results[1].value.data?.connections||[];
      if(dialogMode!=='connections')return;
      const failure=results.find(r=>r.status==='rejected');$('#connection-list').innerHTML=connectionCards();if(failure)dialogError(failure.reason);
    } catch(error){if(dialogMode==='connections'){$('#service-status-panel').innerHTML=servicePanel({state:'offline',message:error.message});}}
  }
  function connectionCards() {
    return `<h3 class="dialog-section">已配置的连接 · ${state.connections.length}</h3>${state.connections.length?`<div class="stack">${state.connections.map(c=>`<article class="panel-card"><div class="panel-head"><h3>${esc(c.name||state.connectors.find(x=>x.id===c.connectorId)?.name||c.connectorId)}</h3><span class="pill">${c.enabled===false?'已暂停':'已启用'}</span></div><p>${esc(c.root||c.config?.root||'')}<br>获取范围：近 ${historyDays(c.historyDays)} 天有活动的会话${(c.lastSyncedAt||c.lastSyncAt)?`<br>最近同步：${esc(fullDate(c.lastSyncedAt||c.lastSyncAt))}`:''}${c.error?`<br>${esc(c.error)}`:''}${c.errors?.length?`<br>${c.errors.map(e=>esc(typeof e==='string'?e:e.message||e.error||'部分记录读取失败')).join('<br>')}`:''}</p><small class="muted">${c.allowAI?'允许标题发送给模型':'禁止发送给模型'}${c.allowAI&&c.includeSummary?' · 包含一句近况':''}${c.allowAI&&c.includeNaming?' · 允许首条和最新消息参与命名':''}</small><div class="panel-actions" style="margin-top:10px"><button data-action="connection-edit" data-id="${esc(c.id)}">编辑</button><button data-action="connection-toggle" data-id="${esc(c.id)}">${c.enabled===false?'启用':'暂停'}</button><button data-action="connection-remove" data-id="${esc(c.id)}" class="danger">移除连接</button></div></article>`).join('')}</div>`:'<p>尚未配置来源。发现兼容来源，或指定自己的存储路径。</p>'}`;
  }
  async function showPair() {
    if(!onboardingFlow?.active)onboardingFlow={active:true,draft:state.onboarding?.draft||null,preview:null,candidates:[],url:state.bridge.url||'http://127.0.0.1:4518'};
    openOnboarding('pair',`<h3 class="onboarding-title">把浏览器与本机服务配对</h3>${onboardingFlow.serviceReady?'<p class="onboarding-success">✓ 已检测到本机服务</p>':''}<p>从启动窗口复制配对码。只授权当前 Task Out 扩展，后续仍由你选择要读取的来源。</p><form id="pair-form"><label class="field">配对码<input id="pair-code" autocomplete="off" required placeholder="粘贴启动窗口显示的配对码"><small>配对码不会保存在草稿中。</small></label><details class="connection-advanced"><summary>高级设置：本机服务地址</summary><label class="field">本机服务地址<input id="pair-url" type="url" value="${esc(onboardingFlow.url||state.bridge.url||'http://127.0.0.1:4518')}" required placeholder="http://127.0.0.1:4518"><small>使用启动窗口提供的地址；通常无需修改。</small></label></details></form><p class="settings-note">首次连接时 Chrome 会请求本机地址的访问权限，请点击允许。配对后将自动发现可接入的来源。</p>`,'<button data-action="onboarding-start-over">上一步</button><button class="primary" type="submit" form="pair-form">授权并配对，下一步</button>');
    return persistOnboarding('pair');
  }
  async function submitPair() {
    const flow=onboardingFlow,navigation=onboardingNavigation,active=()=>onboardingFlow===flow&&flowActive()&&flow.step==='pair'&&navigation===onboardingNavigation;
    const url=formValue('pair-url')||flow?.url||'http://127.0.0.1:4518',code=formValue('pair-code');if(!code)throw Error('请填写启动窗口中的配对码。');
    let parsed;try{parsed=new URL(url);}catch{throw Error('本机服务地址格式不正确，请按启动窗口中的地址填写。');}
    if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname))throw Error('本机服务地址必须为 localhost 或回环地址。');
    flow.url=url;
    try{await requestOrigin(url);}catch(error){if(!active())return;if(/未授予/.test(error.message))error.code='EXTENSION_PERMISSION_DENIED';throw error;}
    if(!active())return;
    let result;try{result=await api('pair',{url,code});}catch(error){if(!active())return;throw error;}
    if(active()&&$('#pair-code'))$('#pair-code').value='';await refreshSnapshot();
    if(!active())return;
    state.bridge.paired=true;flow.warning=result.warning||'';await persistOnboarding('discover');
    if(onboardingFlow!==flow||!flow.active||dialogMode!=='onboarding'||navigation!==onboardingNavigation)return;
    return discoverSources(true);
  }
  async function discoverSources(inFlow=false) {
    if(flowActive()&&onboardingFlow.step==='preview')onboardingFlow.draft=connectionValues(false);
    clearTimeout(onboardingTimer);
    if(!onboardingFlow?.active||!inFlow){onboardingFlow={active:true,step:'discover',draft:null,preview:null,candidates:[],warning:'',url:state.bridge.url||'http://127.0.0.1:4518'};}
    if(!state.bridge.paired)return showPair();
    openOnboarding('discover','<h3 class="onboarding-title">发现这台电脑上的会话来源</h3><p><span class="spinner" aria-hidden="true"></span>正在检查常见存储位置，不会自动启用来源或发送内容给模型。</p>','<button data-action="onboarding-pair">重新配对</button>');
    const flow=onboardingFlow,navigation=onboardingNavigation;
    await persistOnboarding('discover');if(onboardingFlow!==flow||!flowActive()||navigation!==onboardingNavigation)return;
    try{
      const [catalog,result]=await Promise.all([service('GET','/v1/connectors'),service('POST','/v1/discover',{})]);if(onboardingFlow!==flow||!flowActive()||navigation!==onboardingNavigation)return;
      state.connectors=catalog.connectors||catalog.data?.connectors||[];
      const candidates=result.candidates||result.discovered||result.connections||[];onboardingFlow.candidates=candidates;dialogContext={candidates};
      const diagnostic=(result.diagnostics||[]).map(item=>`<p>${esc(item.message||item.code)}</p>`).join('');
      openOnboarding('discover',`<h3 class="onboarding-title">选择要接入的会话来源</h3><p>这些是发现的候选位置。选择后会先展示读取范围，点击预览才授权读取。</p>${onboardingFlow.warning?`<div class="notice">配对已保存。${esc(onboardingFlow.warning)}<br>可在本步骤重新检测来源，无需重复使用配对码。</div>`:''}<div class="onboarding-candidates">${candidates.length?candidates.map((candidate,index)=>{const connector=state.connectors.find(item=>item.id===candidate.connectorId),name=candidate.displayName||candidate.name||connector?.displayName||connector?.name||'本机会话',icon=candidate.icon||connector?.icon||'session',paths=metadataSuggestions(candidate);return `<article class="panel-card onboarding-candidate"><div class="onboarding-source">${sourceIcon({kind:'session',sourceId:candidate.connectorId||'local',sourceIcon:icon})}<div><h3>${esc(name)}</h3><p>${esc(candidate.recognition||'根据会话存储位置发现，具体客户端将在预览时识别。')}</p></div></div><details class="connection-locations"><summary>查看发现的位置</summary><p>会话目录：${esc(candidate.root||candidate.path||'未提供')}${paths.length?`<br>可选名称资料目录：${paths.map(esc).join('、')}`:''}</p></details><button class="${candidate.connected?'':'primary'}" data-action="connection-candidate" data-index="${index}">${candidate.connected?'已接入 · 查看连接':'选择并继续'}</button></article>`;}).join(''):'<div class="onboarding-empty"><h3>尚未发现会话来源</h3><p>可以先在原应用发起一段会话后重新检测，或选择自己的会话目录。</p></div>'}</div>${diagnostic?`<details class="usage"><summary>查看发现提示</summary>${diagnostic}</details>`:''}`,'<button data-action="onboarding-discover">重新检测</button><button data-action="connection-add">手动选择来源</button>');
    }catch(error){if(onboardingFlow===flow&&flowActive()&&navigation===onboardingNavigation)connectionError(error);}
  }
  async function addConnectionManually() {
    clearTimeout(onboardingTimer);
    if(!onboardingFlow?.active)return beginOnboarding({fresh:true,manual:true});
    if(!state.bridge.paired)return showPair();
    const flow=onboardingFlow,navigation=onboardingNavigation;if(!state.connectors.length)await loadConnectorCatalog();if(onboardingFlow!==flow||!flowActive()||navigation!==onboardingNavigation)return;showConnectionEditor({},true);return persistOnboarding('preview',flow.draft);
  }
  async function selectConnectionCandidate(index) {
    clearTimeout(onboardingTimer);
    const candidate=onboardingFlow?.candidates?.[index]||dialogContext.candidates?.[index];if(!candidate)throw Error('发现结果已变化，请重新检测来源。');
    if(candidate.connected){const flow=onboardingFlow,navigation=onboardingNavigation,existing=state.connections.find(connection=>(candidate.connectorIds||[candidate.connectorId]).includes(connection.connectorId)&&(connection.root||connection.config?.root)===(candidate.root||candidate.path));await persistOnboarding('done',null);if(onboardingFlow!==flow||!flowActive()||navigation!==onboardingNavigation)return;flow.active=false;if(existing)return showConnectionEditor(existing);return showConnections();}
    const prepared={...candidate,name:candidate.displayName||candidate.name,allowAI:false,includeSummary:false,includeNaming:false};
    if(!prepared.metadataRoot&&!prepared.config?.metadataRoot){const suggested=metadataSuggestions(candidate);if(suggested.length)prepared.metadataRoot=suggested[0];}
    showConnectionEditor(prepared,true);return persistOnboarding('preview',onboardingFlow.draft);
  }
  function metadataSuggestions(...sources) {
    const candidates=sources.flatMap(source=>Array.isArray(source?.metadataRootSuggestions)?source.metadataRootSuggestions:[]);
    return [...new Set(candidates.map(candidate=>typeof candidate==='string'?candidate:candidate?.path||candidate?.root||candidate?.metadataRoot||'').filter(value=>typeof value==='string'&&value.trim()))].slice(0,20);
  }
  function connectorFields(connector,connection={}) {
    const fields=connector?.configFields||connector?.configuration?.fields||connector?.configSchema?.fields||[];
    return (Array.isArray(fields)?fields:[]).filter(safeConfigField).filter(field=>!['root','name','historyDays','allowAI','includeSummary','includeNaming','enabled'].includes(field.key||field.name)).map(field=>{const key=field.key||field.name;if(!key)return '';const value=connection[key]??connection.config?.[key]??field.default??'',label=field.label||key;
      if(field.type==='boolean')return `<label class="check-field"><input data-config-field="${esc(key)}" type="checkbox" ${value?'checked':''}><span>${esc(label)}${field.description?`<br><small class="muted">${esc(field.description)}</small>`:''}</span></label>`;
      if(field.options)return `<label class="field">${esc(label)}<select data-config-field="${esc(key)}">${field.options.map(option=>{const v=typeof option==='object'?option.value:option;return `<option value="${esc(v)}" ${v===value?'selected':''}>${esc(typeof option==='object'?option.label||option.value:option)}</option>`;}).join('')}</select></label>`;
      const suggestions=key==='metadataRoot'?metadataSuggestions(connection,connector):[];
      return `<div class="field"><label for="connection-field-${esc(key)}">${esc(label)}</label><div class="directory-input"><input id="connection-field-${esc(key)}" data-config-field="${esc(key)}" type="${field.type==='number'?'number':'text'}" value="${esc(value)}" ${suggestions.length?'list="metadata-root-suggestions"':''} ${field.required?'required':''} placeholder="${esc(field.placeholder||'')}">${field.type==='path'?`<button type="button" data-action="directory-select" data-field="${esc(key)}">选择目录</button>`:''}</div>${field.description?`<small>${esc(field.description)}</small>`:''}${suggestions.length?`<datalist id="metadata-root-suggestions">${suggestions.map(path=>`<option value="${esc(path)}"></option>`).join('')}</datalist><small>可修改或清空；仅点击预览后才读取所选目录。</small>`:''}</div>`;
    }).join('');
  }
  function connectionConfig(connection,connector) {
    const values={...connection.config,...connection};
    for(const field of connector?.configFields||[]){const key=field.key||field.name;if(key&&values[key]===undefined&&field.default!==undefined)values[key]=field.default;}
    return {...values,connectorId:connector?.id||connection.connectorId,root:connection.root||connection.config?.root||connection.path||'',name:connection.displayName||connection.name||connector?.displayName||connector?.name||'',historyDays:historyDays(connection.historyDays),allowAI:connection.allowAI===true,includeSummary:connection.includeSummary===true,includeNaming:connection.includeNaming===true};
  }
  function connectionScopeHTML(values) {
    const paths=[['会话目录',values.root||'尚未选择']];
    const connector=state.connectors.find(item=>item.id===values.connectorId);
    for(const field of connector?.configFields||[])if(field.type==='path'&&(field.key||field.name)!=='root'&&values[field.key||field.name])paths.push([(field.key||field.name)==='metadataRoot'?'会话名称资料目录':field.label||field.key||field.name,values[field.key||field.name]]);
    return `<p>将读取近 <strong>${historyDays(values.historyDays)} 天</strong>有活动的会话。${paths.length>1?'所选名称资料只用于补全原会话名称和命名依据。':''}原始会话文件不会被修改。</p><details class="connection-locations"><summary>查看将读取的 ${paths.length} 个位置</summary>${paths.map(([label,path])=>`<p>${esc(label)}<br><span class="detail-locator">${esc(path)}</span></p>`).join('')}</details>`;
  }
  function connectionFormHTML(connection,connector) {
    const name=connection.name||connector.displayName||connector.name,recognition=connection.recognition||'客户端身份会根据会话中的来源依据识别；无法确认时显示未知，不按目录猜测品牌。';
    return `<div class="onboarding-source">${sourceIcon({kind:'session',sourceId:connection.connectorId,sourceIcon:connection.icon||connector.icon||'session'})}<div><h3>${esc(name)}</h3><p>${esc(recognition)}</p></div></div><form id="connection-form"><label class="field">在 Task Out 中显示的名称<input id="connection-name" value="${esc(name)}" required placeholder="为这份来源起一个名称"></label><label class="field">查看多近的会话<select id="connection-history">${[3,7,30].map(days=>`<option value="${days}" ${historyDays(connection.historyDays)===days?'selected':''}>近 ${days} 天有活动的会话</option>`).join('')}</select><small>按最近活动时间获取，网页不受影响；以后缩小范围也会保留人工整理。</small></label><details id="connection-advanced" class="connection-advanced" ${connection.root?'':'open'}><summary>高级设置：会话目录、读取方式与身份</summary><div class="field"><label for="connection-root">会话目录</label><div class="directory-input"><input id="connection-root" value="${esc(connection.root||'')}" required placeholder="选择或填写会话所在目录"><button type="button" data-action="directory-select" data-field="root">选择目录</button></div><small>也可以手动输入路径，不绑定 Task Out 项目。</small></div><label class="field">读取方式<select id="connection-connector">${state.connectors.map(item=>`<option value="${esc(item.id)}" ${item.id===connector.id?'selected':''}>${esc(item.name||item.id)}</option>`).join('')}</select></label><p id="connector-description">${esc(connector.description||'读取兼容格式的本机会话文件。')}</p><div id="connector-fields">${connectorFields(connector,connection)}</div><details class="usage"><summary>手动指定客户端身份（可选）</summary><p>只有确认这份目录属于同一客户端时才填写。共享目录可能混有不同客户端，默认保留自动识别。</p><label class="field">来源标识<input id="connection-identity-id" value="${esc(connection.identity?.id||'')}" placeholder="my-agent"></label><label class="field">来源显示名称<input id="connection-identity-label" value="${esc(connection.identity?.label||'')}" placeholder="我的 Agent"></label><label class="field">来源图标<select id="connection-identity-icon"><option value="message" ${connection.identity?.icon==='terminal'?'':'selected'}>会话</option><option value="terminal" ${connection.identity?.icon==='terminal'?'selected':''}>终端</option></select></label></details></details><section class="connection-model-permissions"><h3>模型使用权限 · 可选</h3><p>读取本机会话不需要开启模型权限。默认只在本机查看，不向模型发送内容。</p><label class="check-field"><input id="connection-ai" type="checkbox" ${connection.allowAI?'checked':''}><span>允许标题参与模型整理</span></label><label class="check-field"><input id="connection-summary" type="checkbox" ${connection.includeSummary?'checked':''}><span>允许发送一句近况<small class="muted">（需同时允许标题）</small></span></label><label class="check-field"><input id="connection-naming" type="checkbox" ${connection.includeNaming?'checked':''}><span>允许首条与最新消息用于生成缺失名称<small class="muted">（需同时允许标题）</small></span></label><p class="settings-note">不发送完整历史；重复连接指向同一记录时，采用更严格的发送限制。</p></section></form><div id="connection-read-scope" class="connection-read-scope">${connectionScopeHTML(connection)}</div><p class="settings-note">点击“读取并预览”即授权读取上方所选目录。预览不会启用持续同步，也不会调用模型。</p><div id="connection-preview"></div><div id="connection-error" class="connection-error" role="alert" hidden></div>`;
  }
  function showConnectionEditor(connection={},inFlow=false) {
    if(!state.bridge.paired)return showPair();
    const connector=state.connectors.find(item=>item.id===connection.connectorId)||state.connectors[0];
    if(!connector){openDialog('尚未取得来源信息','<p>本机服务尚未返回可读取的会话类型。请检查服务启动状态，然后重新发现。</p>','<button data-action="connection-discover">重新发现</button>','connection');return;}
    const config=connectionConfig(connection,connector);dialogContext={connection:config,tested:null};
    if(inFlow){if(!onboardingFlow?.active)onboardingFlow={active:true,candidates:[],warning:''};onboardingFlow.draft=safeConnectionDraft(config);onboardingFlow.preview=null;
      openOnboarding('preview',`<h3 class="onboarding-title">确认读取范围，先看看内容</h3>${connectionFormHTML(config,connector)}`,'<button data-action="onboarding-discover">上一步</button><button class="primary" data-action="connection-test">读取并预览，下一步</button>');
    }else{openDialog('编辑会话来源',connectionFormHTML(config,connector),'<button data-action="connections">返回连接</button><button data-action="connection-test">读取并预览</button><button class="primary" type="submit" form="connection-form" disabled>保存并启用</button>','connection');}
  }
  function connectionValues(validate=true) {
    const values={connectorId:formValue('connection-connector'),root:formValue('connection-root'),name:formValue('connection-name'),historyDays:historyDays(formValue('connection-history')),allowAI:formChecked('connection-ai'),includeSummary:formChecked('connection-ai')&&formChecked('connection-summary'),includeNaming:formChecked('connection-ai')&&formChecked('connection-naming')};
    $$('[data-config-field]',dialog).forEach(input=>{values[input.dataset.configField]=input.type==='checkbox'?input.checked:input.type==='number'?(input.value===''?null:Number(input.value)):input.value.trim();});
    if(validate&&(!values.root||!values.name))throw Error('请填写来源名称，并在高级设置中选择会话目录。');
    const identityId=formValue('connection-identity-id'),identityLabel=formValue('connection-identity-label');
    if(identityId||identityLabel){if(validate&&(!/^[\w.-]{1,80}$/.test(identityId)||!identityLabel))throw Error('手动身份需要有效来源标识和显示名称；不确定时清空两个字段，使用自动识别。');values.identity={id:identityId,label:identityLabel,icon:formValue('connection-identity-icon')||'message'};}else values.identity=null;return values;
  }
  function invalidateConnectionPreview() {
    const hadPreview=!!dialogContext.tested;dialogContext.tested=null;
    const save=$('button[form="connection-form"]',dialog);if(save)save.disabled=true;
    if(hadPreview)$('#connection-preview').innerHTML='<p class="notice">配置已改变，请重新读取预览后再启用。</p>';
    const values=connectionValues(false);if($('#connection-read-scope'))$('#connection-read-scope').innerHTML=connectionScopeHTML(values);
    saveOnboardingDraftSoon();
  }
  async function chooseConnectionDirectory(field='root') {
    const context=dialogContext,navigation=onboardingNavigation,mode=dialogMode;
    const input=field==='root'?$('#connection-root'):$$('[data-config-field]',dialog).find(node=>node.dataset.configField===field);if(!input)return;
    const result=await service('POST','/v1/directories/select',{});if(result.cancelled)return;
    if(dialogContext!==context||dialogMode!==mode||onboardingNavigation!==navigation||!dialog.open||!result.path)return;
    const current=field==='root'?$('#connection-root'):$$('[data-config-field]',dialog).find(node=>node.dataset.configField===field);if(current!==input)return;
    input.value=result.path;invalidateConnectionPreview();
  }
  function connectionPreviewHTML(result) {
    const preview=result.preview||result,records=Array.isArray(preview)?preview:preview.records||preview.items||preview.sample||[],summary=result.summary||preview.summary||{},main=records.filter(record=>!record.parentId),count=Number.isSafeInteger(summary.mainCount)?summary.mainCount:null;
    const warnings=[...(preview.warnings||result.warnings||[]),...(result.diagnostics||preview.diagnostics||[]).filter(item=>item.code!=='NO_RECENT_SESSIONS')];
    const identity=summary.identity,identityText=typeof identity==='string'?identity:identity?.label,incomplete=summary.partial||summary.scanTruncated||summary.truncated;
    return `<div class="onboarding-preview-summary"><strong>${count===null?`预览到 ${main.length} 个主会话样例`:incomplete?`本次已读取 ${count} 个主会话`:`${count} 个主会话`}</strong><span>${Number.isSafeInteger(summary.childCount)?`${summary.childCount} 个子会话归入详情，不计入主会话`:'子会话归入主会话详情'}</span></div>${identityText?`<p>识别到的来源：${esc(identityText)}</p>`:''}${count===0?`<div class="notice">${incomplete?'本次未读到此范围会话，读取未完整，请先查看读取提示。':'这个时间范围内暂无会话，仍可启用。之后有新的活动时会自动显示。'}</div>`:''}${recordPreviewHTML(main,warnings)}${incomplete?'<p class="settings-note">读取未完整，数量仅代表已读取部分。请查看读取提示，调整后可重新预览。</p>':summary.sampleLimited?'<p class="settings-note">以下仅展示部分样例，主会话数量来自本次扫描。</p>':''}`;
  }
  function showOnboardingEnable() {
    const preview=onboardingFlow.preview;if(!preview)return showConnectionEditor(onboardingFlow.draft||{},true);
    const values=preview.values;
    openOnboarding('enable',`<h3 class="onboarding-title">预览通过，可以启用</h3><p>接入「${esc(values.name)}」后，会按设置频率同步近 ${historyDays(values.historyDays)} 天有活动的会话。</p>${connectionPreviewHTML(preview.result)}<div class="connection-read-scope">${connectionScopeHTML(values)}</div><p>${values.allowAI?'模型权限已按你的选择开启。':'模型权限保持关闭，内容只在本机查看。'}</p>`,'<button data-action="onboarding-adjust">返回调整</button><button class="primary" data-action="onboarding-enable">确认并启用</button>');
  }
  function recordPreviewHTML(records,warnings=[]) {
    return `${warnings.length?`<div class="notice">${warnings.map(w=>esc(typeof w==='string'?w:w.message||w.error||JSON.stringify(w))).join('<br>')}</div>`:''}<div class="list-preview">${records.slice(0,30).map(r=>`<div>${esc(r.title||r.originalTitle||r.id||'未命名记录')}<small>${esc(r.sourceName||r.source?.label||r.sourceId||'未知来源')} · ${esc(fullDate(r.updatedAt))}${r.parentId?' · 子会话':''}</small></div>`).join('')||'<div>该范围内暂无记录</div>'}</div>${records.length>30?`<small class="muted">仅展示前 30 条，共 ${records.length} 条。</small>`:''}`;
  }
  let connectionPreviewSerial=0;
  async function testConnection() {
    const values=connectionValues(),context=dialogContext,request=++connectionPreviewSerial,inFlow=flowActive(),flow=onboardingFlow,navigation=onboardingNavigation,form=$('#connection-form'),mode=dialogMode;
    const active=()=>request===connectionPreviewSerial&&dialogContext===context&&dialogMode===mode&&dialog.open&&$('#connection-form')===form&&(!inFlow||onboardingFlow===flow&&flowActive()&&onboardingNavigation===navigation&&flow.step==='preview');
    dialogContext.tested=null;const save=$('button[form="connection-form"]',dialog);if(save)save.disabled=true;
    const error=$(inFlow?'#onboarding-error':'#connection-error');if(error)error.hidden=true;
    $('#connection-preview').innerHTML='<p><span class="spinner"></span>正在读取你选择的目录，生成本机预览…</p>';
    if(inFlow){flow.draft=values;await persistOnboarding('preview',values);}
    if(!active())return;
    let result;try{result=await service('POST','/v1/test',values);}catch(error){if(!active())return;throw error;}
    if(!active())return;
    if(result.ok===false||result.valid===false||result.canEnable===false)throw Object.assign(Error(result.error||result.message||'预览未通过，请检查目录和读取方式。'),{code:result.code});
    const stillSame=JSON.stringify(values)===JSON.stringify(connectionValues());
    if(!stillSame){$('#connection-preview').innerHTML='<p class="notice">读取期间配置已改变，请按新范围重新预览。</p>';return;}
    dialogContext.tested=JSON.stringify(values);
    if(inFlow){onboardingFlow.preview={values:structuredClone(values),result};showOnboardingEnable();await persistOnboarding('enable',values);return;}
    $('#connection-preview').innerHTML=`<h3 class="dialog-section">预览通过</h3>${connectionPreviewHTML(result)}`;if(save)save.disabled=false;
  }
  async function saveConnection() {
    const inFlow=flowActive(),flow=onboardingFlow,context=dialogContext,navigation=onboardingNavigation,mode=dialogMode,old={...(dialogContext.connection||{})},preview=inFlow?flow.preview:null,values=structuredClone(preview?.values||connectionValues());
    const active=()=>dialog.open&&dialogContext===context&&dialogMode===mode&&(!inFlow||onboardingFlow===flow&&flowActive()&&navigation===onboardingNavigation);
    if(inFlow&&!preview||context.tested!==JSON.stringify(values))throw Error('请先读取并查看当前配置的预览，再启用来源。');
    clearTimeout(onboardingTimer);if(inFlow)await onboardingSaveQueue.catch(()=>{});if(!active())return;
    let saved;try{saved=await service(old.id?'PATCH':'POST',old.id?`/v1/connections/${encodeURIComponent(old.id)}`:'/v1/connections',{...values,enabled:true});}catch(error){if(!active())return;throw error;}
    if(!active()){await refreshSnapshot();return;}
    if(inFlow){
      flow.draft=null;flow.preview=null;flow.step='done';await persistOnboarding('done',null);await refreshSnapshot();if(!active())return;
      openOnboarding('done',`<div class="onboarding-done-mark" aria-hidden="true">✓</div><h3 class="onboarding-title">「${esc(values.name)}」已接入</h3><p>同步完成后，会话将与网页一起出现在首页。你可以在设置中调整来源、获取范围和模型权限。</p><p class="settings-note">首次预览仅反映已发生的历史活动，不能证明原 Agent 此刻正在运行。</p>${saved.warning?`<div class="notice">来源已保存，暂未同步完成：${esc(saved.warning)}<br>无需再次添加，点击“刷新同步”即可重试。</div>`:''}`,'<button data-action="onboarding-refresh">刷新同步</button><button data-action="onboarding-add-another">继续添加来源</button><button class="primary" data-action="onboarding-finish">完成，查看首页</button>');
      return;
    }
    await mutate('refresh',{},'来源已启用，正在同步');if(active())await showConnections();
  }
  function showImport() {
    dialogContext={preview:null};
    openDialog('导入标准记录',`<p>支持 JSON 数组、带 records 的 JSON 对象，或每行一条记录的 JSONL。填写稳定的数据集标识，重复导入可更新同一份数据。</p><form id="import-form"><label class="field">数据集标识<input id="import-dataset" required placeholder="例如：my-research-export"></label><label class="field">选择文件<input id="import-file" type="file" accept=".json,.jsonl,application/json"></label><label class="field">记录内容<textarea id="import-text" rows="8" required placeholder='[{"id":"conversation-1","kind":"session","title":"示例会话","source":{"id":"my-agent","label":"我的 Agent"}}]'></textarea></label></form><div id="import-preview"></div>`,'<button data-action="dialog-close">取消</button><button data-action="import-preview">预览数据</button><button type="submit" form="import-form" class="primary">导入</button>','import');
  }
  async function previewImport() {
    const datasetId=formValue('import-dataset'),text=formValue('import-text');if(!datasetId||!text)throw Error('请填写数据集标识和记录内容。');
    const result=await api('import-preview',{datasetId,text}),preview=result.preview||result;dialogContext.preview={datasetId,text};
    $('#import-preview').innerHTML=`<h3 class="dialog-section">导入预览 · ${(preview.projects||[]).length} 个项目 · ${(preview.records||[]).length} 条记录 · ${Object.keys(preview.sourceStyles||{}).length} 个来源外观</h3>${preview.projects?.length?`<div class="list-preview">${preview.projects.map(p=>`<div>项目：${esc(p.name)}</div>`).join('')}</div><br>`:''}${recordPreviewHTML(preview.records||[],preview.warnings||[])}`;
    return preview;
  }
  async function applyImport() {
    const datasetId=formValue('import-dataset'),text=formValue('import-text');if(dialogContext.preview?.datasetId!==datasetId||dialogContext.preview?.text!==text){await previewImport();showToast('预览已生成，请确认后再次点击导入');return;}
    await mutate('import-apply',{datasetId,text},'记录已导入');dialog.close();
  }
  function showExport() {
    openDialog('导出数据',`<p>数据导出包含项目、标签与整理记录，可能包含你的会话标题和路径，请自行选择分享范围。配置导出不包含密钥与配对凭据。</p><label class="field">导出内容<select id="export-mode"><option value="data">记录与整理结果</option><option value="config">配置模板（不含凭据）</option></select></label>`,'<button data-action="dialog-close">取消</button><button data-action="export-download" class="primary">下载 JSON</button>','export');
  }
  async function downloadExport() {
    const mode=formValue('export-mode'),result=await api('export',{mode}),data=result.data||result;
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`task-out-${mode}-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);dialog.close();showToast('已下载导出文件');
  }
  function showMigration() {
    const migration=state.migration||{},groups=migration.groups||[],deferred=migration.deferred||[];
    openDialog('迁移上一版数据',`<p>旧主题可转为项目；稍后查看标记保留，“已完成”转为归档。迁移前会保留原始备份，重复迁移不会创建重复记录。</p><label class="check-field"><input id="migration-groups" type="checkbox" checked>将旧主题转为项目</label><h3 class="dialog-section">旧主题 · ${groups.length}</h3><div class="list-preview">${groups.map(g=>`<div>${esc(typeof g==='string'?g:g.name||g.label||g.title||g.id)}</div>`).join('')||'<div>没有旧主题</div>'}</div><h3 class="dialog-section">稍后查看与已完成 · ${deferred.length}</h3>${recordPreviewHTML(deferred)}`,'<button data-action="dialog-close">取消</button><button data-action="migration-apply" class="primary">开始迁移</button>','migration');
  }
  async function handleAction(action,target) {
    const id=target.dataset.id;
    switch(action) {
      case 'open': {const item=itemById(id);if(!extension){const href=safeUrl(item?.url||item?.locator?.url);if(href)window.open(href,'_blank','noopener,noreferrer');else throw Error('这条记录没有可验证的网页地址。');return;}await api('open',{id});return;}
      case 'settings': showSettings();return;
      case 'source-styles': showSourceStyles();return;
      case 'source-style-edit': showSourceStyleEditor(target.dataset.sourceId);return;
      case 'source-style-color': chooseSourceStyleColor(target.dataset.color);return;
      case 'source-style-reset': return resetSourceStyle();
      case 'organize-now': return organizeNow();
      case 'pending-suggestions': suggestions=Array.isArray(state.suggestions)?state.suggestions:[];showSuggestionList(suggestions,state.suggestionExcluded||[]);return;
      case 'unbound': dialog.close();ui={...ui,scope:'unbound',kind:'all',source:'all',project:'all',tag:'all',query:''};$('#query').value='';$('#kind').value='all';render();return;
      case 'detail': return showDetail(id);
      case 'name-sessions': return showNaming(id);
      case 'detail-close': detail.close();return;
      case 'browser-candidates': return showBrowserCandidates(id);
      case 'record-rebind': return applyBrowserRebind();
      case 'restore-reset-review': reviewRestoreReset(id);return;
      case 'resolution-back': dialog.close();return showDetail(id);
      case 'restore-reset-confirm': {const recordId=dialogContext.id;await mutate('restore-reset',{id:recordId},'已清除未确认结果，现在可以重新恢复');dialog.close();return showDetail(recordId);}
      case 'dialog-close': if(flowActive())return exitOnboarding();if(dialogMode==='ai-loading'){aiRequest++;loading=false;await api('ai-cancel');}dialog.close();return;
      case 'bookmark': return mutate('bookmark',{id},itemById(id)?.saved?'已取消稍后查看':'已加入稍后查看');
      case 'archive': case 'restore': {await archiveRecords(action,[id],action==='archive'?'已归档':'已恢复');if(detail.open&&detail.dataset.id===id)await showDetail(id);return;}
      case 'group-archive': return archiveRecords(ui.scope==='archived'?'restore':'archive',JSON.parse(target.dataset.ids),ui.scope==='archived'?'本组已恢复':'本组已归档');
      case 'batch-archive': return archiveRecords(ui.scope==='archived'?'restore':'archive',visibleItems().filter(i=>ui.scope==='archived'?i.archived:!i.archived).map(i=>i.id),ui.scope==='archived'?'当前结果已恢复':'当前结果已归档');
      case 'record-edit': if(detail.open)detail.close();openEditor(id);return;
      case 'project-new': openProject();return;
      case 'project-edit': openProject(id);return;
      case 'project-delete': await mutate('project-delete',{id:dialogContext.id},'空项目已删除');dialog.close();return;
      case 'model': showModel();return;
      case 'usage': return showUsage();
      case 'usage-range': return showUsage(Number(target.dataset.days));
      case 'pricing-edit': return showPricing(Number(target.dataset.index));
      case 'pricing-back': return showUsage(dialogContext.days||30);
      case 'progress-refresh': return mutate('progress-refresh',{},'进展已刷新');
      case 'model-test': return saveModel(true);
      case 'model-forget': dialogContext.forgetKey=true;$('#model-key').value='';$('#model-key-hint').textContent='保存时清除已保存的 Key；取消则保留。';return;
      case 'organize': showOrganize();return;
      case 'ai-generate': return generateSuggestions();
      case 'ai-cancel': aiRequest++;loading=false;await api('ai-cancel');dialog.close();showToast('已取消，尚未应用的建议未改变记录');return;
      case 'ai-apply': return applySuggestions();
      case 'connections': case 'service-status': return showConnections();
      case 'service-stop': {target.disabled=true;try{await mutate('service-stop',{},'本机服务正在停止');await showConnections();}finally{target.disabled=false;}return;}
      case 'pair': return showPair();
      case 'onboarding-start': return beginOnboarding();
      case 'onboarding-start-over': return showOnboardingStart();
      case 'onboarding-check': return checkOnboardingService();
      case 'onboarding-pair': return showPair();
      case 'onboarding-discover': return discoverSources(true);
      case 'onboarding-exit': return exitOnboarding();
      case 'onboarding-adjust': showConnectionEditor(onboardingFlow.draft||{},true);return persistOnboarding('preview',onboardingFlow.draft);
      case 'onboarding-enable': return saveConnection();
      case 'onboarding-add-another': return beginOnboarding({fresh:true});
      case 'onboarding-refresh': {await mutate('refresh',{},'会话同步已刷新');const error=$('#onboarding-error');if(error)error.hidden=true;return;}
      case 'onboarding-finish': onboardingFlow.active=false;dialog.close();render();return;
      case 'connection-retry': return connectionRetry();
      case 'connection-adjust': return connectionAdjustment();
      case 'directory-select': return chooseConnectionDirectory(target.dataset.field);
      case 'connection-discover': return discoverSources();
      case 'connection-add': return addConnectionManually();
      case 'connection-candidate': return selectConnectionCandidate(Number(target.dataset.index));
      case 'connection-edit': if(onboardingFlow)onboardingFlow.active=false;showConnectionEditor(state.connections.find(c=>c.id===id));return;
      case 'connection-test': return testConnection();
      case 'connection-toggle': {const c=state.connections.find(c=>c.id===id);await service('PATCH',`/v1/connections/${encodeURIComponent(id)}`,{enabled:c.enabled===false});await refreshSnapshot();await showConnections();showToast(c.enabled===false?'来源已启用':'来源已暂停，历史仍保留');return;}
      case 'connection-remove': {const c=state.connections.find(c=>c.id===id);dialogContext={connection:c};openDialog('移除连接',`<p>移除「${esc(c?.name||id)}」后停止同步，Task Out 已读取的历史与整理结果继续保留。原始会话文件不变。</p>`,'<button data-action="connections">取消</button><button data-action="connection-remove-confirm" class="danger">移除连接</button>','connection-remove');return;}
      case 'connection-remove-confirm': await service('DELETE',`/v1/connections/${encodeURIComponent(dialogContext.connection.id)}`);await refreshSnapshot();await showConnections();showToast('连接已移除，历史记录保留');return;
      case 'refresh': return mutate('refresh',{},extension?'已刷新记录':'预览数据已刷新');
      case 'undo': return mutate('undo',{},'已撤销上次整理');
      case 'import': showImport();return;
      case 'import-preview': return previewImport();
      case 'export': showExport();return;
      case 'export-download': return downloadExport();
      case 'migration': showMigration();return;
      case 'migration-skip': return mutate('migration-skip',{},'已跳过本次迁移');
      case 'migration-apply': await mutate('migration-apply',{includeGroups:formChecked('migration-groups')},'迁移完成，原始备份已保留');dialog.close();return;
      case 'reset-filters': ui={...ui,query:'',kind:'all',source:'all',project:'all',tag:'all',range:'3'};$('#query').value='';$('#kind').value='all';$('#range').value='3';render();return;
    }
  }
  document.addEventListener('click',async event=>{
    const target=event.target.closest('[data-action],[data-grouping],[data-scope],[data-tag],[data-stat]');
    if(!target){const row=event.target.closest('.group-row');if(row&&!event.target.closest('a,button,input,select,textarea')){const i=itemById(row.dataset.recordId);try{await handleAction(i.kind==='web'&&!(ui.scope==='unbound'&&unboundBrowser(i))?'open':'detail',{dataset:{id:i.id}});}catch(error){showToast(error.message,true);}}return;}
    if(target.dataset.grouping){ui.grouping=target.dataset.grouping;render();return;}
    if(target.dataset.scope){ui.scope=target.dataset.scope;render();return;}
    if(target.dataset.tag){ui.tag=target.dataset.tag;render();return;}
    if(target.dataset.stat){if(target.dataset.stat==='recent'){ui.scope='recent';ui.range='7';$('#range').value='7';render();}else showToast('获取范围内创建时间未知的记录可在当前总览查看，不计入“最近发起”；最近活动时间未知的本机会话不纳入获取范围。');return;}
    if(target.tagName==='A'&&(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey))return;
    event.preventDefault();if(target.getAttribute('aria-busy')==='true')return;
    target.setAttribute('aria-busy','true');
    try{await handleAction(target.dataset.action,target);}catch(error){if(dialog.open)dialogError(error);else showToast(error.message,true);}finally{target.removeAttribute('aria-busy');}
  });
  document.addEventListener('submit',async event=>{
    event.preventDefault();const form=event.target;if(form.dataset.busy==='true')return;form.dataset.busy='true';const submitter=event.submitter;submitter?.setAttribute('aria-busy','true');if($('#dialog-error'))$('#dialog-error').textContent='';
    try{
      if(form.id==='project-form'){await mutate('project-save',{...(dialogContext.id?{id:dialogContext.id}:{}),name:formValue('project-name'),color:formValue('project-color')},'项目已保存');dialog.close();}
      else if(form.id==='record-form'){const initial=dialogContext.initial,patch={},tags=selectedType(formValue('record-tags'));if(formValue('record-alias')!==initial.title)patch.alias=formValue('record-alias');if(formValue('record-project')!==initial.projectId)patch.projectId=formValue('record-project');if(JSON.stringify(tags)!==JSON.stringify(initial.tags))patch.tags=tags;if(formValue('record-summary')!==initial.summary)patch.summary=formValue('record-summary');if(formValue('record-source')!==initial.sourceName)patch.sourceName=formValue('record-source');if(Object.keys(patch).length)await mutate('record-edit',{id:dialogContext.id,patch},'调整已保存');else showToast('没有新的调整');dialog.close();}
      else if(form.id==='model-form')await saveModel();
      else if(form.id==='source-style-form')await saveSourceStyle();
      else if(form.id==='pricing-form')await savePricing();
      else if(form.id==='sync-settings-form')await mutate('sync-settings-save',{intervalSeconds:Number(formValue('sync-interval'))},'刷新频率已保存');
      else if(form.id==='pair-form')await submitPair();
      else if(form.id==='connection-form')await (flowActive()&&onboardingFlow.step==='preview'?testConnection():saveConnection());
      else if(form.id==='import-form')await applyImport();
    }catch(error){dialogError(error);}finally{form.dataset.busy='false';submitter?.removeAttribute('aria-busy');}
  });
  document.addEventListener('change',async event=>{
    const element=event.target;
    if(['kind','source','project','range','sort'].includes(element.id)){ui[element.id]=element.value;render();}
    if(element.id==='show-summaries'){ui.summaries=element.checked;render();}
    if(dialogMode==='source-style'&&element.name==='source-style-icon'){dialogContext.styleDraft.icon=element.value;updateSourceStylePreview();}
    if(element.id==='source-style-color')chooseSourceStyleColor(element.value);
    if(element.matches('.suggestion-project'))$('.suggestion-project-name',element.closest('.suggestion-card')).hidden=element.value!=='__new__';
    if(element.id==='model-base'&&dialogContext.hadKey){if(dialogContext.forgetKey)$('#model-key-hint').textContent='保存时清除已保存的 Key；取消则保留。';else if(!element.value.trim())$('#model-key-hint').textContent='地址留空表示不变，原地址与 Key 都会保留。';else {try{const canonical=value=>new URL(value).href.replace(/\/+$/,'').replace(/\/chat\/completions$/,'');$('#model-key-hint').textContent=canonical(element.value)!==canonical(dialogContext.originalBase)?'更换模型服务地址时，请填写新 Key；若新服务无需 Key，请明确点击“清除 Key”。未处理前不会修改原配置。':'Key 留空保持原值；只有明确点击“清除 Key”才会删除。';}catch{}}}
    if(element.id==='connection-connector'){const c=state.connectors.find(c=>c.id===element.value);$('#connector-description').textContent=c?.description||'读取兼容格式的会话记录，无法确认的来源与状态将标记为未知。';$('#connector-fields').innerHTML=connectorFields(c,{});dialogContext.tested=null;}
    if(['connection','onboarding'].includes(dialogMode)&&(element.id?.startsWith('connection-')||element.dataset?.configField))invalidateConnectionPreview();
    if(element.id==='import-file'&&element.files?.[0]){try{const file=element.files[0];if(file.size>10*1024*1024)throw Error('单次导入文件请控制在 10 MB 以内。');$('#import-text').value=await file.text();if(!formValue('import-dataset'))$('#import-dataset').value=file.name.replace(/\.(jsonl?|ndjson)$/i,'');dialogContext.preview=null;}catch(error){dialogError(error);}}
  });
  $('#query').addEventListener('input',event=>{ui.query=event.target.value;render();});
  document.addEventListener('input',event=>{const element=event.target;if(element.id==='source-style-color')chooseSourceStyleColor(element.value);if(['connection','onboarding'].includes(dialogMode)&&(element.id?.startsWith('connection-')||element.dataset?.configField))invalidateConnectionPreview();if(flowActive()&&element.id==='pair-url')onboardingFlow.url=element.value.trim();});
  document.addEventListener('dblclick',event=>{if(event.target.closest('a,button,input,select,textarea'))return;const row=event.target.closest('.group-row');if(row&&itemById(row.dataset.recordId)?.kind!=='web')openEditor(row.dataset.recordId);});
  document.addEventListener('dragstart',event=>{const row=event.target.closest('.group-row');if(!row)return;event.dataTransfer.setData('application/x-task-out-record',row.dataset.recordId);event.dataTransfer.effectAllowed='move';});
  document.addEventListener('dragover',event=>{const card=event.target.closest('[data-project-drop]');if(!card||card.dataset.projectDrop==='__none__'||!Array.from(event.dataTransfer.types).includes('application/x-task-out-record'))return;event.preventDefault();event.dataTransfer.dropEffect='move';card.classList.add('drop-target');});
  document.addEventListener('dragleave',event=>{const card=event.target.closest('[data-project-drop]');if(card&&!card.contains(event.relatedTarget))card.classList.remove('drop-target');});
  document.addEventListener('dragend',()=>$$('.drop-target').forEach(c=>c.classList.remove('drop-target')));
  document.addEventListener('drop',async event=>{const card=event.target.closest('[data-project-drop]');$$('.drop-target').forEach(c=>c.classList.remove('drop-target'));if(!card||card.dataset.projectDrop==='__none__')return;const id=event.dataTransfer.getData('application/x-task-out-record');if(!id||!itemById(id))return;event.preventDefault();try{await mutate('record-edit',{id,patch:{projectId:card.dataset.projectDrop}},'已移动到项目，人工归属会保留');}catch(error){showToast(error.message,true);}});
  document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key==='k'){event.preventDefault();$('#query').focus();}});
  dialog.addEventListener('cancel',event=>{if(flowActive()){event.preventDefault();exitOnboarding().catch(dialogError);return;}if(dialogMode==='ai-loading'){aiRequest++;loading=false;api('ai-cancel').catch(error=>showToast(error.message,true));}});
  for(const modal of [dialog,detail])modal.addEventListener('click',async event=>{if(event.target!==modal)return;const rect=modal.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom){if(modal===dialog&&flowActive()){try{await exitOnboarding();}catch(error){dialogError(error);}return;}if(modal===dialog&&dialogMode==='ai-loading'){aiRequest++;loading=false;api('ai-cancel').catch(error=>showToast(error.message,true));}modal.close();}});
  if(extension)chrome.runtime.onMessage.addListener(message=>{if(message?.type==='task-out-updated')refreshSnapshot();});

  // Standalone pages are an import-only, temporary preview, never a pretend agent connection.
  function previewAction(action,fields) {
    const C=TaskOutCore;
    if(action==='snapshot')return {state:{...emptyState(),projects:C.copy(previewState.projects),sourceStyles:C.copy(previewState.sourceStyles||{}),items:previewState.records.map(r=>C.publicItem(r)),undoAvailable:!!previewUndo.length}};
    if(action==='record-detail')return {item:C.publicItem(C.find(previewState,fields.id)),children:previewState.records.filter(i=>i.parentId===fields.id).map(r=>C.publicItem(r))};
    if(action==='import-preview')return {preview:C.importRecords(fields.datasetId,fields.text)};
    if(action==='export')return {data:fields.mode==='config'?{format:'task-out-config',version:2,connections:[],model:{baseUrl:'',model:'',rules:'',autoOrganize:true}}:{format:'task-out-records',version:2,projects:C.copy(previewState.projects),sourceStyles:C.copy(previewState.sourceStyles||{}),records:C.copy(previewState.records)}};
    if(action==='refresh'||action==='ai-cancel')return {};
    if(action==='undo'){if(!previewUndo.length)throw Error('没有可以撤销的操作');previewState=previewUndo.pop();return {};}
    if(['project-save','project-delete','record-edit','bookmark','archive','restore','import-apply','source-style-save','source-style-reset'].includes(action)) {
      const next=C.copy(previewState);
      let newlyCreatedProject=null;
      if(action==='project-save')newlyCreatedProject=C.saveProject(next,fields);
      if(action==='source-style-save')C.saveSourceStyle(next,fields);
      if(action==='source-style-reset')C.resetSourceStyle(next,fields.sourceId);
      if(action==='project-delete'){if(next.records.some(i=>i.user.projectId===fields.id))throw Error('项目中仍有记录，请先移出记录');next.projects=next.projects.filter(p=>p.id!==fields.id);}
      if(action==='record-edit')C.userPatch(next,fields.id,fields.patch);
      if(action==='bookmark'){const record=C.find(next,fields.id);if(!record)throw Error('记录不存在');record.user.saved=!record.user.saved;record.user.revision++;}
      if(action==='archive'||action==='restore')for(const id of fields.ids){const record=C.find(next,id);if(record){record.user.archived=action==='archive';record.user.archivedAt=record.user.archived?Date.now():null;record.user.archivedActivityAt=record.updatedAt;record.user.revision++;}}
      if(action==='import-apply'){
        const parsed=C.importRecords(fields.datasetId,fields.text);if(!parsed.records.length&&!parsed.projects.length&&!Object.keys(parsed.sourceStyles||{}).length)throw Error('没有可以导入的有效记录、项目或来源外观');
        for(const project of parsed.projects)if(!next.projects.some(p=>p.id===project.id))next.projects.push(project);
        for(const [id,style] of Object.entries(parsed.sourceStyles||{}))if(!Object.prototype.hasOwnProperty.call(next.sourceStyles||{},id))C.saveSourceStyle(next,{sourceId:id,...style});
        const previous=new Set(next.records.map(r=>r.id));C.upsert(next,parsed.records);
        for(const record of parsed.records)if(!previous.has(record.id)&&record.importUser)C.find(next,record.id).user=C.copy(record.importUser);
      }
      C.pruneEmptyProjects(next,newlyCreatedProject?[newlyCreatedProject.id]:[]);
      previewUndo.push(C.copy(previewState));if(previewUndo.length>30)previewUndo.shift();previewState=next;return action==='archive'||action==='restore'?{results:fields.ids.map(id=>({id,ok:!!C.find(next,id)}))}:{};
    }
    throw Error('这项能力需要已安装的 Chrome 扩展。当前页面仅支持导入数据和临时整理。');
  }

  refreshSnapshot();
})();
