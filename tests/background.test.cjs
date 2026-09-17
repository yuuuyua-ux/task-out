const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const crypto=require('node:crypto').webcrypto;
const core=require('../extension/core.js');
const suggestions=require('../extension/suggestions.js');

async function setup({local={},session={},initial,failRemove=false}={}) {
  const tabs=new Map([[1,{id:1,windowId:1,title:'First',url:'https://example.com/same'}],[2,{id:2,windowId:1,title:'Second',url:'https://example.com/same'}]]);
  const handlers={},removed=[],created=[],focused=[];let db=initial||core.initial(),failSave=false,nextId=10;
  const event=name=>({addListener:fn=>{handlers[name]=fn;}});
  const storage=value=>({get:async key=>typeof key==='string'?{[key]:value[key]}:Object.fromEntries(key.map(k=>[k,value[k]])),set:async patch=>Object.assign(value,patch),setAccessLevel:async()=>{}});
  const chrome={storage:{local:storage(local),session:storage(session)},permissions:{contains:async()=>true},
    runtime:{id:'abcdefghijklmnopabcdefghijklmnop',getURL:p=>'chrome-extension://abcdefghijklmnopabcdefghijklmnop/'+p,sendMessage:async()=>{},onMessage:event('message'),onStartup:event('startup'),onInstalled:event('install')},
    tabs:{query:async()=>[...tabs.values()],get:async id=>{if(!tabs.has(id))throw Error('missing');return tabs.get(id);},
      update:async(id,patch)=>{focused.push(id);Object.assign(tabs.get(id),patch);},remove:async id=>{if(failRemove)throw Error('close failed');tabs.delete(id);removed.push(id);handlers.removed?.(id,{isWindowClosing:false});},
      create:async value=>{const t={id:nextId++,windowId:1,title:'Restored',...value};tabs.set(t.id,t);created.push(t);handlers.created?.(t);return t;},
      onCreated:event('created'),onUpdated:event('updated'),onRemoved:event('removed'),onActivated:event('activated')},
    windows:{update:async()=>{},onFocusChanged:event('focus')},alarms:{create:async()=>{},onAlarm:event('alarm')},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},onClicked:event('toolbar')}};
  const ctx={chrome,crypto,structuredClone,URL,AbortSignal,AbortController,Date,console,importScripts:()=>{},
    setTimeout:()=>0,clearTimeout:()=>{},TaskOutCore:core,TaskOutSuggestions:suggestions,
    TaskOutStore:{read:async()=>structuredClone(db),write:async next=>{if(failSave)throw Error('disk full');db=structuredClone(next);}},
    fetch:async()=>{throw Error('No network in test');}};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync('extension/background.js','utf8')+'\nthis.testAPI={ready,dispatch,enqueue,getState:()=>state};',ctx);
  await ctx.testAPI.ready;
  return {api:ctx.testAPI,local,session,handlers,tabs,removed,created,focused,db:()=>db,failSave:value=>{failSave=value;},call:(action,fields={})=>ctx.testAPI.dispatch({action,...fields})};
}
test('same-URL tabs are distinct and archive/restore targets exactly one instance',async()=>{
  const x=await setup();let snapshot=await x.call('snapshot');assert.equal(snapshot.state.items.length,2);
  const record=snapshot.state.items.find(i=>i.title==='Second');await x.call('open',{id:record.id});assert.deepEqual(x.focused,[2]);
  await x.call('archive',{ids:[record.id]});assert.deepEqual(x.removed,[2]);assert.equal(x.tabs.has(1),true);
  await Promise.all([x.call('restore',{ids:[record.id]}),x.call('restore',{ids:[record.id]})]);assert.equal(x.created.length,1);
  snapshot=await x.call('snapshot');assert.equal(snapshot.state.items.length,2);assert.equal(snapshot.state.items.find(i=>i.id===record.id).archived,false);
});
test('save failure prevents closing a tab and close failure preserves current record',async()=>{
  const x=await setup();const id=(await x.call('snapshot')).state.items[0].id;x.failSave(true);
  await assert.rejects(()=>x.call('archive',{ids:[id]}),/disk full/);assert.equal(x.removed.length,0);
  const y=await setup({failRemove:true});const item=(await y.call('snapshot')).state.items[0];
  const result=await y.call('archive',{ids:[item.id]});assert.equal(result.results[0].ok,false);
  assert.equal((await y.call('snapshot')).state.items[0].archived,false);
});
test('native close archives, while window shutdown detaches without mass archival',async()=>{
  const x=await setup();x.tabs.delete(1);x.handlers.removed(1,{isWindowClosing:false});await x.api.enqueue(()=>{});
  let records=(await x.call('snapshot')).state.items;assert.equal(records.find(r=>r.binding.tabId===1).archived,true);
  x.tabs.delete(2);x.handlers.removed(2,{isWindowClosing:true});await x.api.enqueue(()=>{});
  records=(await x.call('snapshot')).state.items;assert.equal(records.find(r=>r.binding.tabId===2).archived,false);assert.equal(records.find(r=>r.binding.tabId===2).needsBinding,true);
});
test('legacy migration is idempotent and backup omits credentials',async()=>{
  const x=await setup({session:{aiView:{groups:[{domain:'old',label:'Project',members:[{id:1,url:'https://example.com/same',manual:true}]}]}},local:{deferred:[{id:99,title:'Saved',url:'https://example.com/saved',completed:true,savedAt:1000}],llmConfig:{baseUrl:'https://model.example/v1',model:'existing',apiKey:'test-secret'}}});
  assert.equal((await x.call('snapshot')).state.migration.pending,true);
  await x.call('migration-apply');await x.call('migration-apply');const snap=(await x.call('snapshot')).state;
  assert.equal(snap.projects.length,1);assert.equal(snap.items.filter(i=>i.id==='legacy-saved:99').length,1);
  assert.equal(snap.items.find(i=>i.id==='legacy-saved:99').archived,true);
  assert.equal(JSON.stringify(x.local.taskOutMigrationBackup).includes('test-secret'),false);
  assert.equal(snap.model.autoSuggest,false);assert.equal(snap.model.hasKey,true);assert.equal(snap.model.apiKey,undefined);
  assert.equal(JSON.stringify((await x.call('export',{mode:'config'})).data).includes('test-secret'),false);
});
test('manual project and tags persist through worker restarts; tab epoch does not merge new tabs',async()=>{
  const x=await setup();const item=(await x.call('snapshot')).state.items[0];const {project}=await x.call('project-save',{name:'Persistent'});
  await x.call('record-edit',{id:item.id,patch:{projectId:project.id,tags:['需求规划']}});
  const restarted=await setup({initial:x.db(),local:x.local,session:x.session});
  const restored=(await restarted.call('snapshot')).state.items.find(i=>i.id===item.id);assert.equal(restored.projectId,project.id);assert.deepEqual([...restored.tags],['需求规划']);
  const browserRestart=await setup({initial:x.db(),local:x.local,session:{}});
  const records=(await browserRestart.call('snapshot')).state.items;assert.equal(records.length,4);assert.equal(records.find(i=>i.id===item.id).needsBinding,true);
});

