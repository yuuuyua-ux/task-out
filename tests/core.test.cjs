const {test} = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extension/core.js');
const base = Date.now() - 10000;
const at = offset => base + offset;
const raw = (patch = {}) => ({id: 'session:1', kind: 'session', connectorId: 'fixture', title: 'Original', source: {id:'sdk',label:'SDK 会话'},
  createdAt: at(1000), createdAtBasis: 'source', updatedAt: at(2000), summary: 'Progress',
  observations:[{connectionId:'a',allowAI:true,includeSummary:true}], ...patch});

test('source refresh and duplicate connections preserve manual organisation and archives', () => {
  const state = core.initial(); const p = core.saveProject(state,{name:'My project'});
  core.upsert(state,[raw()]); core.userPatch(state,'session:1',{projectId:p.id,tags:['调研分析'],summary:'My note'});
  state.records[0].user.archived = true;
  core.upsert(state,[raw({updatedAt:at(3000),summary:'Fresh',observations:[{connectionId:'b',allowAI:false}]})]);
  assert.equal(state.records.length,1); assert.equal(state.records[0].user.projectId,p.id);
  const view=core.publicItem(state.records[0]);
  assert.deepEqual(view.tags,['调研分析']); assert.equal(view.summary,'My note');assert.equal(view.archived,true);
  assert.equal(view.observations.length,2);assert.equal(view.observations[1].allowAI,false);
});
test('stale facts never overwrite newer activity and unknown time never becomes today', () => {
  const state=core.initial();core.upsert(state,[raw({createdAt:null,createdAtBasis:'unknown'})]);
  core.upsert(state,[raw({title:'Older',summary:'Old',updatedAt:at(1000),createdAt:null})]);
  assert.equal(state.records[0].title,'Original'); assert.equal(state.records[0].createdAt,null);
  assert.equal(core.publicItem({...state.records[0],status:'running',statusLive:false}).status,'unknown');
});
test('AI application and undo do not overwrite subsequent edits', () => {
  const state=core.initial();core.upsert(state,[raw()]);
  state.suggestions=[{id:'suggestion:1',recordId:'session:1',revision:0,observedUpdatedAt:at(2000),patch:{tags:['开发实现']}}];
  const result=core.applySuggestions(state,state.suggestions);
  assert.equal(result.applied,1);assert.deepEqual(state.records[0].user.tags,['开发实现']);
  core.userPatch(state,'session:1',{tags:['方案设计']});
  const undone=core.undo(state);assert.equal(undone.conflicts,1);assert.deepEqual(state.records[0].user.tags,['方案设计']);
});
test('preview conflicts skip changed records and selected new projects appear only at apply', () => {
  const state=core.initial();core.upsert(state,[raw()]);
  state.suggestions=[{id:'s',recordId:'session:1',revision:0,observedUpdatedAt:at(2000),patch:{projectName:'New'}}];
  assert.equal(state.projects.length,0);const result=core.applySuggestions(state,state.suggestions);
  assert.equal(result.applied,1);assert.equal(state.projects[0].name,'New');
  core.undo(state);assert.equal(state.projects.length,0);
  state.suggestions=[{id:'late',recordId:'session:1',revision:state.records[0].user.revision,observedUpdatedAt:at(2000),patch:{tags:['测试排障']}}];
  core.upsert(state,[raw({updatedAt:at(3000)})]);assert.equal(core.applySuggestions(state,state.suggestions).conflicts.length,1);
});
test('standard import validates rows, namespaced IDs and explicit outbound permission', () => {
  const input=[{id:'one',kind:'session',title:'Safe',source:{id:'custom',label:'Custom'}},{id:'two',kind:'web',url:'javascript:alert(1)'},{kind:'session'},{id:'one',kind:'session'}].map(JSON.stringify).join('\n')+'\n{broken';
  const result=core.importRecords('dataset',input);assert.equal(result.records.length,1);assert.equal(result.warnings.length,4);
  assert.equal(result.records[0].id,'import:7:dataset:one');assert.equal(result.records[0].observations[0].allowAI,false);
  assert.equal(result.records[0].createdAt,null);
  assert.equal(core.webUrl('https://user:pass@example.com'), '');
});
test('source identity correction does not create a new conversation',()=>{
  const state=core.initial();core.upsert(state,[raw()]);core.userPatch(state,'session:1',{sourceName:'My compatible app'});
  core.upsert(state,[raw({updatedAt:at(3000)})]);assert.equal(state.records.length,1);
  assert.equal(core.publicItem(state.records[0]).sourceName,'My compatible app');
});

