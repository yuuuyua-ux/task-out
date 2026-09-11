const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const tabs = [{id:10,url:'https://example.com/a',title:'A'},{id:20,url:'https://example.com/b',title:'B'}];
function setup(reply, status=200) {
 const local={llmConfig:{apiKey:'fake-key',model:'test'}}; const session={}; let sent;
 const context={URL,DOMException,chrome:{tabs:{query:async()=>tabs,get:async id=>tabs.find(t=>t.id===id)},storage:{local:{get:async()=>local,set:async x=>Object.assign(local,x)},session:{get:async()=>session,set:async x=>Object.assign(session,x)}},permissions:{contains:async()=>true}},fetch:async(url,options)=>{sent={url,options};return {ok:status===200,status,json:async()=>reply}}};
 vm.createContext(context); vm.runInContext(fs.readFileSync('extension/ai.js','utf8')+'\nthis.api=TabOutAI;',context);
 return {api:context.api,session,get sent(){return sent}};
}
test('valid request uses configured gateway and a reasoning-compatible budget; saves only session groups',async()=>{
 const x=setup({choices:[{finish_reason:'stop',message:{content:JSON.stringify({groups:[{name:'主题',tabIds:[1,2]}]})}}]});
 assert.equal(await x.api.run(tabs,new AbortController().signal),1);
 assert.equal(x.sent.url,'https://api.stepfun.com/step_plan/v1/chat/completions');
 assert.equal(JSON.parse(x.sent.options.body).max_tokens,8192);
 assert.equal(x.session.aiView.groups[0].members[0].id,10);
 const changed=[tabs[0],{...tabs[1],url:'https://example.com/changed'},{id:30,url:'https://new.example',title:'new'}];
 const view=await x.api.project(changed,[]);
 assert.equal(view[0].tabs.length,1); assert.equal(view[1].label,'待整理'); assert.equal(view[1].tabs.length,2);
 await x.api.setMode('domain'); assert.equal((await x.api.project(changed,['fallback']))[0],'fallback');
});
test('invalid and incomplete model memberships never become actionable groups',()=>{
 const {api}=setup({});
 for(const ids of [[1],[1,1,2],[1,2,9],['1',2]]) assert.throws(()=>api.parse(JSON.stringify({groups:[{name:'x',tabIds:ids}]}),tabs));
 assert.throws(()=>api.parse('not json',tabs));
 assert.equal(api.escape('<img onerror="x">'),'&lt;img onerror=&quot;x&quot;&gt;');
 assert.throws(()=>api.endpoint('http://example.com'));
 assert.throws(()=>api.endpoint('https://key@example.com'));
});
test('empty, truncated, unauthenticated and cancelled requests do not persist results',async()=>{
 for(const [reply,status] of [[{choices:[{message:{content:''}}]},200],[{choices:[{finish_reason:'length',message:{content:'{}'}}]},200],[{},401]]) {
  const x=setup(reply,status); await assert.rejects(()=>x.api.run(tabs,new AbortController().signal)); assert.equal(x.session.aiView,undefined);
 }
 const x=setup({choices:[{message:{content:'{"groups":[{"name":"x","tabIds":[1,2]}]}'}}]});
 const c=new AbortController();c.abort(); await assert.rejects(()=>x.api.run(tabs,c.signal));assert.equal(x.session.aiView,undefined);
});

test('incremental classification preserves renamed groups and manual ownership',async()=>{
 const x=setup({choices:[{message:{content:'{"groups":[{"name":"Existing","tabIds":[1]}]}'}}]});
 x.session.aiView={groups:[{domain:'keep',label:'Existing',members:[{id:10,url:'old-url',manual:true}]}],mode:'topic',revision:1};
 await x.api.run(tabs,new AbortController().signal);
 assert.equal(JSON.parse(x.sent.options.body).messages[1].content.includes('"id":2'),false);
 assert.equal(x.session.aiView.groups.length,1);
 assert.equal(x.session.aiView.groups[0].domain,'keep');
 assert.equal(x.session.aiView.groups[0].members.length,2);
 await x.api.edit({kind:'rename',group:'keep',name:'Renamed'});
 assert.equal(x.session.aiView.groups[0].label,'Renamed');
 await x.api.edit({kind:'create',name:'Manual'});
 const target=x.session.aiView.groups[1].domain;
 await x.api.edit({kind:'move',group:target,tabId:20});
 assert.equal(x.session.aiView.groups[1].members[0].manual,true);
 await assert.rejects(()=>x.api.edit({kind:'delete',group:target}));
});

test('deleting an empty group persists across a fresh page projection; occupied groups are protected', async()=>{
 const x=setup({});
 x.session.aiView={groups:[{domain:'empty',label:'空组',members:[{id:99,url:'https://closed.example'}]},{domain:'occupied',label:'使用中',members:[{id:10,url:tabs[0].url}]}],mode:'topic',revision:7};
 await x.api.edit({kind:'delete',group:'empty'});
 assert.equal(x.session.aiView.revision,8);
 assert.equal(x.session.aiView.groups.some(g=>g.domain==='empty'),false);
 const ctx={URL,chrome:{storage:{session:{get:async()=>x.session}}}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('extension/ai.js','utf8')+'\nthis.api=TabOutAI;',ctx);
 const projected=await ctx.api.project(tabs,[]);
 assert.equal(projected.some(g=>g.domain==='empty'),false);
 assert.equal(projected.some(g=>g.domain==='occupied'),true);
 await assert.rejects(()=>x.api.edit({kind:'delete',group:'occupied'}));
});