test('empty projects are removed automatically on refresh and restart while a just-created project remains assignable',async()=>{
  const initial=core.initial();core.saveProject(initial,{name:'上次遗留空组'});
  const x=await setup({initial});
  assert.equal(x.db().projects.length,0);
  const {project}=await x.call('project-save',{name:'待分配项目'});
  assert.equal((await x.call('snapshot')).state.projects[0].id,project.id);
  await x.call('refresh');
  assert.equal(x.db().projects.length,0);
  const restarted=await setup({initial:x.db(),local:x.local,session:x.session});
  assert.equal((await restarted.call('snapshot')).state.projects.length,0);
});

test('moving the final member removes its old group and undo restores that group after refresh and worker restart',async()=>{
  const x=await setup(),record=(await x.call('snapshot')).state.items[0];
  const {project:original}=await x.call('project-save',{name:'原项目',color:core.COLORS[3]});
  await x.call('record-edit',{id:record.id,patch:{projectId:original.id}});
  const {project:destination}=await x.call('project-save',{name:'目标项目'});
  await x.call('record-edit',{id:record.id,patch:{projectId:destination.id}});
  assert.deepEqual(x.db().projects.map(p=>p.id),[destination.id]);
  await x.call('refresh');
  const restarted=await setup({initial:x.db(),local:x.local,session:x.session});
  assert.deepEqual(restarted.db().projects.map(p=>p.id),[destination.id]);
  const result=await restarted.call('undo');
  assert.equal(result.restored,1);assert.equal(result.conflicts,0);
  assert.equal(restarted.db().records.find(r=>r.id===record.id).user.projectId,original.id);
  assert.deepEqual(restarted.db().projects,[original]);
});