test('task acquisition windows use actual activity, include the boundary, and combine source windows without altering AI permissions', () => {
  const now = Date.parse('2026-09-17T12:00:00Z'), day = 86400000;
  const configs = [{id:'a',historyDays:3},{id:'b',historyDays:7}];
  const r = core.normalizeRecord(raw({updatedAt: now-3*day, observations:[{connectionId:'a',historyDays:30,allowAI:false}]}));
  assert.equal(core.withinHistory(r,configs,now),true);
  r.updatedAt--;
  assert.equal(core.withinHistory(r,configs,now),false);
  r.observations.push({connectionId:'b',allowAI:true,historyDays:7});
  assert.equal(core.withinHistory(r,configs,now),true);
  assert.equal(r.observations[0].allowAI,false);
  r.updatedAt = now-7*day-1;
  assert.equal(core.withinHistory(r,configs,now),false);
  for(const at of [null,now+1]) { r.updatedAt=at;assert.equal(core.withinHistory(r,configs,now),false); }
  r.updatedAt=now-20*day;
  assert.equal(core.withinHistory(r,[{id:'a',historyDays:0}],now),true);
  r.updatedAt=now-31*day;
  assert.equal(core.withinHistory(r,[{id:'a',historyDays:0}],now),false);
  assert.equal(core.withinHistory({...r,kind:'web'},configs,now),true);
});

test('an expired task cannot receive a pending model suggestion even without another source sync', () => {
  const state=core.initial();core.upsert(state,[raw({updatedAt:Date.now()-4*86400000,observations:[{connectionId:'a',allowAI:true,historyDays:3}]})]);
  const record=state.records[0];
  state.suggestions=[{id:'expired',recordId:record.id,revision:0,observedUpdatedAt:record.updatedAt,patch:{tags:['开发实现']}}];
  assert.equal(core.applySuggestions(state,state.suggestions).applied,0);
  assert.deepEqual(record.user.tags,[]);
});

test('legacy local caches keep a default acquisition window while imports remain unrestricted', () => {
  const now = Date.now(), day = 86400000;
  const old = core.normalizeRecord(raw({updatedAt: now - 31 * day}));
  assert.equal(core.historyWindowDays(old), 30);
  assert.equal(core.withinHistory(old, [], now), false);
  assert.equal(core.publicItem(old, now).outsideHistoryRange, true);
  assert.equal(core.publicItem(old, now).historyExpiresAt, old.updatedAt + 30 * day);
  old.updatedAt = now - 4 * day;
  old.observations[0].historyDays = 3;
  assert.equal(core.withinHistory(old, [], now), false);
  assert.equal(core.withinHistory(old, [{id: 'a', historyDays: 7}], now), true);
  old.observations = [];
  assert.equal(core.historyWindowDays(old), 30);
  old.updatedAt = null;
  assert.equal(core.withinHistory(old, [], now), false);
  assert.equal(core.publicItem(old, now).historyExpiresAt, null);
  for (const connectorId of ['standard-import', 'import']) {
    const imported = {...old, connectorId};
    assert.equal(core.historyWindowDays(imported), null);
    assert.equal(core.withinHistory(imported, [], now), true);
    assert.equal(core.publicItem(imported, now).historyExpiresAt, null);
  }
});

test('empty project cleanup preserves undo definitions and ignores archive entries in the undo stack', () => {
  const state=core.initial();core.upsert(state,[raw()]);
  const original=core.saveProject(state,{name:'原项目',color:core.COLORS[2]});
  const destination=core.saveProject(state,{name:'目标项目'});
  const empty=core.saveProject(state,{name:'未使用项目'});
  core.userPatch(state,'session:1',{projectId:original.id});
  state.undo.push({kind:'archive',items:[]});
  const entry=core.userPatch(state,'session:1',{projectId:destination.id});
  core.pushUndo(state,[entry],'移动项目');
  state.suggestions=[{id:'stale-project',patch:{projectId:empty.id}},{id:'other',patch:{tags:['文档整理']}}];
  assert.equal(core.pruneEmptyProjects(state),2);
  assert.deepEqual(state.projects.map(p=>p.id),[destination.id]);
  assert.deepEqual(state.suggestions.map(s=>s.id),['other']);
  assert.deepEqual(state.undo.at(-1).projectBackups,[original]);
  const result=core.undo(state);core.pruneEmptyProjects(state);
  assert.equal(result.restored,1);assert.equal(result.conflicts,0);
  assert.equal(state.records[0].user.projectId,original.id);
  assert.deepEqual(state.projects,[original]);
});

