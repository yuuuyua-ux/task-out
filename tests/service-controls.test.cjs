const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const Core = require('../extension/core.js');
const Suggestions = require('../extension/suggestions.js');
const clone = value => structuredClone(value);
const response = (value,status=200) => ({ok:status===200,status,json:async()=>clone(value)});
async function background(fetchImpl, paired=true) {
  let disk = Core.initial(); disk.bridge.paired=paired;
  disk.records=[Core.normalizeRecord({id:'fixture',kind:'session',title:'示例任务',updatedAt:Date.now()})];
  disk.records[0].user.alias='固定名称';
  const local={taskOutBridge:{url:'http://127.0.0.1:4518',...(paired?{token:'fixture-token'}:{})},taskOutModel:{baseUrl:'',model:'',autoOrganize:false}}, session={};
  const storage=data=>({get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,clone(data[k])])),set:async value=>Object.assign(data,clone(value)),setAccessLevel:async()=>{}});
  const event=()=>({addListener(){}});
  const context={console,URL,crypto,structuredClone,AbortController,AbortSignal,DOMException,setTimeout:()=>0,clearTimeout(){},
    TaskOutCore:Core,TaskOutModelLifetime:require('../extension/model-lifetime.js'),TaskOutSuggestions:Suggestions,TaskOutStore:{read:async()=>clone(disk),write:async value=>{disk=clone(value);}},
    importScripts(){},fetch:fetchImpl,chrome:{storage:{local:storage(local),session:storage(session)},permissions:{contains:async()=>true},
      runtime:{id:'a'.repeat(32),sendMessage:async()=>{},getURL:p=>'chrome-extension://fixture/'+p,onMessage:event(),onStartup:event(),onInstalled:event()},
      tabs:{query:async()=>[],onCreated:event(),onUpdated:event(),onRemoved:event(),onActivated:event()},windows:{onFocusChanged:event()},
      action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},alarms:{create(){},onAlarm:event()}}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('extension/background.js','utf8')+'\nglobalThis.fixture={dispatch,ready};',context);
  await context.fixture.ready;
  return {dispatch:context.fixture.dispatch,disk:()=>clone(disk),local:()=>clone(local)};
}

test('offline service status shows a startup instruction instead of raw Failed to fetch',async()=>{
  const app=await background(async()=>{throw new TypeError('Failed to fetch');});
  const result=await app.dispatch({action:'service-status'});
  assert.equal(result.service.state,'offline'); assert.equal(result.service.canStop,false);
  assert.match(result.service.message,/Start Task Out.command/); assert.doesNotMatch(result.service.message,/Failed to fetch/);
  assert.match(result.service.message,/无法连接本机服务/);
  assert.doesNotMatch(result.service.message,/本机服务已停止/);
  assert.equal(app.disk().records[0].user.alias,'固定名称');
});

test('refreshing status after an explicit stop reports a normal stopped state with restart guidance',async()=>{
  const app=await background(async url=>{
    if(new URL(url).pathname==='/v1/service/stop')return response({state:'stopping'});
    throw new TypeError('Failed to fetch');
  });
  const stopped=await app.dispatch({action:'service-stop'});
  assert.equal(stopped.service.state,'stopped');
  assert.match(stopped.service.message,/本机服务已停止/);
  const refreshed=await app.dispatch({action:'service-status'});
  assert.equal(refreshed.service.state,'stopped');
  assert.equal(refreshed.service.canStop,false);
  assert.match(refreshed.service.message,/Start Task Out.command.*重新启动/);
  assert.doesNotMatch(refreshed.service.message,/无法连接|Failed to fetch/);
  assert.equal(app.disk().bridge.status,'已停止');
  assert.equal(app.disk().records[0].user.alias,'固定名称');
  assert.equal(app.local().taskOutBridge.token,'fixture-token');
});

test('a prior explicit stop does not conceal a wrong service, malformed health or HTTP authorization error',async()=>{
  const failures=[
    {health:async()=>response({name:'Other Service',state:'running'}),message:/没有运行 Task Out 服务/},
    {health:async()=>({ok:true,status:200,json:async()=>{throw new SyntaxError('invalid JSON');}}),message:/无效响应/},
    {health:async()=>response({error:'Health access denied'},401),message:/Health access denied/}
  ];
  for(const failure of failures){
    let healthAvailable=false;
    const app=await background(async url=>{
      const pathname=new URL(url).pathname;
      if(pathname==='/v1/service/stop')return response({state:'stopping'});
      if(pathname==='/health'&&healthAvailable)return failure.health();
      throw new TypeError('Failed to fetch');
    });
    await app.dispatch({action:'service-stop'});
    assert.equal(app.disk().bridge.stoppedByUser,true);
    healthAvailable=true;
    const result=await app.dispatch({action:'service-status'});
    assert.equal(result.service.state,'offline');
    assert.equal(result.service.canStop,false);
    assert.match(result.service.message,failure.message);
    assert.doesNotMatch(result.service.message,/本机服务已停止/);
    assert.equal(app.disk().bridge.serviceState,'offline');
    assert.notEqual(app.disk().bridge.status,'已停止');
  }
});