test('archiving a groups only session preserves its project through cleanup and restart, then restores its membership',async()=>{
  const initial=core.initial();
  const project=core.saveProject(initial,{name:'归档后保留的项目',color:core.COLORS[1]});
  const record=core.normalizeRecord({id:'session:archive-member',kind:'session',title:'归档任务',updatedAt:Date.now()});
  record.user.projectId=project.id;initial.records.push(record);
  const x=await setup({initial});
  await x.call('archive',{ids:[record.id]});
  await x.call('project-save',{name:'应清理的空组'});
  await x.call('refresh');
  assert.deepEqual(x.db().projects,[project]);
  const restarted=await setup({initial:x.db(),local:x.local,session:x.session});
  await restarted.call('restore',{ids:[record.id]});
  const restored=(await restarted.call('snapshot')).state.items.find(r=>r.id===record.id);
  assert.equal(restored.archived,false);assert.equal(restored.projectId,project.id);
  assert.deepEqual(restarted.db().projects,[project]);
});

function detachedRecord({pending=false}={}) {
  const state=core.initial();
  state.projects=[{id:'project-preserved',name:'保留的项目',color:core.COLORS[0]}];
  const record=core.normalizeRecord({id:'browser:previous-session:7',kind:'web',connectorId:'browser',title:'原来的网页',url:'https://example.com/same'});
  record.binding={epoch:'previous-session',tabId:7,windowId:1,live:false};
  record.user.projectId='project-preserved';record.user.tags=['调研分析'];record.user.alias='人工名称';
  record.user.saved=true;record.user.manual={projectId:true,tags:true,summary:false};
  if(pending){record.user.archived=true;record.user.archivedAt=1000;record.pending={type:'restore',operationId:'uncertain-open'};record.error='上次恢复未确认';}
  state.records.push(record);return {state,id:record.id};
}

test('browser candidates are read-only and selecting an explicit tab preserves original organisation',async()=>{
  const {state,id}=detachedRecord();const x=await setup({initial:state});
  const before=structuredClone(x.db());
  const {tabs:candidates}=await x.call('browser-candidates',{id});
  assert.deepEqual(Array.from(candidates,t=>t.tabId),[1,2]);
  assert.deepEqual(x.db(),before);
  assert.equal(before.records.length,3);
  await x.call('record-rebind',{id,tabId:2});
  const after=(await x.call('snapshot')).state.items,original=after.find(r=>r.id===id);
  assert.equal(after.length,2);assert.equal(original.binding.tabId,2);assert.equal(original.needsBinding,false);
  assert.equal(original.projectId,'project-preserved');assert.deepEqual(Array.from(original.tags),['调研分析']);
  assert.equal(original.title,'人工名称');assert.equal(original.saved,true);
  assert.equal(after.some(r=>r.id!==id&&r.binding.tabId===1),true);
  assert.equal(after.some(r=>r.id!==id&&r.binding.tabId===2),false);
  await x.call('open',{id});assert.deepEqual(x.focused,[2]);
  assert.equal(x.created.length,0);assert.equal(x.removed.length,0);
});

