'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const C=require('../extension/core.js');
const S=require('../extension/suggestions.js');
const clone=v=>structuredClone(v);
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>clone(data)});
async function app(options={}) {
  let disk=clone(options.initial||C.initial());
  const local=clone(options.local||{taskOutModel:{autoOrganize:false}}),session={};
  const handlers={},requests=[];
  const event=name=>({addListener:fn=>{handlers[name]=fn;}});
  const storage=data=>({get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,clone(data[k])])),set:async v=>Object.assign(data,clone(v)),setAccessLevel:async()=>{}});
  const fetchImpl=async(url,init)=>{requests.push({path:new URL(url).pathname,body:init.body&&JSON.parse(init.body)});return options.fetch?options.fetch(url,init):response({});};
  const ctx={console,URL,crypto,structuredClone,DOMException,AbortController,AbortSignal,importScripts(){},setTimeout:()=>1,clearTimeout(){},
    TaskOutCore:C,TaskOutModelLifetime:require('../extension/model-lifetime.js'),TaskOutSuggestions:S,TaskOutStore:{read:async()=>clone(disk),write:async value=>{disk=clone(value);}},fetch:fetchImpl,
    chrome:{storage:{local:storage(local),session:storage(session)},permissions:{contains:async()=>options.permission!==false},
      runtime:{id:'a'.repeat(32),getURL:p=>'chrome-extension://'+'a'.repeat(32)+'/'+p,sendMessage:async()=>{},onMessage:event('message'),onStartup:event('startup'),onInstalled:event('installed')},
      tabs:{query:async()=>[],onCreated:event('created'),onUpdated:event('updated'),onRemoved:event('removed'),onActivated:event('activated')},windows:{onFocusChanged:event('focus')},alarms:{create(){},onAlarm:event('alarm')},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}}};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync('extension/background.js','utf8')+'\nthis.test={dispatch,ready};',ctx);await ctx.test.ready;
  return {call:(action,extra={})=>ctx.test.dispatch({action,...extra}),disk:()=>clone(disk),local:()=>clone(local),requests,
    message:action=>new Promise(resolve=>handlers.message({type:'task-out',...action},{id:'a'.repeat(32),url:'chrome-extension://'+'a'.repeat(32)+'/index.html'},resolve))};
}
const connector={id:'fixture',configFields:[{key:'metadataRoot',type:'path'},{key:'alternateRoot',type:'path'},{key:'apiKey',type:'text'}]};

test('onboarding draft resumes after a worker restart without storing pairing codes, tokens, previews or model keys',async()=>{
  const initial=C.initial();initial.connectors=[connector];
  const x=await app({initial});
  const draft={connectorId:'fixture',name:'虚构来源',root:'/fixture/logs',metadataRoot:'/fixture/names',alternateRoot:'/fixture/other',historyDays:7,allowAI:false,includeNaming:false,
    identity:{id:'fixture-client',label:'自定义客户端',icon:'message',token:'DONT_SAVE'},code:'DONT_SAVE',pairingCode:'DONT_SAVE',apiKey:'DONT_SAVE',token:'DONT_SAVE',preview:{records:['DONT_SAVE']}};
  await x.call('onboarding-save',{step:'preview',draft});
  const saved=x.disk().onboarding;assert.equal(saved.step,'preview');assert.equal(saved.draft.metadataRoot,'/fixture/names');assert.equal(saved.draft.alternateRoot,'/fixture/other');assert.equal(saved.draft.identity.label,'自定义客户端');assert.doesNotMatch(JSON.stringify(saved),/DONT_SAVE/);
  const y=await app({initial:x.disk(),local:x.local()});assert.deepEqual((await y.call('snapshot')).state.onboarding,saved);
  await assert.rejects(()=>y.call('onboarding-save',{step:'invented'}),/步骤/);assert.deepEqual(y.disk().onboarding,saved);
  const exported=await y.call('export');assert.equal(exported.data.onboarding,undefined);
});

test('successful pairing remains saved if the subsequent source read fails and advances to discovery',async()=>{
  const x=await app({fetch:async url=>{
    if(new URL(url).pathname==='/pair')return response({token:'synthetic-token'});
    throw new TypeError('Failed to fetch');
  }});
  const result=await x.call('pair',{url:'http://127.0.0.1:4518',code:'12345678'});
  assert.equal(result.paired,true);assert.equal(result.code,'SERVICE_OFFLINE');assert.match(result.warning,/启动/);
  assert.equal(x.local().taskOutBridge.token,'synthetic-token');assert.equal(x.disk().bridge.paired,true);assert.equal(x.disk().onboarding.step,'discover');
  assert.doesNotMatch(JSON.stringify(x.disk()),/synthetic-token|12345678/);
});