test('undo conflicts preserve later manual edits and do not resurrect a now-empty original project', () => {
  const state=core.initial();core.upsert(state,[raw()]);
  const original=core.saveProject(state,{name:'原项目'}),destination=core.saveProject(state,{name:'目标项目'});
  core.userPatch(state,'session:1',{projectId:original.id});
  const entry=core.userPatch(state,'session:1',{projectId:destination.id});
  core.pushUndo(state,[entry],'移动项目');core.pruneEmptyProjects(state);
  core.userPatch(state,'session:1',{alias:'后来手动命名',tags:['使用咨询']});
  const before=core.copy(state.records[0].user),result=core.undo(state);
  assert.equal(result.restored,0);assert.equal(result.conflicts,1);
  assert.deepEqual(state.records[0].user,before);
  assert.deepEqual(state.projects.map(p=>p.id),[destination.id]);
});

test('source defaults follow stable identity rather than label, order or record title and support old state', () => {
  const first={kind:'session',source:{id:'source:one',label:'原名称',icon:'terminal'}};
  const appearance=core.sourceAppearance({},first);
  assert.equal(core.SOURCE_COLORS.length,8);assert.equal(new Set(core.SOURCE_COLORS).size,8);
  assert.ok(core.SOURCE_COLORS.includes(appearance.color));assert.equal(appearance.icon,'terminal');
  assert.deepEqual(core.sourceAppearance({sourceStyles:{}},{...first,title:'不同标题',source:{...first.source,label:'改过名称'}}),appearance);
  assert.deepEqual(core.sourceAppearance({}, {sourceId:'source:one',sourceIcon:'terminal'}),appearance);
  assert.equal(core.sourceAppearance({}, {sourceId:'other',sourceIcon:'◇'}).icon,'◇');
  for(const icon of ['<svg>',"' onclick=",'http://x','\n'])assert.equal(core.sourceAppearance({}, {kind:'web',sourceIcon:icon}).icon,'web');
});

test('source styles are independently customizable and source refresh cannot change them or record identity and permissions', () => {
  const state=core.initial();core.upsert(state,[raw()]);
  const id=state.records[0].source.id,before=core.copy(state.records[0]);
  core.saveSourceStyle(state,{sourceId:id,icon:'folder',color:'#123ABC'});
  core.saveSourceStyle(state,{sourceId:'separate-source',icon:'folder',color:'#abcdef'});
  assert.deepEqual(state.records[0],before);
  assert.deepEqual(core.sourceAppearance(state,core.publicItem(state.records[0])),{icon:'folder',color:'#123abc'});
  assert.deepEqual(core.sourceAppearance(state,{sourceId:'separate-source'}),{icon:'folder',color:'#abcdef'});
  core.upsert(state,[{...raw(),source:{id,label:'来源已更新',icon:'code'},updatedAt:at(3000)}]);
  assert.deepEqual(core.sourceAppearance(state,core.publicItem(state.records[0])),{icon:'folder',color:'#123abc'});
  core.saveSourceStyle(state,{sourceId:id,icon:'',color:'#123abc'});
  assert.equal(core.sourceAppearance(state,core.publicItem(state.records[0])).icon,'code');
  assert.equal(core.resetSourceStyle(state,id),true);assert.equal(core.resetSourceStyle(state,id),false);
  assert.ok(core.SOURCE_COLORS.includes(core.sourceAppearance(state,core.publicItem(state.records[0])).color));
});

test('source style validation is atomic and rejects unexpected fields, invalid icons and CSS color injection', () => {
  const state=core.initial(),saved={sourceId:'valid-source',icon:'session',color:'#ab12cd'};
  core.saveSourceStyle(state,saved);const before=core.copy(state);
  const invalid=[{...saved,icon:'arbitrary'},{...saved,icon:'<svg>'},{...saved,color:'#abc'},
    {...saved,color:'red'},{...saved,color:'#123456;display:none'},{...saved,color:null},
    {...saved,sourceId:''},{...saved,sourceId:' x '},{...saved,sourceId:'x'.repeat(201)},
    {...saved,allowAI:true},{sourceId:'valid-source',color:'#123456'}];
  for(const input of invalid){assert.throws(()=>core.saveSourceStyle(state,input));assert.deepEqual(state,before);}
  assert.throws(()=>core.resetSourceStyle(state,''));assert.deepEqual(state,before);
  assert.deepEqual(core.sourceAppearance({sourceStyles:{'valid-source':{icon:'code',color:'red'}}},{sourceId:'valid-source'}),core.sourceAppearance({}, {sourceId:'valid-source'}));
});

