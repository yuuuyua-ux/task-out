const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const Core=require('../extension/core.js');
const connector={id:'fixture-jsonl',name:'示例会话读取方式',displayName:'示例助手',icon:'terminal',configFields:[
  {key:'root',type:'path'},{key:'metadataRoot',type:'path',label:'名称资料',default:''},{key:'pollIntervalMs',type:'number',default:60000},
  {key:'hiddenValue',type:'password',default:'secret-must-not-show'},{key:'hiddenFlag',type:'text',sensitive:true,default:'private-must-not-show'}]};
const candidate={connectorId:connector.id,displayName:'示例助手',name:'technical reader',icon:'terminal',recognition:'根据示例存储位置发现，预览时识别客户端',root:'/fixtures/agent/sessions',metadataRootSuggestions:['/fixtures/agent']};
const goodPreview={canEnable:true,records:[{id:'main-a',title:'样例：方案评审',updatedAt:Date.now(),source:{label:'示例助手'}},{id:'child-a',title:'子会话不计入主列表',parentId:'main-a',updatedAt:Date.now()}],summary:{mainCount:4,childCount:1,totalCount:5,sampleLimited:true,identity:{label:'示例助手'}},warnings:[]};
function dashboard({paired=false,onboarding={step:'start',draft:null},connections=[],override,permission=true}={}){
  let snapshot={projects:[],items:[],connections:structuredClone(connections),connectors:paired?[structuredClone(connector)]:[],onboarding:structuredClone(onboarding),bridge:{url:'http://127.0.0.1:4518',paired},model:{autoOrganize:false}},timerId=0;
  const nodes=new Map(),handlers=new Map(),timers=new Map(),requests=[],permissionRequests=[];let activeConfig=[];
  const decode=text=>String(text||'').replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&amp;','&');
  const attribute=(attrs,name)=>decode(attrs.match(new RegExp('(?:^|\\s)'+name+'="([^"]*)"'))?.[1]||'');
  const node=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{id:selector.startsWith('#')?selector.slice(1):'',value:'',checked:false,disabled:false,hidden:false,type:'text',dataset:{},listeners:{},_html:'',
      get innerHTML(){return this._html;},set innerHTML(html){this._html=html;if(selector==='#dialog')hydrate(html);},
      textContent:'',classList:{toggle(){},add(){},remove(){}},querySelector:node,querySelectorAll:selector=>selector==='[data-config-field]'?activeConfig:[],
      addEventListener(type,callback){this.listeners[type]=callback;},matches:()=>false,showModal(){this.open=true;},close(){this.open=false;},focus(){this.focused=true;}});
    return nodes.get(selector);
  };
  function hydrate(html){
    activeConfig=[];
    for(const match of html.matchAll(/<input\b([^>]*)>/g)){const attrs=match[1],id=attribute(attrs,'id'),key=attribute(attrs,'data-config-field');if(!id&&!key)continue;const input=node('#'+(id||'config-'+key));input.value=attribute(attrs,'value');input.type=attribute(attrs,'type')||'text';input.checked=/\schecked(?:\s|$)/.test(attrs);input.dataset=key?{configField:key}:{};if(key)activeConfig.push(input);}
    for(const match of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)){const attrs=match[1],id=attribute(attrs,'id'),key=attribute(attrs,'data-config-field');if(!id&&!key)continue;const options=[...match[2].matchAll(/<option\b([^>]*)>/g)],selected=options.find(option=>/\sselected(?:\s|$)/.test(option[1]))||options[0];const input=node('#'+(id||'config-'+key));input.value=attribute(selected?.[1]||'','value');input.dataset=key?{configField:key}:{};if(key)activeConfig.push(input);}
    const save=node('button[form="connection-form"]');save.disabled=/<button\b[^>]*form="connection-form"[^>]*disabled/.test(html);
  }
  const context={URL,crypto,structuredClone,TaskOutCore:Core,clearTimeout:id=>timers.delete(id),setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},
    document:{querySelector:node,querySelectorAll:()=>[],addEventListener:(type,handler)=>handlers.set(type,handler)},chrome:{permissions:{request:async fields=>{permissionRequests.push(fields);return permission;}},runtime:{id:'fixture-extension',onMessage:{addListener(){}},sendMessage:async request=>{
      requests.push(structuredClone(request));if(override){const response=await override(request);if(response!==undefined)return response;}
      if(request.action==='snapshot')return {ok:true,state:structuredClone(snapshot)};
      if(request.action==='onboarding-save'){snapshot.onboarding={step:request.step,draft:structuredClone(request.draft)};return {ok:true,onboarding:snapshot.onboarding};}
      if(request.action==='pair'){snapshot.bridge.paired=true;snapshot.onboarding.step='discover';return {ok:true,paired:true};}
      if(request.action==='service-status')return {ok:true,service:{state:'running',paired:snapshot.bridge.paired}};
      if(request.action==='refresh')return {ok:true};
      if(request.path==='/v1/connectors')return {ok:true,connectors:[structuredClone(connector)]};
      if(request.path==='/v1/discover')return {ok:true,candidates:[structuredClone(candidate)]};
      if(request.path==='/v1/test')return {ok:true,...structuredClone(goodPreview)};
      if(request.path==='/v1/directories/select')return {ok:true,path:'/fixtures/selected',cancelled:false};
      if(request.path==='/v1/connections'&&request.method==='POST'){const connection={...request.body,id:'saved-source'};snapshot.connections=[connection];snapshot.onboarding={step:'done',draft:null};return {ok:true,connection};}
      throw Error('Unexpected request '+JSON.stringify(request));
    }}}};
  vm.createContext(context);const code=fs.readFileSync('extension/dashboard.js','utf8').replace('  refreshSnapshot();\n})();','  globalThis.fixture={refreshSnapshot,handleAction,dialogError};\n})();');vm.runInContext(code,context);
  return {node,requests,permissionRequests,refresh:context.fixture.refreshSnapshot,snapshot:()=>structuredClone(snapshot),
    action:(action,dataset={})=>context.fixture.handleAction(action,{dataset}),
    safeAction:async(action,dataset={})=>{try{await context.fixture.handleAction(action,{dataset});}catch(error){context.fixture.dialogError(error);}},
    submit:async id=>handlers.get('submit')({target:node('#'+id),preventDefault(){}}),
    change:async(id,value)=>{const target=node('#'+id);target.value=value;await handlers.get('change')({target});},
    input:async(id,value)=>{const target=node('#'+id);target.value=value;await handlers.get('input')({target});},
    runDraftTimer:async()=>{for(const [id,timer] of [...timers])if(timer.ms===350){timers.delete(id);await timer.fn();}},
    escape:async()=>{const event={preventDefault(){this.prevented=true;}};node('#dialog').listeners.cancel(event);await new Promise(resolve=>setImmediate(resolve));return event;}};
}
async function previewStep(app){await app.refresh();await app.action('onboarding-start');await app.action('connection-candidate',{index:'0'});}

