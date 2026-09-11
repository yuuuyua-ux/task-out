const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
test('new pages debounce classification; activation only updates recency',async()=>{
 const handlers={};const event=k=>({addListener:fn=>handlers[k]=fn});let calls=0;let task;const state={};
 const context={URL,AbortController,Date,console,setTimeout:fn=>{task=fn;return 1},clearTimeout:()=>{},TabOutAI:{config:async()=>({apiKey:'fake'}),run:async()=>{calls++;return 1},setMode:async()=>{}},chrome:{storage:{local:{get:async()=>({})},session:{get:async()=>state,set:async x=>Object.assign(state,x)}},alarms:{create:async()=>{},clear:async()=>{},onAlarm:event('alarm')},tabs:{query:async()=>[{id:1,url:'https://example.com'}],get:async id=>({id,url:'https://example.com'}),onCreated:event('created'),onUpdated:event('updated'),onActivated:event('activated')},windows:{onFocusChanged:event('focus')},runtime:{onMessage:event('message'),onStartup:event('startup'),onInstalled:event('installed')}}};
 vm.createContext(context);vm.runInContext(fs.readFileSync('extension/auto.js','utf8'),context);
 handlers.activated({tabId:1});await new Promise(r=>setImmediate(r));assert.ok(state.tabRecency[1]);assert.equal(calls,0);
 handlers.created({url:'chrome://newtab/'});assert.equal(task,undefined);
 handlers.created({url:'https://example.com'});assert.equal(calls,0);await task();assert.equal(calls,1);
});
