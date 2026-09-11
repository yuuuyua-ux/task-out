const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup() {
  const handlers = {}, calls = [], groups = [{domain:'old',label:'原组'}, {domain:'taken',label:'新分组'}];
  const classes = {add(){},remove(){}};
  const body = {classList:classes};
  const card = {dataset:{dropGroup:'old'},classList:classes};
  const chip = {dataset:{tabId:'42'},classList:classes,closest:s=>s==='[data-drop-group]' ? card : null};
  const source = {closest:s=>s==='.page-chip[data-tab-id]' ? chip : null};
  const blank = {closest:s=>s==='body' ? body : null};
  const target = {dataset:{dropGroup:'target'},classList:classes};
  const existing = {closest:s=>s==='[data-drop-group]' || s.startsWith('.mission-card') ? target : null};
  const same = {closest:s=>s==='[data-drop-group]' || s.startsWith('.mission-card') ? card : null};
  const control = {closest:s=>s.startsWith('.mission-card') ? {} : s==='body' ? body : null};
  const context = {Date,Set,Number,window:{},TabOutAI:{mode:'topic'},document:{body,querySelectorAll:()=>[],addEventListener:(name,fn)=>handlers[name]=fn},chrome:{storage:{session:{get:async()=>({aiView:{groups:[...groups]}})}},runtime:{sendMessage:async msg=>{calls.push(msg.action);if(msg.action.kind==='create')groups.push({domain:'new-id',label:msg.action.name});return {ok:true};}}},renderDashboard:async()=>{},showToast:()=>{}};
  vm.runInNewContext(fs.readFileSync('extension/drag-groups.js','utf8'),context);
  const event = target=>({target,preventDefault(){},dataTransfer:{setData(){}}});
  return {handlers,calls,context,source,blank,existing,same,control,event};
}
test('blank drop creates uniquely named group then moves the tab',async()=>{
  const x=setup();x.handlers.dragstart(x.event(x.source));
  assert.equal(x.context.window.TabOutDragActive,true);
  await x.handlers.drop(x.event(x.blank));
  assert.deepEqual(JSON.parse(JSON.stringify(x.calls)),[{kind:'create',name:'新分组 2'},{kind:'move',tabId:42,group:'new-id'}]);
  assert.equal(x.context.window.TabOutDragActive,false);
});
test('existing theme receives tab without creating a group',async()=>{
  const x=setup();x.handlers.dragstart(x.event(x.source));await x.handlers.drop(x.event(x.existing));
  assert.equal(x.calls.length,1);assert.equal(x.calls[0].group,'target');
});
test('same group, controls and external drags do not create groups',async()=>{
  for(const name of ['same','control']) {const x=setup();x.handlers.dragstart(x.event(x.source));await x.handlers.drop(x.event(x[name]));assert.equal(x.calls.length,0);}
  const x=setup();await x.handlers.drop(x.event(x.blank));assert.equal(x.calls.length,0);
});