test('first setup explains startup and five steps, grants only local origin then advances to pairing',async()=>{
  const app=dashboard();await app.refresh();await app.action('settings');assert.match(app.node('#dialog').innerHTML,/接入本机会话/);await app.action('onboarding-start');
  const html=app.node('#dialog').innerHTML;for(const label of ['启动','配对','发现','预览','启用','下载的 Task Out 文件夹 / scripts / Start Task Out.command'])assert.ok(html.includes(label));
  assert.equal(app.requests.some(request=>request.path==='/v1/test'),false);await app.action('onboarding-check');assert.equal(app.permissionRequests.length,1);assert.deepEqual(Array.from(app.permissionRequests[0].origins),['http://127.0.0.1:4518/*']);assert.match(app.node('#dialog').innerHTML,/id="pair-code"/);
});
test('pair success immediately discovers candidates, selects readable names and metadata path without reading until preview',async()=>{
  const app=dashboard();await app.refresh();await app.action('onboarding-start');await app.action('onboarding-pair');app.node('#pair-code').value='fixture-one-use-code';await app.submit('pair-form');
  assert.match(app.node('#dialog').innerHTML,/选择要接入的会话来源/);assert.match(app.node('#dialog').innerHTML,/示例助手/);assert.equal(app.requests.filter(request=>request.path==='/v1/discover').length,1);
  await app.action('connection-candidate',{index:'0'});const html=app.node('#dialog').innerHTML;
  assert.equal(app.node('#connection-name').value,'示例助手');assert.equal(app.node('#connection-field-metadataRoot').value,'/fixtures/agent');assert.match(html,/查看将读取的 2 个位置/);assert.match(html,/默认只在本机查看/);assert.match(html,/id="connection-advanced" class="connection-advanced" >/);
  for(const id of ['connection-ai','connection-summary','connection-naming'])assert.equal(app.node('#'+id).checked,false);
  assert.equal(app.requests.some(request=>request.path==='/v1/test'),false);assert.equal(app.requests.some(request=>request.action==='onboarding-save'&&JSON.stringify(request).includes('fixture-one-use-code')),false);assert.doesNotMatch(html,/secret-must-not-show|private-must-not-show|hiddenValue|hiddenFlag/);
});
test('only a successful current preview enables a source, counts main sessions separately, and successful save clears draft',async()=>{
  const app=dashboard({paired:true});await previewStep(app);await assert.rejects(app.action('onboarding-enable'),/请先读取/);assert.equal(app.requests.some(request=>request.path==='/v1/connections'&&request.method==='POST'),false);
  await app.action('connection-test');const html=app.node('#dialog').innerHTML;assert.match(html,/4 个主会话/);assert.match(html,/1 个子会话归入详情/);assert.match(html,/样例：方案评审/);assert.doesNotMatch(html,/子会话不计入主列表/);assert.match(html,/确认并启用/);
  await app.action('onboarding-enable');assert.match(app.node('#dialog').innerHTML,/示例助手.*已接入/);assert.equal(app.snapshot().onboarding.step,'done');assert.equal(app.snapshot().onboarding.draft,null);
  const saved=app.requests.find(request=>request.path==='/v1/connections'&&request.method==='POST');assert.equal(saved.body.metadataRoot,'/fixtures/agent');assert.equal(saved.body.allowAI,false);
  await app.runDraftTimer();assert.equal(app.snapshot().onboarding.step,'done');
});
test('empty valid preview remains enableable; incomplete reads never claim the full directory is empty',async()=>{
  for(const partial of [false,true]){
    const app=dashboard({paired:true,override:request=>request.path==='/v1/test'?{ok:true,canEnable:true,records:[],summary:{mainCount:0,childCount:0,totalCount:0,partial},diagnostics:[{code:'NO_RECENT_SESSIONS',message:'范围内暂无会话'}]}:undefined});await previewStep(app);await app.action('connection-test');
    assert.match(app.node('#dialog').innerHTML,partial?/本次未读到此范围会话/:/这个时间范围内暂无会话，仍可启用/);if(partial)assert.match(app.node('#dialog').innerHTML,/读取未完整，数量仅代表已读取部分/);
    await app.action('onboarding-enable');assert.equal(app.snapshot().connections.length,1);
  }
});
test('dirty range and path changes invalidate preview and persist only safe configuration; escape resumes at preview',async()=>{
  const app=dashboard({paired:true});await previewStep(app);await app.action('connection-test');await app.action('onboarding-adjust');await app.change('connection-history','3');await app.input('connection-root','/fixtures/changed');await app.runDraftTimer();
  const draft=app.snapshot().onboarding.draft;assert.equal(draft.root,'/fixtures/changed');assert.equal(draft.historyDays,3);assert.equal(draft.metadataRoot,'/fixtures/agent');assert.equal(Object.hasOwn(draft,'records'),false);assert.equal(Object.hasOwn(draft,'hiddenValue'),false);
  await assert.rejects(app.action('onboarding-enable'),/请先读取/);const escaped=await app.escape();assert.equal(escaped.prevented,true);assert.match(app.node('#dialog').innerHTML,/继续接入本机会话/);
  await app.action('onboarding-start');assert.equal(app.node('#connection-root').value,'/fixtures/changed');assert.equal(app.node('#connection-history').value,'3');assert.doesNotMatch(app.node('#dialog').innerHTML,/确认并启用/);
});
test('restoring saved enable step requires a new preview and never persists pairing secrets or preview bodies',async()=>{
  const draft={connectorId:connector.id,root:'/fixtures/restore',name:'恢复的来源',metadataRoot:'/fixtures/names',historyDays:7,allowAI:false,hiddenValue:'secret',hiddenFlag:'private',apiKey:'key',pairCode:'code',records:['private body']};
  const app=dashboard({paired:true,onboarding:{step:'enable',draft}});await app.refresh();await app.action('onboarding-start');assert.equal(app.node('#connection-root').value,'/fixtures/restore');assert.equal(app.node('#connection-field-metadataRoot').value,'/fixtures/names');assert.match(app.node('#dialog').innerHTML,/读取并预览，下一步/);assert.doesNotMatch(app.node('#dialog').innerHTML,/private body|secret|hiddenValue/);
  await assert.rejects(app.action('onboarding-enable'),/请先读取/);const saved=app.requests.filter(request=>request.action==='onboarding-save').at(-1);for(const field of ['hiddenValue','hiddenFlag','apiKey','pairCode','records'])assert.equal(Object.hasOwn(saved.draft,field),false);
});
test('errors stay in the current step with recovery actions; permission denial never attempts pairing',async()=>{
  const denied=dashboard({permission:false});await denied.refresh();await denied.action('onboarding-start');await denied.safeAction('onboarding-check');assert.match(denied.node('#onboarding-error').innerHTML,/重新授权并配对/);assert.equal(denied.requests.some(request=>request.action==='pair'),false);
  for(const [code,text] of [['PAIR_CODE_EXPIRED','Restart Task Out.command'],['PAIR_CODE_INVALID','重新填写配对码'],['CONNECTION_EXPIRED','重新配对']]){
    const app=dashboard({override:request=>request.action==='pair'?{ok:false,code,error:'虚构配对失败'}:undefined});await app.refresh();await app.action('onboarding-start');await app.action('onboarding-pair');app.node('#pair-code').value='fixture-code';await app.submit('pair-form');assert.ok(app.node('#onboarding-error').innerHTML.includes(text));assert.match(app.node('#dialog').innerHTML,/id="pair-code"/);
  }
  const app=dashboard({paired:true,override:request=>request.path==='/v1/test'?{ok:false,code:'DIRECTORY_NOT_FOUND',error:'虚构目录不存在'}:undefined});await previewStep(app);await app.safeAction('connection-test');assert.match(app.node('#onboarding-error').innerHTML,/调整目录/);assert.equal(app.requests.some(request=>request.path==='/v1/connections'&&request.method==='POST'),false);
});
test('native directory picker can cancel without errors and a chosen path invalidates existing preview',async()=>{
  let cancelled=true;const app=dashboard({paired:true,override:request=>request.path==='/v1/directories/select'?{ok:true,cancelled,path:cancelled?null:'/fixtures/picked'}:undefined});await previewStep(app);await app.action('directory-select',{field:'root'});assert.equal(app.node('#connection-root').value,candidate.root);
  cancelled=false;await app.action('directory-select',{field:'root'});assert.equal(app.node('#connection-root').value,'/fixtures/picked');await app.runDraftTimer();assert.equal(app.snapshot().onboarding.draft.root,'/fixtures/picked');await assert.rejects(app.action('onboarding-enable'),/请先读取/);
});
test('pair response after exiting does not reopen the wizard or read stale pairing controls',async()=>{
  let resolve;const gate=new Promise(done=>{resolve=done;});const app=dashboard({override:request=>request.action==='pair'?gate:undefined});await app.refresh();await app.action('onboarding-start');await app.action('onboarding-pair');app.node('#pair-code').value='fixture-code';const pending=app.submit('pair-form');await new Promise(done=>setImmediate(done));await app.action('onboarding-exit');resolve({ok:true,paired:true});await pending;assert.doesNotMatch(app.node('#dialog').innerHTML,/选择要接入的会话来源/);assert.equal(app.requests.some(request=>request.path==='/v1/discover'),false);
});
test('saved connection with later sync warning stays completed and offers refresh without a second POST',async()=>{
  const app=dashboard({paired:true,override:request=>request.path==='/v1/connections'&&request.method==='POST'?{ok:true,connection:{...request.body,id:'saved'},warning:'虚构同步暂不可用',code:'SERVICE_OFFLINE'}:undefined});await previewStep(app);await app.action('connection-test');await app.action('onboarding-enable');assert.match(app.node('#dialog').innerHTML,/无需再次添加/);assert.match(app.node('#dialog').innerHTML,/data-action="onboarding-refresh"/);assert.doesNotMatch(app.node('#dialog').innerHTML,/data-action="onboarding-enable"/);assert.equal(app.snapshot().onboarding.step,'done');await app.action('onboarding-refresh');assert.equal(app.requests.filter(request=>request.path==='/v1/connections'&&request.method==='POST').length,1);
});

