const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Core = require('../extension/core.js');

function dashboard(model) {
  const nodes = new Map(), requests = [], permissions = [];
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {value:'', checked:false, innerHTML:'', open:false,
      addEventListener(){}, querySelector:node, querySelectorAll:()=>[],
      showModal(){this.open=true;}, close(){this.open=false;}});
    return nodes.get(selector);
  };
  const context = {URL, crypto, structuredClone, setTimeout, clearTimeout, TaskOutCore:Core,
    document:{querySelector:node,querySelectorAll:()=>[],addEventListener(){}},
    chrome:{runtime:{id:'fixture-extension',sendMessage:async()=>({}),onMessage:{addListener(){}}},
      permissions:{request:async value=>{permissions.push(value);return true;}}}
  };
  vm.createContext(context);
  const code = fs.readFileSync('extension/dashboard.js','utf8').replace('  refreshSnapshot();\n})();',
    '  globalThis.fixture={showModel,saveModel,handleAction,setModel(value){state.model=value;},setSave(fn){mutate=fn;}};\n})();');
  vm.runInContext(code,context);
  context.fixture.setModel(model);
  context.fixture.setSave(async(action,fields)=>{requests.push({action,fields});return {};});
  context.fixture.showModel();
  node('#model-auto').checked=/<input id="model-auto"[^>]*\bchecked\b/.test(node('#dialog').innerHTML);
  return {api:context.fixture,node,requests,permissions};
}

const saved = {baseUrl:'https://model.example/v1',model:'fixture-model',rules:'保留偏好',hasKey:true,autoOrganize:false};

test('model form accepts empty saved fields and sends a partial update without a key deletion',async()=>{
  const app=dashboard(saved);
  const html=app.node('#dialog').innerHTML;
  for(const id of ['model-base','model-name']) assert.doesNotMatch(html.match(new RegExp('<input id="'+id+'"[^>]*>'))[0],/\brequired\b/);
  for(const id of ['model-base','model-name','model-key','model-rules'])app.node('#'+id).value='  ';
  await app.api.saveModel();
  assert.deepEqual(JSON.parse(JSON.stringify(app.requests)),[{action:'model-save',fields:{autoOrganize:false}}]);
  assert.equal(app.permissions[0].origins[0],'https://model.example/*');
});

test('changing the service URL does not imply clearing the key; only the explicit action does',async()=>{
  const app=dashboard(saved);
  app.node('#model-base').value='http://localhost:8080/v1';
  await app.api.saveModel();
  assert.equal(app.requests[0].fields.baseUrl,'http://localhost:8080/v1');
  assert.equal(app.requests[0].fields.forgetKey,undefined);
  await app.api.handleAction('model-forget',{dataset:{}});
  await app.api.saveModel();
  assert.equal(app.requests[1].fields.forgetKey,true);
});

test('the first model setup still requires a service and model before saving',async()=>{
  const app=dashboard({baseUrl:'',model:'',rules:'',hasKey:false,autoOrganize:true});
  await assert.rejects(app.api.saveModel(),/首次配置/);
  assert.equal(app.requests.length,0);
  assert.equal(app.permissions.length,0);
});

test('automatic organization defaults on, saves its new setting and preserves an explicit pause',async()=>{
  const {autoOrganize,...legacy}=saved,app=dashboard(legacy);
  assert.equal(app.node('#model-auto').checked,true);
  assert.match(app.node('#dialog').innerHTML,/新会话归类一次并补全缺失名称，已有会话只更新进展/);
  assert.doesNotMatch(app.node('#dialog').innerHTML,/待确认建议，不自动应用/);
  await app.api.saveModel();
  assert.equal(app.requests[0].fields.autoOrganize,true);
  assert.equal(Object.hasOwn(app.requests[0].fields,'autoSuggest'),false);
  const paused=dashboard(saved);
  assert.equal(paused.node('#model-auto').checked,false);
  await paused.api.saveModel();
  assert.equal(paused.requests[0].fields.autoOrganize,false);
});