test('pair error codes and actionable messages survive the extension message boundary',async()=>{
  for(const code of ['PAIR_CODE_INVALID','PAIR_CODE_EXPIRED','PAIR_CODE_USED']){
    const x=await app({fetch:async()=>response({code,error:'请重新运行启动脚本，复制有效配对码。'},400)});
    const result=await x.message({action:'pair',url:'http://127.0.0.1:4518',code:'00000000'});
    assert.equal(result.ok,false);assert.equal(result.code,code);assert.match(result.error,/复制/);assert.equal(x.local().taskOutBridge,undefined);
  }
});

test('browser permission denial is distinct from service offline and sends no network request',async()=>{
  const x=await app({permission:false});
  const result=await x.message({action:'pair',url:'http://127.0.0.1:4518',code:'12345678'});
  assert.equal(result.code,'BROWSER_PERMISSION_DENIED');assert.match(result.error,/Chrome.*允许/);assert.equal(x.requests.length,0);
});

test('an expired connection reports re-pairing while retaining cached records and manual edits',async()=>{
  const initial=C.initial();initial.bridge.paired=true;
  const record=C.normalizeRecord({id:'fixture',kind:'session',title:'原会话',updatedAt:Date.now()});record.user.alias='人工名称';initial.records.push(record);
  const x=await app({initial,local:{taskOutBridge:{url:'http://127.0.0.1:4518',token:'old-token'}},fetch:async url=>new URL(url).pathname==='/health'?response({name:'Task Out',state:'running',mode:'background'}):response({code:'CONNECTION_EXPIRED',error:'连接已失效，请重新配对。'},401)});
  const result=await x.call('service-status');assert.equal(result.service.paired,false);assert.equal(result.service.code,'CONNECTION_EXPIRED');assert.equal(x.disk().bridge.paired,false);assert.equal(x.disk().records[0].user.alias,'人工名称');
});

test('native directory picker is proxied only after pairing and keeps a cancelled choice harmless',async()=>{
  const x=await app({local:{taskOutBridge:{url:'http://127.0.0.1:4518',token:'fixture-token'}},fetch:async url=>response(new URL(url).pathname==='/v1/directories/select'?{path:'',cancelled:true}:{connections:[],connectors:[connector]})});
  const result=await x.call('service',{method:'POST',path:'/v1/directories/select',body:{}});assert.equal(result.cancelled,true);assert.equal(result.path,'');
  const y=await app();await assert.rejects(()=>y.call('service',{method:'POST',path:'/v1/directories/select',body:{}}),e=>e.code==='PAIR_REQUIRED');assert.equal(y.requests.length,0);
});

test('an enabled source stays saved when the subsequent sync fails so retry does not create a duplicate source',async()=>{
  const connection={id:'new-source',connectorId:'fixture',root:'/fixture/logs',historyDays:3,enabled:true,allowAI:false};
  const x=await app({local:{taskOutBridge:{url:'http://127.0.0.1:4518',token:'fixture-token'}},fetch:async(url,init)=>{
    const path=new URL(url).pathname;
    if(path==='/v1/connections'&&init.method==='POST')return response({connection},201);
    if(path==='/v1/sync')throw new TypeError('Failed to fetch');
    return response(path==='/v1/connectors'?{connectors:[connector]}:{connections:[connection]});
  }});
  await x.call('onboarding-save',{step:'preview',draft:{connectorId:'fixture',root:'/fixture/logs'}});
  const result=await x.call('service',{method:'POST',path:'/v1/connections',body:connection});
  assert.equal(result.connection.id,connection.id);assert.equal(result.code,'SERVICE_OFFLINE');assert.match(result.message,/已保存/);
  assert.equal(x.disk().connections.length,1);assert.equal(x.disk().onboarding.step,'done');assert.equal(x.disk().onboarding.draft,null);
});

test('a completed source save cannot erase a newer onboarding draft',async()=>{
  let release,started;
  const gate=new Promise(r=>{release=r;}),start=new Promise(r=>{started=r;});
  const connection={id:'first',connectorId:'fixture',root:'/fixture/first',name:'第一来源',enabled:true,historyDays:3};
  const x=await app({local:{taskOutBridge:{url:'http://127.0.0.1:4518',token:'fixture-token'}},fetch:async(url,init)=>{
    const route=new URL(url).pathname;
    if(route==='/v1/connections'&&init.method==='POST'){started();await gate;return response({connection},201);}
    return response(route==='/v1/connectors'?{connectors:[connector]}:{connections:[connection],records:[]});
  }});
  await x.call('onboarding-save',{step:'enable',draft:connection});
  const saving=x.call('service',{method:'POST',path:'/v1/connections',body:connection});await start;
  const nextDraft={connectorId:'fixture',root:'/fixture/second',name:'第二来源',historyDays:7};
  await x.call('onboarding-save',{step:'preview',draft:nextDraft});release();await saving;
  assert.equal(x.disk().connections[0].id,'first');assert.deepEqual(x.disk().onboarding,{step:'preview',draft:nextDraft});
});