test('resuming after pairing credential persistence restores a valid saved connection without asking for the used code',async()=>{
  const app=dashboard({onboarding:{step:'discover',draft:null},override:request=>request.action==='service-status'?{ok:true,service:{state:'running',paired:true}}:undefined});await app.refresh();await app.action('onboarding-start');assert.match(app.node('#dialog').innerHTML,/选择要接入的会话来源/);assert.doesNotMatch(app.node('#dialog').innerHTML,/id="pair-code"/);assert.equal(app.requests.some(request=>request.action==='pair'),false);
});
test('a slow connector catalog cannot reopen an exited resumed draft',async()=>{
  let resolve;const gate=new Promise(done=>{resolve=done;});const app=dashboard({paired:true,onboarding:{step:'preview',draft:{connectorId:connector.id,root:'/fixtures/restore',name:'保留草稿',historyDays:7}},override:request=>request.path==='/v1/connectors'?gate:undefined});await app.refresh();const pending=app.action('onboarding-start');await new Promise(done=>setImmediate(done));await app.action('onboarding-exit');resolve({ok:true,connectors:[connector]});await pending;assert.doesNotMatch(app.node('#dialog').innerHTML,/确认读取范围/);
});

test('an old enable result cannot clear a newer draft or reopen its completed page after exit',async()=>{
  let resolve;const gate=new Promise(done=>{resolve=done;});const app=dashboard({paired:true,override:request=>request.path==='/v1/connections'&&request.method==='POST'?gate:undefined});await previewStep(app);await app.action('connection-test');const pending=app.action('onboarding-enable');await new Promise(done=>setImmediate(done));await app.action('onboarding-exit');await app.action('onboarding-add-another');await app.action('connection-candidate',{index:'0'});await app.input('connection-name','新的来源草稿');await app.runDraftTimer();resolve({ok:true,connection:{id:'previous-source'}});await pending;assert.match(app.node('#dialog').innerHTML,/确认读取范围/);assert.equal(app.node('#connection-name').value,'新的来源草稿');assert.equal(app.snapshot().onboarding.draft.name,'新的来源草稿');assert.equal(app.snapshot().onboarding.step,'preview');
});
test('an old native directory result cannot fill another candidate form',async()=>{
  let resolve;const gate=new Promise(done=>{resolve=done;});const app=dashboard({paired:true,override:request=>request.path==='/v1/directories/select'?gate:undefined});await previewStep(app);const pending=app.action('directory-select',{field:'root'});await app.action('onboarding-discover');await app.action('connection-candidate',{index:'0'});resolve({ok:true,path:'/fixtures/stale-picker',cancelled:false});await pending;assert.equal(app.node('#connection-root').value,candidate.root);
});
test('an old preview response cannot replace an in-flight discovery step',async()=>{
  let previewResolve,discoverResolve,discoveries=0;const previewGate=new Promise(done=>{previewResolve=done;}),discoverGate=new Promise(done=>{discoverResolve=done;});
  const app=dashboard({paired:true,override:request=>{if(request.path==='/v1/test')return previewGate;if(request.path==='/v1/discover'&&++discoveries>1)return discoverGate;}});await previewStep(app);const pendingPreview=app.action('connection-test');await new Promise(done=>setImmediate(done));const pendingDiscover=app.action('onboarding-discover');await new Promise(done=>setImmediate(done));previewResolve({ok:true,...goodPreview});await pendingPreview;assert.match(app.node('#dialog').innerHTML,/正在检查常见存储位置/);assert.doesNotMatch(app.node('#dialog').innerHTML,/确认并启用/);discoverResolve({ok:true,candidates:[candidate]});await pendingDiscover;assert.match(app.node('#dialog').innerHTML,/选择要接入的会话来源/);
});
test('already connected candidates lead to their existing editor instead of posting a duplicate source',async()=>{
  const existing={...candidate,name:'已经接入的示例',id:'existing-source',historyDays:7};const app=dashboard({paired:true,connections:[existing],override:request=>request.path==='/v1/discover'?{ok:true,candidates:[{...candidate,connected:true}]}:undefined});await app.refresh();await app.action('onboarding-start');assert.match(app.node('#dialog').innerHTML,/已接入 · 查看连接/);await app.action('connection-candidate',{index:'0'});assert.match(app.node('#dialog').innerHTML,/编辑会话来源/);assert.doesNotMatch(app.node('#dialog').innerHTML,/onboarding-steps/);assert.equal(app.requests.some(request=>request.path==='/v1/connections'&&request.method==='POST'),false);
});