test('prototype-shaped source IDs remain own data through save, JSON and reset without changing prototypes', () => {
  const state=core.initial();
  for(const sourceId of ['__proto__','constructor','prototype']){
    core.saveSourceStyle(state,{sourceId,icon:'sparkles',color:'#abcdef'});
    assert.equal(Object.prototype.hasOwnProperty.call(state.sourceStyles,sourceId),true);
    assert.deepEqual(core.sourceAppearance(state,{sourceId}),{icon:'sparkles',color:'#abcdef'});
  }
  assert.equal(Object.getPrototypeOf(state.sourceStyles),Object.prototype);
  assert.equal({}.icon,undefined);assert.equal({}.color,undefined);
  const restored=JSON.parse(JSON.stringify(state));
  assert.deepEqual(core.sourceAppearance(restored,{sourceId:'__proto__'}),{icon:'sparkles',color:'#abcdef'});
  assert.equal(core.resetSourceStyle(restored,'__proto__'),true);assert.equal(Object.getPrototypeOf(restored.sourceStyles),Object.prototype);
  const inherited=Object.create({'source-id':{icon:'code',color:'#abcdef'}});
  assert.deepEqual(core.sourceAppearance({sourceStyles:inherited},{sourceId:'source-id'}),core.sourceAppearance({}, {sourceId:'source-id'}));
});

test('data import restores valid source styles by stable identity and reports invalid styles individually', () => {
  const sourceStyles=JSON.parse('{"valid":{"icon":"folder","color":"#ABCDEF"},"__proto__":{"icon":"code","color":"#123456"},"bad-icon":{"icon":"<svg>","color":"#123456"},"bad-color":{"icon":"web","color":"red"},"extra":{"icon":"web","color":"#123456","allowAI":true}}');
  const result=core.importRecords('styles',JSON.stringify({records:[raw()],sourceStyles}));
  assert.equal(result.records.length,1);assert.equal(result.warnings.length,3);
  assert.deepEqual(Object.keys(result.sourceStyles),['valid','__proto__']);
  assert.deepEqual(result.sourceStyles.valid,{icon:'folder',color:'#abcdef'});
  assert.equal(Object.getPrototypeOf(result.sourceStyles),Object.prototype);
  assert.equal(result.records[0].observations[0].allowAI,false);
  const invalidMap=core.importRecords('styles',JSON.stringify({records:[raw()],sourceStyles:[]}));
  assert.deepEqual(invalidMap.sourceStyles,{});assert.match(invalidMap.warnings[0],/来源外观/);
});

test('source appearance stays out of model inputs and source permissions remain unchanged', () => {
  const suggestions=require('../extension/suggestions.js'),state=core.initial();core.upsert(state,[raw()]);
  const before=suggestions.prepare(state.records.map(r=>core.publicItem(r)),{},state.projects);
  const permissions=core.copy(state.records[0].observations);
  core.saveSourceStyle(state,{sourceId:state.records[0].source.id,icon:'sparkles',color:'#ab12cd'});
  assert.deepEqual(suggestions.prepare(state.records.map(r=>core.publicItem(r)),{},state.projects),before);
  assert.deepEqual(state.records[0].observations,permissions);
});

test('type migration prefers existing canonical types, otherwise first explicit alias, and preserves original tags and manual intent',()=>{
  const state=core.initial();
  const examples=[
    {tags:['Workspace','产品设计','测试排障','调研分析'],expected:['测试排障']},
    {tags:['AI Mana','产品设计','竞品分析'],expected:['方案设计']},
    {tags:['Agent Hub','Agent','Claude'],expected:[]},
    {tags:['pRd'],expected:['需求规划']},
    {tags:['文档整理'],expected:['文档整理']}
  ];
  examples.forEach((example,index)=>{const record=core.normalizeRecord({...raw(),id:'migration:'+index});record.user.tags=[...example.tags];record.user.projectId='unchanged-project';record.user.manual.tags=true;record.user.revision=9;state.records.push(record);});
  const first=core.normalizeTypes(state);assert.deepEqual(first,{changed:4,backedUp:4});
  state.records.forEach((record,index)=>{assert.deepEqual(record.user.tags,examples[index].expected);assert.equal(record.user.projectId,'unchanged-project');assert.equal(record.user.manual.tags,true);assert.equal(record.user.revision,index===4?9:10);assert.deepEqual(record.user.legacyTypeTags,index===4?[]:examples[index].tags);});
  const after=structuredClone(state);assert.deepEqual(core.normalizeTypes(state),{changed:0,backedUp:0});assert.deepEqual(state,after);
});