test('unpaired status can check public health without sending an undefined token; stopping still requires pairing',async()=>{
  const app=await background(async(url,init)=>{
    assert.equal(new URL(url).pathname,'/health'); assert.equal(init.headers.Authorization,undefined);
    return response({name:'Task Out',state:'running',mode:'background'});
  },false);
  assert.equal((await app.dispatch({action:'service-status'})).service.canStop,false);
  await assert.rejects(()=>app.dispatch({action:'service-stop'}),/先配对/);
});

test('stopping preserves credentials and records, and delayed sync cannot resurrect running status',async()=>{
  let started, resolveSync, running=true;
  const ready=new Promise(resolve=>{started=resolve;}), delayed=new Promise(resolve=>{resolveSync=resolve;});
  const paths=[];
  const app=await background(async url=>{
    const pathname=new URL(url).pathname; paths.push(pathname);
    if(pathname==='/v1/connectors')return response({connectors:[]});
    if(pathname==='/v1/sync'){started();return delayed;}
    if(pathname==='/v1/service/stop'){running=false;return response({state:'stopping'});}
    if(pathname==='/health'&&!running)throw new TypeError('Failed to fetch');
    throw Error('Unexpected request');
  });
  const sync=app.dispatch({action:'refresh'}); await ready;
  const stop=await app.dispatch({action:'service-stop'}); assert.equal(stop.service.state,'stopped');
  resolveSync(response({records:[],connections:[]})); await sync;
  assert.equal(app.disk().bridge.status,'已停止');
  assert.equal(app.disk().bridge.paired,true); assert.equal(app.local().taskOutBridge.token,'fixture-token');
  assert.equal(app.disk().records[0].user.alias,'固定名称');
  assert.deepEqual(paths.slice(paths.indexOf('/v1/service/stop')),['/v1/service/stop','/health']);
});

function dashboard(serviceState) {
  const nodes=new Map(), requests=[];
  const node=key=>{
    if(!nodes.has(key))nodes.set(key,{value:'',innerHTML:'',textContent:'',dataset:{},classList:{toggle(){},add(){},remove(){}},
      querySelector:node,querySelectorAll:()=>[],addEventListener(){},showModal(){this.open=true;},close(){this.open=false;}});
    return nodes.get(key);
  };
  const snapshot={...Core.initial(),items:[],model:{},bridge:{url:'http://127.0.0.1:4518',paired:true}};
  const context={URL,crypto,structuredClone,TaskOutCore:Core,setTimeout:()=>0,clearTimeout(){},document:{querySelector:node,querySelectorAll:()=>[],addEventListener(){}},
    chrome:{runtime:{id:'fixture',onMessage:{addListener(){}},sendMessage:async request=>{
      requests.push(request);
      if(request.action==='service-status')return {service:serviceState};
      if(request.action==='service-stop'){serviceState={state:'stopped',canStop:false};return {message:'已停止'};}
      if(request.action==='snapshot')return {state:snapshot};
      if(request.path==='/v1/connectors')return {connectors:[]};
      if(request.path==='/v1/connections')return {connections:[]};
      throw Error('Unexpected request');
    }}}};
  vm.createContext(context);
  const code=fs.readFileSync('extension/dashboard.js','utf8').replace('  refreshSnapshot();\n})();',
    '  globalThis.fixture={showConnections,handleAction,setState(value){state=value;}};\n})();');
  vm.runInContext(code,context);context.fixture.setState(snapshot);
  return {...context.fixture,node,requests};
}

test('connection panel shows live background state and exposes stop only while authorized and running',async()=>{
  const app=dashboard({state:'running',mode:'background',canStop:true});await app.showConnections();
  assert.match(app.node('#service-status-panel').innerHTML,/后台运行/);
  assert.match(app.node('#service-status-panel').innerHTML,/data-action="service-stop"/);
  await app.handleAction('service-stop',{dataset:{}});
  assert.match(app.node('#service-status-panel').innerHTML,/已停止/);
  assert.doesNotMatch(app.node('#service-status-panel').innerHTML,/data-action="service-stop"/);
  assert.equal(app.requests.filter(r=>r.action==='service-stop').length,1);
});

test('offline connection panel retains saved context without trying private connection endpoints',async()=>{
  const app=dashboard({state:'offline',canStop:false,message:'请启动本机服务'});await app.showConnections();
  assert.match(app.node('#service-status-panel').innerHTML,/如何启动或重新启动/);
  assert.doesNotMatch(app.node('#service-status-panel').innerHTML,/data-action="service-stop"/);
  assert.deepEqual(app.requests.map(r=>r.action),['service-status']);
});