test('explicit rebind rejects candidates with existing project, tags, alias, summary or bookmark',async()=>{
  for(const kind of ['project','tags','alias','summary','bookmark']){
    const {state,id}=detachedRecord();const x=await setup({initial:state});
    const candidate=(await x.call('snapshot')).state.items.find(r=>r.id!==id&&r.binding.tabId===2);
    if(kind==='bookmark')await x.call('bookmark',{id:candidate.id});
    else {
      const patch=kind==='project'?{projectId:'project-preserved'}:kind==='tags'?{tags:['测试排障']}:kind==='alias'?{alias:'已有名称'}:{summary:'已确认近况'};
      await x.call('record-edit',{id:candidate.id,patch});
    }
    const before=structuredClone(x.db());
    await assert.rejects(()=>x.call('record-rebind',{id,tabId:2}),/已有整理内容/);
    assert.deepEqual(x.db(),before);assert.equal(x.created.length,0);assert.equal(x.removed.length,0);
  }
});

test('rebind rechecks current URL and does not move a record already bound to another live tab',async()=>{
  const {state,id}=detachedRecord();const x=await setup({initial:state});
  await x.call('browser-candidates',{id});
  x.tabs.get(2).url='https://example.com/navigated';
  const before=structuredClone(x.db());
  await assert.rejects(()=>x.call('record-rebind',{id,tabId:2}),/网址与记录不一致/);
  await assert.rejects(()=>x.call('record-rebind',{id,tabId:999}),/missing/);
  assert.deepEqual(x.db(),before);
  x.tabs.get(2).url='https://example.com/same';
  const live=(await x.call('snapshot')).state.items.find(r=>r.id!==id&&r.binding.tabId===1);
  await assert.rejects(()=>x.call('record-rebind',{id:live.id,tabId:2}),/仍关联着一个打开的页签/);
  assert.deepEqual(x.db(),before);assert.equal(x.created.length,0);
});

test('confirming an uncertain restore reset permits only one subsequent open under concurrent restore requests',async()=>{
  const {state,id}=detachedRecord({pending:true});const x=await setup({initial:state});
  const blocked=await x.call('restore',{ids:[id]});
  assert.equal(blocked.results[0].ok,false);assert.equal(x.created.length,0);
  await x.call('restore-reset',{id});
  const reset=(await x.call('snapshot')).state.items.find(r=>r.id===id);
  assert.equal(reset.pending,null);assert.equal(reset.archived,true);assert.equal(reset.error,'');
  await Promise.all([x.call('restore',{ids:[id]}),x.call('restore',{ids:[id]})]);
  await x.api.enqueue(()=>{});
  const items=(await x.call('snapshot')).state.items,restored=items.find(r=>r.id===id);
  assert.equal(x.created.length,1);assert.equal(items.length,3);
  assert.equal(restored.archived,false);assert.equal(restored.pending,null);assert.equal(restored.binding.tabId,x.created[0].id);
  assert.equal(restored.projectId,'project-preserved');assert.deepEqual(Array.from(restored.tags),['调研分析']);
  await assert.rejects(()=>x.call('restore-reset',{id}),/没有需要核对/);
  await x.call('restore',{ids:[id]});assert.equal(x.created.length,1);
});

test('confirming an already-open candidate resolves pending restore without creating another tab',async()=>{
  const {state,id}=detachedRecord({pending:true});const x=await setup({initial:state});
  await x.call('record-rebind',{id,tabId:1});
  const restored=(await x.call('snapshot')).state.items.find(r=>r.id===id);
  assert.equal(restored.pending,null);assert.equal(restored.archived,false);assert.equal(restored.binding.tabId,1);
  await x.call('restore',{ids:[id]});await x.call('open',{id});
  assert.equal(x.created.length,0);assert.deepEqual(x.focused,[1]);
  assert.equal(x.tabs.has(2),true);assert.equal(x.removed.length,0);
});