test('single canonical type updates reject arbitrary themes, aliases, duplicates and multiple categories',()=>{
  const state=core.initial();core.upsert(state,[raw()]);
  for(const tags of [['Workspace'],['产品设计'],['调研分析','方案设计'],['调研分析','调研分析'],['__proto__'],[null],'调研分析']) {
    assert.throws(()=>core.userPatch(state,'session:1',{tags}),/主类型/);assert.deepEqual(state.records[0].user.tags,[]);
  }
  core.userPatch(state,'session:1',{tags:['开发实现']});assert.deepEqual(state.records[0].user.tags,['开发实现']);
  core.userPatch(state,'session:1',{tags:[]});assert.deepEqual(state.records[0].user.tags,[]);
});

test('type migration invalidates old model suggestions and preserves an earlier backup',()=>{
  const state=core.initial();core.upsert(state,[raw()]);const record=state.records[0];record.user.tags=['产品设计','Workspace'];record.user.legacyTypeTags=['早期备份'];
  const proposal={id:'pre-migration',recordId:record.id,revision:0,observedUpdatedAt:record.updatedAt,patch:{tags:['调研分析']}};state.suggestions=[proposal];
  core.normalizeTypes(state);const result=core.applySuggestions(state,[proposal]);assert.equal(result.applied,0);assert.deepEqual(record.user.tags,['方案设计']);assert.deepEqual(record.user.legacyTypeTags,['早期备份']);
});

test('legacy import maps only explicit types and keeps complete legacy backups independently of projects',()=>{
  const parsed=core.importRecords('type-fixture',JSON.stringify({projects:[{id:'one',name:'原项目'}],records:[{id:'first',kind:'session',title:'虚构任务',user:{projectId:'one',tags:['Agent','知识库梳理','产品调研'],manual:{tags:true}}},{id:'second',kind:'session',title:'虚构任务二',user:{tags:['AI Mana','Workspace'],legacyTypeTags:['原有完整备份']}}]}));
  assert.deepEqual(parsed.records[0].importUser.tags,['文档整理']);assert.deepEqual(parsed.records[0].importUser.legacyTypeTags,['Agent','知识库梳理','产品调研']);assert.equal(parsed.records[0].importUser.manual.tags,true);assert.ok(parsed.records[0].importUser.projectId);
  assert.deepEqual(parsed.records[1].importUser.tags,[]);assert.deepEqual(parsed.records[1].importUser.legacyTypeTags,['原有完整备份']);
});

test('progress suggestions cannot be replaced with classification fields or override denied/manual summaries',()=>{
  const setup=()=>{const state=core.initial();core.upsert(state,[raw()]);const record=state.records[0];record.observations.forEach(o=>o.includeSummary=true);const proposal={id:'progress',kind:'progress',recordId:record.id,revision:0,observedUpdatedAt:record.updatedAt,patch:{summary:'新的近况'}};state.suggestions=[proposal];return {state,record,proposal};};
  for(const patch of [{tags:['开发实现']},{summary:'近况',projectName:'新项目'},{summary:12},{}]) {const {state,record,proposal}=setup();assert.throws(()=>core.applySuggestions(state,[{...proposal,patch}]),/只能修改一句近况/);assert.equal(record.user.summaryOverride,null);}
  for(const condition of ['permission','manual','web']){const {state,record,proposal}=setup();if(condition==='permission')record.observations[0].includeSummary=false;if(condition==='manual')record.user.manual.summary=true;if(condition==='web')record.kind='web';const result=core.applySuggestions(state,[proposal]);assert.equal(result.applied,0);assert.deepEqual(result.conflicts,[record.id]);assert.equal(record.user.summaryOverride,null);}
  const {state,record,proposal}=setup();const result=core.applySuggestions(state,[proposal]);assert.equal(result.applied,1);assert.equal(record.user.summaryOverride,'新的近况');
});

test('undo from a pre-migration history cannot restore unsupported types or overwrite a preserved backup',()=>{
  for(const backup of [[],['更早的备份']]){
    const state=core.initial();core.upsert(state,[raw()]);const record=state.records[0];
    const before={...core.defaultUser(),tags:['Workspace','产品设计'],legacyTypeTags:[...backup],revision:0};
    record.user={...core.defaultUser(),tags:['方案设计'],revision:1};state.undo=[{entries:[{id:record.id,before,after:structuredClone(record.user)}],projects:[]}];
    assert.deepEqual(core.normalizeTypes(state),{changed:0,backedUp:0});
    const undone=core.undo(state);assert.equal(undone.restored,1);assert.equal(record.user.revision,2);assert.deepEqual(record.user.tags,['方案设计']);assert.deepEqual(record.user.legacyTypeTags,backup.length?backup:['Workspace','产品设计']);
  }
});