test('source style messages persist across refresh and worker restart without changing source or organisation',async()=>{
  const initial=core.initial();delete initial.sourceStyles;
  const x=await setup({initial});const before=x.db().records.map(r=>({id:r.id,source:r.source,user:r.user,observations:r.observations}));
  assert.deepEqual((await x.call('snapshot')).state.sourceStyles,{});
  await x.call('source-style-save',{sourceId:'browser',icon:'web',color:'#123ABC'});
  assert.deepEqual(x.db().records.map(r=>({id:r.id,source:r.source,user:r.user,observations:r.observations})),before);
  x.tabs.get(1).title='网页标题更新';await x.call('refresh');
  const restarted=await setup({initial:x.db(),local:x.local,session:x.session});
  assert.deepEqual((await restarted.call('snapshot')).state.sourceStyles,{browser:{icon:'web',color:'#123abc'}});
  assert.equal(core.sourceAppearance(restarted.db(),restarted.db().records[0]).color,'#123abc');
  await restarted.call('source-style-reset',{sourceId:'browser'});
  assert.deepEqual((await restarted.call('snapshot')).state.sourceStyles,{});
  assert.equal(restarted.db().policyRevision,0);
});

test('invalid or failed source style writes preserve the previously saved appearance',async()=>{
  const x=await setup();await x.call('source-style-save',{sourceId:'browser',icon:'web',color:'#123456'});
  await assert.rejects(()=>x.call('source-style-save',{sourceId:'browser',icon:'web',color:'red'}));
  x.failSave(true);await assert.rejects(()=>x.call('source-style-save',{sourceId:'browser',icon:'folder',color:'#abcdef'}),/disk full/);
  x.failSave(false);assert.deepEqual((await x.call('snapshot')).state.sourceStyles,{browser:{icon:'web',color:'#123456'}});
});

test('data export and import preserve source styles while keeping existing customizations and excluding config templates',async()=>{
  const original=await setup();
  await original.call('source-style-save',{sourceId:'browser',icon:'folder',color:'#123456'});
  await original.call('source-style-save',{sourceId:'__proto__',icon:'sparkles',color:'#abcdef'});
  const {data}=await original.call('export');
  assert.deepEqual(data.sourceStyles.browser,{icon:'folder',color:'#123456'});
  assert.equal(Object.prototype.hasOwnProperty.call(data.sourceStyles,'__proto__'),true);
  const target=await setup();await target.call('source-style-save',{sourceId:'browser',icon:'terminal',color:'#fedcba'});
  const text=JSON.stringify(data),preview=(await target.call('import-preview',{datasetId:'backup',text})).preview;
  assert.deepEqual(preview.sourceStyles.browser,{icon:'folder',color:'#123456'});
  const result=await target.call('import-apply',{datasetId:'backup',text});
  assert.ok(result.warnings.some(value=>value.includes('已有自定义外观')));
  assert.deepEqual(target.db().sourceStyles.browser,{icon:'terminal',color:'#fedcba'});
  assert.deepEqual(target.db().sourceStyles.__proto__,{icon:'sparkles',color:'#abcdef'});
  const restarted=await setup({initial:target.db(),local:target.local,session:target.session});
  assert.deepEqual((await restarted.call('snapshot')).state.sourceStyles,target.db().sourceStyles);
  const template=(await restarted.call('export',{mode:'config'})).data;
  assert.equal(template.sourceStyles,undefined);assert.equal(JSON.stringify(template).includes('#fedcba'),false);
  assert.equal({}.icon,undefined);
});

test('style-only data imports are valid and malformed styles report warnings without affecting saved records',async()=>{
  const x=await setup();const before=x.db().records.map(r=>r.user);
  const text=JSON.stringify({records:[],sourceStyles:{custom:{icon:'code',color:'#ab12cd'},broken:{icon:'code',color:'#abc'}}});
  const result=await x.call('import-apply',{datasetId:'styles',text});
  assert.match(result.message,/1 个来源外观/);assert.equal(result.warnings.length,1);
  assert.deepEqual(x.db().records.map(r=>r.user),before);
  assert.deepEqual(x.db().sourceStyles,{custom:{icon:'code',color:'#ab12cd'}});
});
