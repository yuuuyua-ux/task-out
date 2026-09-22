const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Core = require('../extension/core.js');

const NOW = Date.parse('2026-09-17T12:00:00Z');

test('invalid grounding is explained as rejected model evidence rather than an unknown outage', async()=>{
  const app=dashboard({...fixture(),model:{baseUrl:'https://model.example/v1',model:'fixture'},organization:{status:'error',message:'分组建议缺少可核对的输入依据，当前批次未应用。'}});
  await app.refresh();
  assert.match(app.node('#organization-status').innerHTML,/模型归组依据缺失或无法核对/);
  await app.action('settings');
  assert.match(app.node('#dialog').innerHTML,/这一批未应用/);
});
const daysAgo = days => NOW - days * 86400000;
class FixtureDate extends Date {
  constructor(...values) { super(...(values.length ? values : [NOW])); }
  static now() { return NOW; }
}
function dashboard(snapshot,reply,{preview=false,effects}={}) {
  const nodes = new Map(), handlers = new Map(), requests = [];
  let current = snapshot;
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {id:selector.slice(1),value:'',innerHTML:'',textContent:'',hidden:false,
      dataset:{},listeners:{},classList:{toggle(){},add(){},remove(){}},addEventListener(type,listener){this.listeners[type]=listener;},
      querySelector:node,querySelectorAll:()=>[],matches:()=>false,
      showModal(){this.open=true;},close(){this.open=false;}});
    return nodes.get(selector);
  };
  const context = {Date:FixtureDate,URL,crypto,structuredClone,TaskOutArchiveEffects:effects,setTimeout:()=>0,clearTimeout(){},TaskOutCore:Core,
    document:{querySelector:node,querySelectorAll:()=>[],addEventListener:(type,fn)=>handlers.set(type,fn)},
    chrome:{runtime:{id:'fixture-extension',onMessage:{addListener(){}},sendMessage:async request=>{
      requests.push(request);return request.action!=='snapshot'&&reply?reply(request):{ok:true,state:structuredClone(current)};
    }}}
  };
  if(preview)delete context.chrome;
  vm.createContext(context);
  const code=fs.readFileSync('extension/dashboard.js','utf8').replace('  refreshSnapshot();\n})();',
    '  globalThis.fixture={refreshSnapshot,handleAction,api};\n})();');
  vm.runInContext(code,context);
  return {node,requests,refresh:context.fixture.refreshSnapshot,
    replace:async next=>{current=next;await context.fixture.refreshSnapshot();},
    change:async(id,value)=>{const target=node('#'+id);target.value=value;await handlers.get('change')({target});},
    chooseSourceIcon:async value=>handlers.get('change')({target:{id:'',name:'source-style-icon',value,matches:()=>false}}),
    submit:async id=>handlers.get('submit')({target:node('#'+id),preventDefault(){}}),
    request:context.fixture.api,
    clickFilter:async dataset=>{const target={dataset,closest:()=>target};await handlers.get('click')({target});},
    search:async value=>{const target=node('#query');target.value=value;await target.listeners.input({target});},
    action:(action,dataset={})=>context.fixture.handleAction(action,{dataset}),
    tags:()=>[...node('#tags').innerHTML.matchAll(/data-tag="([^"]+)"/g)].map(match=>match[1]),
    ids:()=>[...`${node('#unassigned-items').innerHTML}${node('#board').innerHTML}`.matchAll(/data-record-id="([^"]+)"/g)].map(match=>match[1])};
}
const session=(id,days,projectId='recent')=>({id,kind:'session',title:id,sourceId:'fixture',sourceName:'示例来源',projectId,
  updatedAt:days===null?null:daysAgo(days),createdAt:days===null?null:daysAgo(days),tags:[]});
const webpage=(id,days)=>({...session(id,days,'web'),kind:'web',connectorId:'browser',sourceId:'browser',sourceName:'浏览器',url:'https://example.test/'+id});
const fixture=()=>({projects:[{id:'recent',name:'当前项目'},{id:'older',name:'较早项目'},{id:'empty',name:'空项目'},{id:'web',name:'网页项目'}],items:[
  webpage('web-old',90),webpage('web-no-time',null),
  session('session-1',1),session('session-6',6,'older'),session('session-29',29,'older'),session('session-31',31,'older'),
  session('session-no-time',null),session('session-future',-1),{...session('child',1),parentId:'session-1'}
]});

test('default view keeps every active webpage and only the last three days of main sessions',async()=>{
  const app=dashboard(fixture());await app.refresh();
  assert.equal(app.node('#range').value,'3');
  assert.deepEqual(new Set(app.ids()),new Set(['web-old','web-no-time','session-1']));
  assert.doesNotMatch(app.node('#board').innerHTML,/较早项目|空项目/);
  assert.doesNotMatch(app.node('#project').innerHTML,/较早项目|空项目/);
  assert.match(app.node('#stats').innerHTML,/近 7 天发起的对话 <strong>2<\/strong>/);
  assert.match(app.node('#stats').innerHTML,/对话创建时间未知 <strong>1<\/strong>/);
  assert.equal(app.requests[0].action,'snapshot');
});

test('changing dialogue time to seven, thirty or all days never time-filters webpages; reset restores three days',async()=>{
  const app=dashboard(fixture());await app.refresh();
  for(const [range,expected] of [['7',['session-1','session-6']],['30',['session-1','session-6','session-29']],
    ['0',['session-1','session-6','session-29','session-31','session-no-time','session-future']]]){
    await app.change('range',range);
    assert.deepEqual(new Set(app.ids()),new Set(['web-old','web-no-time',...expected]));
  }
  await app.action('reset-filters');
  assert.equal(app.node('#range').value,'3');
  assert.deepEqual(new Set(app.ids()),new Set(['web-old','web-no-time','session-1']));
});

test('new snapshot replaces visible groups, removes empty options and resets an obsolete project selection',async()=>{
  const initial=fixture(),app=dashboard(initial);await app.refresh();
  await app.change('project','recent');
  assert.deepEqual(app.ids(),['session-1']);
  // Preserve the source's historical assignments while replacing current rows.
  const next={...initial,projects:[...initial.projects,{id:'new',name:'新项目'}],items:[session('replacement',1,'new')]};
  await app.replace(next);
  assert.equal(app.node('#project').value,'all');
  assert.deepEqual(app.ids(),['replacement']);
  assert.match(app.node('#board').innerHTML,/新项目/);
  assert.doesNotMatch(app.node('#board').innerHTML,/当前项目|较早项目|空项目|网页项目/);
  assert.doesNotMatch(app.node('#project').innerHTML,/当前项目|较早项目|空项目|网页项目/);
  await app.refresh();await app.refresh();
  assert.deepEqual(app.ids(),['replacement']);
  assert.equal((app.node('#board').innerHTML.match(/class="project-card"/g)||[]).length,1);
  assert.equal(initial.items[2].projectId,'recent');
});

test('time-hidden groups return when the time window widens and disappear without empty cards when narrowed',async()=>{
  const app=dashboard(fixture());await app.refresh();
  await app.change('range','7');
  assert.match(app.node('#project').innerHTML,/较早项目/);
  await app.change('project','older');assert.deepEqual(app.ids(),['session-6']);
  await app.change('range','3');
  assert.equal(app.node('#project').value,'all');
  assert.doesNotMatch(app.node('#board').innerHTML,/较早项目/);
  await app.change('range','30');
  assert.equal(app.ids().filter(id=>id.startsWith('session-')).length,3);
  assert.match(app.node('#board').innerHTML,/较早项目/);
});

test('name completion requests only authorized unnamed sessions and applies only the selected edited sessionName',async()=>{
  const unnamed=(id,includeNaming=true)=>({...session(id,1),needsSessionName:true,
    tags:['需求规划'],summary:'原有近况',observations:[{allowAI:true,includeNaming}]});
  const snapshot={...fixture(),model:{baseUrl:'https://model.example/v1',model:'fixture-model'},items:[
    unnamed('allowed-a'),unnamed('allowed-b'),unnamed('denied',false),
    {...unnamed('already-named'),needsSessionName:false,sourceTitle:'原会话名字'},webpage('web',1)
  ]};
  const proposals=['allowed-a','allowed-b'].map((id,index)=>({id:'naming-'+index,recordId:id,kind:'naming',
    patch:{sessionName:'建议名称'+index},revision:0,reason:'根据首尾消息命名'}));
  const app=dashboard(snapshot,request=>request.action==='name-preview'?{ok:true,suggestions:proposals,excluded:[]}:{ok:true});
  await app.refresh();await app.action('name-sessions');
  assert.match(app.node('#dialog').innerHTML,/3 条会话缺少原名，2 条已允许/);
  assert.match(app.node('#dialog').innerHTML,/设置命名权限/);
  await app.action('ai-generate');
  const preview=app.requests.find(request=>request.action==='name-preview');
  assert.deepEqual(Array.from(preview.ids),['allowed-a','allowed-b']);
  assert.equal(app.requests.some(request=>request.action==='ai-preview'),false);
  const html=app.node('#dialog').innerHTML;
  assert.match(html,/suggestion-session-name/);
  assert.doesNotMatch(html,/suggestion-project|suggestion-tags|suggestion-summary/);
  assert.match(html,/应用后固定/);
  const cards=proposals.map((_proposal,index)=>({dataset:{suggestionIndex:String(index)},querySelector(selector){
    if(selector==='.suggestion-selected')return {checked:index===0};
    if(selector==='.suggestion-session-name')return {value:'  用户确认的固定名称  '};
    throw Error('命名不应读取其他整理字段：'+selector);
  }}));
  app.node('#dialog').querySelectorAll=selector=>selector==='.suggestion-card'?cards:[];
  await app.action('ai-apply');
  const applied=app.requests.find(request=>request.action==='ai-apply');
  assert.equal(applied.suggestions.length,1);
  assert.equal(applied.suggestions[0].recordId,'allowed-a');
  assert.deepEqual(JSON.parse(JSON.stringify(applied.suggestions[0].patch)),{sessionName:'用户确认的固定名称'});
  assert.equal(app.node('#dialog').open,false);
  assert.equal(snapshot.items[0].projectId,'recent');
  assert.deepEqual(snapshot.items[0].tags,['需求规划']);
});

const taggedFixture=()=>({projects:[{id:'p1',name:'项目一'},{id:'p2',name:'项目二'},{id:'web',name:'网页项目'}],items:[
  {...session('first-current',1,'p1'),tags:['调研分析'],saved:true},
  {...session('second-current',1,'p1'),tags:['方案设计']},
  {...session('other-project',1,'p2'),tags:['开发实现']},
  {...session('history',20,'p1'),tags:['测试排障']},
  {...session('archived',1,'p1'),tags:['文档整理'],archived:true},
  {...session('child-task',1,'p1'),tags:['使用咨询'],parentId:'first-current'},
  {...webpage('old-web',90),tags:['使用咨询']}
]});

test('type options contain only current main records, with old, archived and child types excluded until their scope is shown',async()=>{
  const initial=taggedFixture(),app=dashboard(initial);await app.refresh();
  assert.deepEqual(new Set(app.tags()),new Set(['all','调研分析','方案设计','开发实现','使用咨询']));
  await app.clickFilter({scope:'saved'});
  assert.deepEqual(app.tags(),['all','调研分析']);
  await app.clickFilter({scope:'archived'});
  assert.deepEqual(app.tags(),['all','文档整理']);
  await app.clickFilter({scope:'active'});await app.change('range','30');
  assert.deepEqual(new Set(app.tags()),new Set(['all','调研分析','方案设计','开发实现','测试排障','使用咨询']));
  assert.deepEqual(initial.items.find(item=>item.id==='child-task').tags,['使用咨询']);
  assert.deepEqual(initial.items.find(item=>item.id==='archived').tags,['文档整理']);
});

test('refresh after reclassification removes obsolete visible types and clears a selection even when history still has that type',async()=>{
  const initial=taggedFixture();initial.items.find(item=>item.id==='history').tags=['调研分析'];
  const app=dashboard(initial);await app.refresh();await app.clickFilter({tag:'调研分析'});
  assert.deepEqual(app.ids(),['first-current']);
  const next=structuredClone(initial);next.items.find(item=>item.id==='first-current').tags=['需求规划'];
  await app.replace(next);
  assert.equal(app.tags().includes('调研分析'),false);
  assert.equal(app.tags().includes('需求规划'),true);
  assert.match(app.node('#tags').innerHTML,/data-tag="all" class="active"/);
  assert.deepEqual(new Set(app.ids()),new Set(['first-current','second-current','other-project','old-web']));
  assert.deepEqual(initial.items[0].tags,['调研分析']);
  assert.deepEqual(next.items.find(item=>item.id==='history').tags,['调研分析']);
  await app.refresh();
  assert.equal(app.tags().filter(tag=>tag==='需求规划').length,1);
});

test('project and time changes reset an unavailable type without resetting a valid project or trapping the available choices',async()=>{
  const app=dashboard(taggedFixture());await app.refresh();await app.change('project','p1');
  assert.deepEqual(new Set(app.tags()),new Set(['all','调研分析','方案设计']));
  await app.clickFilter({tag:'调研分析'});
  assert.deepEqual(app.ids(),['first-current']);
  assert.deepEqual(new Set(app.tags()),new Set(['all','调研分析','方案设计']));
  assert.match(app.node('#project').innerHTML,/value="p2"/);
  await app.change('project','p2');
  assert.equal(app.node('#project').value,'p2');
  assert.deepEqual(app.ids(),['other-project']);
  assert.deepEqual(app.tags(),['all','开发实现']);
  assert.match(app.node('#tags').innerHTML,/data-tag="all" class="active"/);
  await app.change('range','30');await app.change('project','p1');await app.clickFilter({tag:'测试排障'});
  assert.deepEqual(app.ids(),['history']);
  await app.change('range','3');
  assert.equal(app.node('#project').value,'p1');
  assert.deepEqual(new Set(app.ids()),new Set(['first-current','second-current']));
  assert.deepEqual(new Set(app.tags()),new Set(['all','调研分析','方案设计']));
  assert.match(app.node('#tags').innerHTML,/data-tag="all" class="active"/);
});

test('type options follow source, content and search filters instead of exposing unrelated tags',async()=>{
  const app=dashboard(taggedFixture());await app.refresh();await app.change('source','fixture');
  assert.deepEqual(new Set(app.tags()),new Set(['all','调研分析','方案设计','开发实现']));
  await app.search('first-current');
  assert.deepEqual(app.tags(),['all','调研分析']);
  await app.search('');await app.change('source','all');await app.change('kind','web');
  assert.deepEqual(app.tags(),['all','使用咨询']);
  assert.deepEqual(app.ids(),['old-web']);
});

test('one settings entry contains occasional operations while cards retain direct actions',async()=>{
  const html=fs.readFileSync('extension/index.html','utf8');
  const toolbar=html.match(/<div class="toolbar-actions">([\s\S]*?)<\/div>/)[1];
  assert.equal((toolbar.match(/<button\b/g)||[]).length,1);
  assert.match(toolbar,/data-action="settings"/);
  assert.doesNotMatch(html,/data-action="(?:model|connections|organize|name-sessions|project-new|refresh|undo|import|export|batch-archive)"/);
  assert.match(html,/<details class="filter-menu">/);
  const app=dashboard({...fixture(),undoAvailable:true,suggestions:[{id:'previous-preview'}]});await app.refresh();
  assert.doesNotMatch(app.node('#board').innerHTML,/data-action="group-archive"/);
  for(const action of ['open','bookmark','archive'])assert.match(app.node('#board').innerHTML,new RegExp('data-action="'+action+'"'));
  await app.action('settings');
  const settings=app.node('#dialog').innerHTML;
  for(const label of ['模型与自动整理','会话来源','手动操作','数据管理','使用说明'])assert.ok(settings.includes(label));
  for(const action of ['model','connections','organize-now','project-new','progress-refresh','undo','import','export','batch-archive','pending-suggestions'])
    assert.match(settings,new RegExp('data-action="'+action+'"'));
  assert.match(settings,/当前筛选共 3 条/);
  assert.match(settings,/归档当前 3 条/);
});

test('organize now previews historical rows and blocks repeated requests while running',async()=>{
  let resolve;
  const gate=new Promise(done=>{resolve=done;});
  const snapshot={...fixture(),model:{baseUrl:'https://model.example/v1',model:'fixture-model',autoOrganize:true},organization:{status:'idle'}};
  snapshot.items.push({...webpage('detached-web',1),needsBinding:true});
  const app=dashboard(snapshot,request=>request.action==='history-preview'?gate:{ok:true});await app.refresh();await app.action('settings');
  const first=app.action('organize-now');
  assert.equal(app.node('#organization-status').dataset.status,'running');
  assert.match(app.node('#dialog').innerHTML,/data-action="organize-now" disabled/);
  await app.action('organize-now');
  const calls=app.requests.filter(request=>request.action==='history-preview');
  assert.equal(calls.length,1);
  assert.deepEqual(new Set(calls[0].ids),new Set(['web-old','web-no-time','session-1']));
  resolve({ok:true,suggestions:[],excluded:[]});await first;
  assert.equal(app.node('#organization-status').dataset.status,'idle');
  assert.equal(app.requests.some(request=>['ai-preview','name-preview','ai-apply'].includes(request.action)),false);
  assert.match(app.node('#dialog').innerHTML,/预览整理建议/);
});

test('unconfigured and failed organization states lead to settings without claiming model connectivity',async()=>{
  const app=dashboard(fixture());await app.refresh();
  assert.equal(app.node('#organization-status').dataset.status,'unconfigured');
  assert.match(app.node('#organization-status').innerHTML,/data-action="settings"/);
  assert.doesNotMatch(app.node('#organization-status').innerHTML,/已连接|联通|已整理/);
  await app.action('organize-now');
  assert.match(app.node('#dialog').innerHTML,/预览整理建议/);
  assert.equal(app.requests.some(request=>request.action==='history-preview'),true);
  await app.replace({...fixture(),model:{baseUrl:'https://model.example/v1',model:'fixture-model'},
    organization:{status:'error',message:'示例模型暂不可用'}});
  assert.equal(app.node('#organization-status').dataset.status,'error');
  await app.action('settings');
  assert.match(app.node('#dialog').innerHTML,/示例模型暂不可用/);
  assert.match(app.node('#dialog').innerHTML,/重试整理当前内容/);
});

test('unbound webpages leave the current overview but remain accessible from settings and historical views',async()=>{
  const detached={...webpage('detached',1),title:'同名网页',needsBinding:true,saved:true,tags:['旧标签']};
  const live={...webpage('live',1),title:'同名网页',needsBinding:false};
  const archived={...webpage('archived-detached',1),needsBinding:true,archived:true};
  const initial={...fixture(),items:[detached,live,archived,webpage('legacy-unknown-binding',90)]};
  const app=dashboard(initial);await app.refresh();
  assert.deepEqual(new Set(app.ids()),new Set(['live','legacy-unknown-binding']));
  assert.equal(app.tags().includes('旧标签'),false);
  await app.action('settings');
  assert.match(app.node('#dialog').innerHTML,/历史网页 · 1 条/);
  const sections=[...app.node('#dialog').innerHTML.matchAll(/<section class="settings-section">([\s\S]*?)<\/section>/g)].map(match=>match[1]);
  assert.doesNotMatch(sections.find(section=>section.includes('<h3>会话来源</h3>')),/data-action="unbound"/);
  assert.match(sections.find(section=>section.includes('<h3>数据管理</h3>')),/data-action="unbound"/);
  assert.match(app.node('#dialog').innerHTML,/已有分类仍保留/);
  await app.action('unbound');
  assert.deepEqual(app.ids(),['detached']);
  assert.equal(app.node('#scope-title').textContent,'历史网页');
  assert.match(app.node('#board').innerHTML,/网页项目/);
  assert.match(app.node('#board').innerHTML,/<button class="entry-title" data-action="detail" data-id="detached">/);
  await app.clickFilter({scope:'saved'});assert.deepEqual(app.ids(),['detached']);
  await app.clickFilter({scope:'archived'});assert.deepEqual(app.ids(),['archived-detached']);
  await app.clickFilter({scope:'recent'});assert.equal(app.ids().includes('detached'),true);
  await app.clickFilter({scope:'active'});assert.equal(app.ids().includes('detached'),false);
  assert.deepEqual(initial.items[0],detached);
  assert.equal(initial.items.length,4);
});

test('dialogue windows always use latest updates, independently from creation order or the recently started view',async()=>{
  const initial={...fixture(),items:[
    {...session('old-but-updated',1),createdAt:daysAgo(90)},
    {...session('new-with-old-update',10),createdAt:daysAgo(1)},
    {...session('new-with-no-update',null),createdAt:daysAgo(1)},
    {...session('unknown-creation-with-update',1),createdAt:null},
    webpage('web-without-times',null)
  ]};
  const app=dashboard(initial);await app.refresh();
  const expected=new Set(['old-but-updated','unknown-creation-with-update','web-without-times']);
  assert.deepEqual(new Set(app.ids()),expected);
  assert.match(app.node('#view-hint').textContent,/近 3 天有更新/);
  await app.change('sort','createdAt');
  assert.deepEqual(new Set(app.ids()),expected);
  await app.change('sort','title');
  assert.deepEqual(new Set(app.ids()),expected);
  await app.clickFilter({scope:'recent'});
  assert.deepEqual(new Set(app.ids()),new Set(['old-but-updated','web-without-times']));
  assert.equal(app.node('#range').value,'3');
  assert.doesNotMatch(app.node('#stats').innerHTML,/data-stat="recent"/);
});

test('imported webpages stay visible and manually organizable without being treated as unbound browser tabs',async()=>{
  const record=Core.importRecords('web-fixture',JSON.stringify([{id:'imported-web',kind:'web',title:'导入网页',
    url:'https://example.test/imported',allowAI:true}])).records[0];
  const imported=Core.publicItem(record,NOW),detached={...webpage('old-browser-tab',1),needsBinding:true};
  assert.equal(imported.connectorId,'standard-import');assert.equal(imported.needsBinding,true);
  const app=dashboard({...fixture(),items:[imported,detached],
    model:{baseUrl:'https://model.example/v1',model:'fixture-model',autoOrganize:true}},()=>({ok:true,applied:1}));
  await app.refresh();
  assert.deepEqual(app.ids(),[imported.id]);
  assert.doesNotMatch(app.node('#unassigned-items').innerHTML,/未关联页签/);
  assert.match(app.node('#unassigned-items').innerHTML,/<a class="entry-title"[^>]*data-action="open"/);
  await app.action('settings');assert.match(app.node('#dialog').innerHTML,/历史网页 · 1 条/);
  await app.action('unbound');assert.deepEqual(app.ids(),['old-browser-tab']);
  await app.clickFilter({scope:'active'});await app.action('organize-now');
  const request=app.requests.find(message=>message.action==='organize-now');
  assert.deepEqual(Array.from(request.ids),[imported.id]);
});

test('default card order follows each groups latest visible update and rows descend stably within their group',async()=>{
  const snapshot={projects:[{id:'p3',name:'项目三'},{id:'p2',name:'项目二'},{id:'p1',name:'项目一'}],items:[
    session('p1-older',1,'p1'),session('p2-newest',0.5,'p2'),
    session('p1-equal-first',0.25,'p1'),session('p1-equal-second',0.25,'p1'),
    {...session('p3-hidden-newest',0.1,'p3'),archived:true},
    session('p3-visible',2,'p3'),session('p2-older',2,'p2')
  ]};
  const app=dashboard(snapshot);await app.refresh();
  const groupOrder=()=>[...app.node('#board').innerHTML.matchAll(/data-project-drop="([^"]+)"/g)].map(match=>match[1]);
  const expected=['p1-equal-first','p1-equal-second','p1-older','p2-newest','p2-older','p3-visible'];
  assert.deepEqual(groupOrder(),['p1','p2','p3']);
  assert.deepEqual(app.ids(),expected);
  await app.refresh();
  assert.deepEqual(groupOrder(),['p1','p2','p3']);
  assert.deepEqual(app.ids(),expected);
});

test('title order uses member titles rather than project names and creation order leaves the update window unchanged',async()=>{
  const snapshot={projects:[{id:'p1',name:'AAA project'},{id:'p2',name:'ZZZ project'}],items:[
    {...session('a-old-created',1,'p1'),title:'Bravo',createdAt:daysAgo(90)},
    {...session('a-new-created',2,'p1'),title:'Zulu',createdAt:daysAgo(1)},
    {...session('b-old-created',1,'p2'),title:'Alpha',createdAt:daysAgo(20)},
    {...session('b-new-created',2,'p2'),title:'Delta',createdAt:daysAgo(2)},
    {...session('recently-created-but-inactive',20,'p2'),title:'Aardvark',createdAt:daysAgo(0.1)}
  ]};
  const app=dashboard(snapshot);await app.refresh();await app.change('sort','title');
  const groupOrder=()=>[...app.node('#board').innerHTML.matchAll(/data-project-drop="([^"]+)"/g)].map(match=>match[1]);
  assert.deepEqual(groupOrder(),['p2','p1']);
  assert.deepEqual(app.ids(),['b-old-created','b-new-created','a-old-created','a-new-created']);
  await app.change('sort','createdAt');
  assert.deepEqual(groupOrder(),['p1','p2']);
  assert.deepEqual(app.ids(),['a-new-created','a-old-created','b-new-created','b-old-created']);
  assert.equal(app.node('#range').value,'3');
  assert.equal(app.ids().includes('recently-created-but-inactive'),false);
});

test('organization errors explain the category on the overview and keep advice plus raw details behind one settings link',async()=>{
  const cases=[
    ['无法连接模型接口，请检查地址、网络和扩展访问权限。',/连接|连不上/,/地址|网络|服务/],
    ['模型请求超时，请稍后重试。',/超时/,/稍后|重试|网络/],
    ['API Key 无效或已过期。',/Key|密钥|认证/,/Key|密钥/],
    ['模型接口拒绝访问，请检查权限。',/权限|拒绝/,/权限|授权/],
    ['模型接口请求失败（HTTP 404）。',/地址|接口/,/地址|接口/],
    ['请求过于频繁或额度不足，请稍后重试。',/频繁|限流|额度/,/稍后|额度|频率|重试/],
    ['模型接口请求失败（HTTP 503）。',/服务/,/稍后|重试|服务/],
    ['模型接口返回的不是有效 JSON，请检查接口地址。',/格式|输出|JSON|不符合要求/,/地址|模型|格式|重试/],
    ['模型建议格式不正确，未应用任何修改。请重试。',/格式|输出|不符合要求/,/模型|格式|重试/],
    ['模型未为缺名会话返回名称，本次整理未应用，将稍后重试。',/名称|命名/,/模型|名称|命名|重试/],
    ['模型输出达到长度上限，未应用任何修改。请减少记录或简化整理偏好。',/过长|截断|长度|不完整/,/减少|简化|少量|缩小/]
  ];
  for(const [message,category,advice] of cases){
    const app=dashboard({...fixture(),model:{baseUrl:'https://model.example/v1',model:'fixture-model',autoOrganize:true},
      organization:{status:'error',message}});await app.refresh();
    const overview=app.node('#organization-status').innerHTML;
    assert.match(overview,/自动整理失败：/,'error: '+message);
    assert.match(overview,category,'category: '+message);
    assert.equal((overview.match(/data-action="settings"/g)||[]).length,1);
    assert.match(overview,/>查看原因<\/a>/);
    assert.doesNotMatch(overview,/<button\b/);
    await app.action('settings');
    const settings=app.node('#dialog').innerHTML;
    const details=settings.match(/<details\b([^>]*)>[\s\S]*?<summary>详细错误<\/summary>([\s\S]*?)<\/details>/);
    assert.ok(details,'raw error detail disclosure: '+message);
    assert.doesNotMatch(details[1],/\bopen\b/);
    assert.ok(details[2].includes(message),'keep original message: '+message);
    assert.match(settings.replace(details[0],''),advice,'actionable advice: '+message);
    assert.equal(app.requests.every(request=>request.action==='snapshot'),true);
  }
});

test('unknown errors do not invent a cause, missing reasons fall back gracefully, and raw HTML is escaped',async()=>{
  const raw='Unexpected gateway payload <img src=x onerror="alert(1)"> & malformed <script>bad()</script>';
  const model={baseUrl:'https://model.example/v1',model:'fixture-model',autoOrganize:true};
  const app=dashboard({...fixture(),model,organization:{status:'error',message:raw}});await app.refresh();
  assert.match(app.node('#organization-status').innerHTML,/自动整理失败：暂时无法完成/);
  await app.action('settings');
  const html=app.node('#dialog').innerHTML;
  assert.match(html,/详细错误/);
  assert.match(html,/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; malformed &lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html,/<(?:img|script)\b/);
  await app.replace({...fixture(),model,organization:{status:'error'}});
  assert.match(app.node('#organization-status').innerHTML,/自动整理失败：暂时无法完成/);
  await app.action('settings');
  assert.doesNotMatch(app.node('#dialog').innerHTML,/Unexpected gateway|>undefined<|>null</);
  assert.equal(app.requests.every(request=>request.action==='snapshot'),true);
});

test('manual failure while automation is disabled is not labelled as an automatic failure',async()=>{
  const model={baseUrl:'https://model.example/v1',model:'fixture-model',autoOrganize:false};
  const app=dashboard({...fixture(),model,organization:{status:'paused'}});await app.refresh();
  assert.match(app.node('#organization-status').innerHTML,/自动整理已暂停/);
  await app.replace({...fixture(),model,organization:{status:'error',message:'模型请求超时，请稍后重试。'}});
  const overview=app.node('#organization-status').innerHTML;
  assert.match(overview,/整理失败：[^<]*超时/);
  assert.doesNotMatch(overview,/自动整理失败/);
  assert.match(overview,/>查看原因<\/a>/);
  assert.doesNotMatch(overview,/\d+\s*秒后/);
  assert.equal(app.requests.every(request=>request.action==='snapshot'),true);
});

test('unrecognized project references are reported as invalid grouping results rather than connection or compatibility failures',async()=>{
  for(const message of ['模型引用了不存在的项目，未应用任何修改。',
    '模型引用了不存在或有歧义的项目，当前这批结果未应用。',
    '模型返回的分组无法识别，自动纠正后仍未通过校验，当前这批结果未应用。']){
    const app=dashboard({...fixture(),model:{baseUrl:'https://model.example/v1',model:'fixture-model',autoOrganize:true},
      organization:{status:'error',message}});await app.refresh();
    const overview=app.node('#organization-status').innerHTML;
    assert.match(overview,/自动整理失败：模型返回的分组无法识别/);
    assert.equal((overview.match(/data-action="settings"/g)||[]).length,1);
    assert.match(overview,/>查看原因<\/a>/);
    await app.action('settings');
    const html=app.node('#dialog').innerHTML,error=html.match(/<div class="organization-error"[^>]*>([\s\S]*?)<\/div>/)[1];
    assert.match(error,/模型已响应，但分组结果未通过校验/);
    assert.match(error,/重试当前内容/);
    assert.match(error,/已有整理保留/);
    assert.ok(error.includes(message));
    assert.doesNotMatch(error,/服务兼容性|接口地址|无法连接|更换模型/);
    await app.action('model');
    assert.match(app.node('#dialog').innerHTML,/测试只用虚构分类样例，不发送真实记录/);
    assert.match(app.node('#dialog').innerHTML,/测试通过不代表所有真实内容都能正确分类/);
    assert.equal(app.requests.every(request=>request.action==='snapshot'),true);
  }
});

test('source appearance lists distinct sources, previews accessible custom colors, and cancellation never saves a draft',async()=>{
  const snapshot={...fixture(),sourceStyles:{}},app=dashboard(snapshot);await app.refresh();await app.action('settings');
  assert.match(app.node('#dialog').innerHTML,/data-action="source-styles">图标与颜色/);
  await app.action('source-styles');
  const list=app.node('#dialog').innerHTML;
  assert.equal((list.match(/data-source-style-id=/g)||[]).length,2);
  assert.match(list,/>浏览器<\/strong>/);assert.match(list,/>示例来源<\/strong>/);
  await app.action('source-style-edit',{sourceId:'browser'});
  const editor=app.node('#dialog').innerHTML;
  assert.equal((editor.match(/name="source-style-icon"/g)||[]).length,7);
  assert.equal((editor.match(/data-action="source-style-color"/g)||[]).length,8);
  await app.chooseSourceIcon('web');await app.change('source-style-color','#ffffff');
  const preview=app.node('#source-style-preview').innerHTML;
  assert.match(preview,/--source-color:#ffffff/);
  assert.doesNotMatch(preview,/--source-ink:#ffffff/);
  assert.match(preview,/<svg\b[\s\S]*<circle/);
  assert.doesNotMatch(preview,/>web</);
  assert.match(preview,/>浏览器<\/strong>/);
  await app.action('source-styles');await app.refresh();
  assert.deepEqual(snapshot.sourceStyles,{});
  assert.equal(app.requests.some(request=>request.action.startsWith('source-style-')),false);
});

test('saved source styling updates every matching badge and source card while preserving records and other sources, then resets offline',async()=>{
  const snapshot={...fixture(),sourceStyles:{},items:[
    {...session('alpha-one',1),sourceId:'fixture-alpha',sourceName:'自定义来源',sourceIcon:'message'},
    {...session('alpha-two',1),sourceId:'fixture-alpha',sourceName:'自定义来源',sourceIcon:'message'},
    {...session('beta',1),sourceId:'fixture-beta',sourceName:'另一个来源',sourceIcon:'web'}
  ]};
  const initial=structuredClone(snapshot.items),defaults=Core.sourceAppearance(snapshot,snapshot.items[0]);
  const app=dashboard(snapshot,request=>{
    if(request.action==='source-style-save'){Core.saveSourceStyle(snapshot,{sourceId:request.sourceId,icon:request.icon,color:request.color});return {ok:true};}
    if(request.action==='source-style-reset'){Core.resetSourceStyle(snapshot,request.sourceId);return {ok:true};}
    if(request.action==='record-detail')return {ok:true,item:snapshot.items.find(item=>item.id===request.id),children:[]};
    throw Error('Appearance must not request a model or local service');
  });
  await app.refresh();const betaColor=Core.sourceAppearance(snapshot,snapshot.items[2]).color;
  await app.action('source-style-edit',{sourceId:'fixture-alpha'});await app.chooseSourceIcon('code');
  await app.action('source-style-color',{color:'#c2410c'});await app.submit('source-style-form');
  assert.deepEqual(snapshot.sourceStyles['fixture-alpha'],{icon:'code',color:'#c2410c'});
  assert.equal((app.node('#board').innerHTML.match(/--source-color:#c2410c;/g)||[]).length,2);
  assert.match(app.node('#board').innerHTML,/<path d="m8 6-6 6 6 6/);
  assert.match(app.node('#board').innerHTML,new RegExp('--source-color:'+betaColor));
  await app.action('detail',{id:'alpha-one'});
  assert.match(app.node('#detail').innerHTML,/--source-color:#c2410c/);
  assert.match(app.node('#detail').innerHTML,/自定义来源/);
  await app.clickFilter({grouping:'source'});
  assert.match(app.node('#board').innerHTML,/--group-color:#c2410c/);
  await app.refresh();
  assert.equal((app.node('#board').innerHTML.match(/--source-color:#c2410c;/g)||[]).length,2);
  assert.deepEqual(snapshot.items,initial);
  await app.action('source-style-edit',{sourceId:'fixture-alpha'});await app.action('source-style-reset');
  assert.equal(Object.hasOwn(snapshot.sourceStyles,'fixture-alpha'),false);
  assert.match(app.node('#board').innerHTML,new RegExp('--source-color:'+defaults.color));
  assert.deepEqual(snapshot.items,initial);
  assert.equal(app.requests.some(request=>['service','service-status','ai-preview','organize-now'].includes(request.action)),false);
});

test('temporary preview preserves user source styles on import, exports them, and treats prototype-like source IDs as data',async()=>{
  const app=dashboard({},undefined,{preview:true});
  const content=JSON.stringify({records:[{id:'a',kind:'web',title:'构造来源',url:'https://example.test/a',source:{id:'constructor',label:'构造来源',icon:'web'}},
    {id:'b',kind:'web',title:'原型来源',url:'https://example.test/b',source:{id:'__proto__',label:'原型来源',icon:'message'}}]});
  await app.request('import-apply',{datasetId:'appearance-fixture',text:content});await app.refresh();await app.action('source-styles');
  assert.match(app.node('#dialog').innerHTML,/仅在本页临时保存/);
  assert.equal((app.node('#dialog').innerHTML.match(/跟随来源 · 默认配色/g)||[]).length,2);
  for(const id of ['constructor','__proto__']){
    await app.action('source-style-edit',{sourceId:id});await app.chooseSourceIcon('terminal');
    await app.change('source-style-color','#112233');await app.submit('source-style-form');
  }
  let exported=(await app.request('export',{mode:'data'})).data;
  for(const id of ['constructor','__proto__'])assert.deepEqual(exported.sourceStyles[id],{icon:'terminal',color:'#112233'});
  const conflictingStyles=JSON.parse('{"constructor":{"icon":"sparkles","color":"#ff0000"},"__proto__":{"icon":"folder","color":"#00ff00"},"new-source":{"icon":"code","color":"#334455"}}');
  const backup=JSON.stringify({sourceStyles:conflictingStyles,records:[]});
  await app.action('import');app.node('#import-dataset').value='appearance-backup';app.node('#import-text').value=backup;
  await app.action('import-preview');assert.match(app.node('#import-preview').innerHTML,/0 条记录 · 3 个来源外观/);
  await app.request('import-apply',{datasetId:'appearance-backup',text:backup});
  exported=(await app.request('export',{mode:'data'})).data;
  for(const id of ['constructor','__proto__'])assert.deepEqual(exported.sourceStyles[id],{icon:'terminal',color:'#112233'});
  assert.deepEqual(exported.sourceStyles['new-source'],{icon:'code',color:'#334455'});
  await app.refresh();await app.action('source-style-edit',{sourceId:'constructor'});await app.action('source-style-reset');
  exported=(await app.request('export',{mode:'data'})).data;
  assert.equal(Object.hasOwn(exported.sourceStyles,'constructor'),false);
  assert.equal(Object.hasOwn(exported.sourceStyles,'__proto__'),true);
  assert.equal(exported.records.length,2);
  assert.equal(app.requests.length,0);
});

test('archive feedback prepares in the gesture and waits for exact successes; restore does not celebrate',async()=>{
  const calls=[];let resolve;
  const gate=new Promise(done=>{resolve=done;});
  const effects={prepare(ids){calls.push(['prepare',Array.from(ids)]);return {finish(ids){calls.push(['finish',Array.from(ids)]);},cancel(){calls.push(['cancel']);}};}};
  const app=dashboard(fixture(),request=>request.action==='archive'?gate:{ok:true},{effects});await app.refresh();
  const pending=app.action('batch-archive');assert.deepEqual(calls,[['prepare',['session-1','web-old','web-no-time']]]);
  assert.equal(calls.some(call=>call[0]==='finish'),false);
  resolve({ok:true,results:[{id:'session-1',ok:true},{id:'web-old',ok:false,error:'close failed'},{id:'web-no-time',ok:false,error:'save failed'}]});await pending;
  assert.deepEqual(calls.at(-1),['finish',['session-1']]);
  await app.action('restore',{id:'web-old'});assert.equal(calls.length,2);
  const failed=dashboard(fixture(),()=>{throw Error('保存失败');},{effects});await failed.refresh();
  await assert.rejects(failed.action('archive',{id:'web-old'}),/保存失败/);assert.deepEqual(calls.at(-1),['cancel']);
});

test('failure inside optional archive effects cannot prevent save and close requests',async()=>{
  const app=dashboard(fixture(),()=>({ok:true,results:[{id:'web-old',ok:true}]}),{effects:{prepare(){throw Error('audio unavailable');}}});await app.refresh();
  await app.action('archive',{id:'web-old'});assert.equal(app.requests.filter(request=>request.action==='archive').length,1);
});

function reportFixture(){
  const totals={requests:2,inputTokens:null,outputTokens:null,totalTokens:null,cachedInputTokens:null,unknownUsageRequests:2,unpricedRequests:2,costPartialRequests:0,estimatedCosts:{},partial:true};
  return {days:30,firstRecordedAt:NOW,totals,models:[{baseUrl:'https://models.example/v1',model:'fictional-model',...totals}],
    daily:[{date:'2026-09-17',...totals}],pricing:[],forecast:{available:false,totals:null,reason:'累计记录不足 24 小时，暂不预测。'},
    recent:[{id:'call-1',at:NOW,purpose:'test',trigger:'manual',status:'error',baseUrl:'https://models.example/v1',model:'fictional-model',inputTokens:null,outputTokens:null,totalTokens:null,cachedInputTokens:null,cost:null,recordCount:1}]};
}
test('usage settings show unknown tokens and prices honestly, identify tests and switch report windows',async()=>{
  const report=reportFixture(),app=dashboard(fixture(),request=>request.action==='usage-report'?{ok:true,report}:{ok:true});await app.refresh();await app.action('settings');
  assert.match(app.node('#dialog').innerHTML,/data-action="usage"/);await app.action('usage');
  let html=app.node('#dialog').innerHTML;
  for(const text of ['总 tokens</small><strong>未知','估算费用</small><strong>未知','费用未知','单价未配置','未返回完整用量','累计记录不足 24 小时','不包含 Codex','测试</span>'])assert.ok(html.includes(text),text);
  assert.doesNotMatch(html,/CNY 0|USD 0|0 tokens/);
  assert.match(html,/每日调用趋势/);assert.match(html,/未来 30 天估算/);assert.match(html,/data-days="1"/);
  for(const days of [1,7,30])await app.action('usage-range',{days:String(days)});
  assert.deepEqual(app.requests.filter(request=>request.action==='usage-report').map(request=>request.days),[30,1,7,30]);
});
test('usage totals retain separate currencies and partial labels; prices are scoped by gateway and blank fields preserve existing values',async()=>{
  const report=reportFixture();report.totals={...report.totals,totalTokens:1500,estimatedCosts:{CNY:1.5,USD:0},costPartialRequests:1};
  report.pricing=[{baseUrl:'https://models.example/v1',model:'fictional-model',currency:'USD',inputPerMillion:2,outputPerMillion:6,cachedInputPerMillion:.5}];
  report.forecast={available:true,partial:true,totals:{...report.totals,requests:60,totalTokens:45000,estimatedCosts:{CNY:45,USD:0}},reason:'按近7天日均估算'};
  const app=dashboard(fixture(),request=>request.action==='usage-report'?{ok:true,report}:{ok:true});await app.refresh();await app.action('usage');
  assert.match(app.node('#dialog').innerHTML,/CNY 1.5 · USD 0（部分估算）/);assert.match(app.node('#dialog').innerHTML,/未计缓存优惠/);
  assert.match(app.node('#dialog').innerHTML,/CNY 45 · USD 0/);await app.action('pricing-edit',{index:'0'});
  assert.match(app.node('#dialog').innerHTML,/留空保持已有单价/);assert.match(app.node('#dialog').innerHTML,/value="0.5"/);
  app.node('#price-currency').value='USD';app.node('#price-inputPerMillion').value='  ';app.node('#price-outputPerMillion').value='0';app.node('#price-cachedInputPerMillion').value='';
  await app.submit('pricing-form');
  const save=app.requests.find(request=>request.action==='pricing-save');
  assert.equal(save.baseUrl,'https://models.example/v1');assert.equal(save.model,'fictional-model');assert.equal(save.outputPerMillion,0);
  assert.equal(Object.hasOwn(save,'inputPerMillion'),false);assert.equal(Object.hasOwn(save,'cachedInputPerMillion'),false);
});
test('settings frequency defaults to one minute, permits manual-only, and progress refresh sends no regroup request',async()=>{
  const app=dashboard(fixture(),()=>({ok:true}));await app.refresh();await app.action('settings');
  const settings=app.node('#dialog').innerHTML;assert.match(settings,/value="60" selected/);assert.match(settings,/新会话归类一次/);
  assert.match(settings,/已有会话只更新进展/);assert.match(settings,/data-action="progress-refresh"/);
  app.node('#sync-interval').value='0';await app.submit('sync-settings-form');
  assert.equal(app.requests.find(request=>request.action==='sync-settings-save').intervalSeconds,0);
  await app.action('progress-refresh');assert.equal(app.requests.filter(request=>request.action==='progress-refresh').length,1);
  assert.equal(app.requests.some(request=>['organize-now','ai-preview'].includes(request.action)),false);
  await app.replace({...fixture(),syncSettings:{intervalSeconds:0}});await app.action('settings');assert.match(app.node('#dialog').innerHTML,/value="0" selected/);
});
test('record types use a single fixed choice and do not expose legacy freeform labels',async()=>{
  const record={...session('named',1),tags:['Workspace']};
  const app=dashboard({...fixture(),items:[record]},()=>({ok:true}));await app.refresh();assert.deepEqual(app.tags(),['all']);
  assert.doesNotMatch(app.node('#board').innerHTML,/Workspace/);await app.action('record-edit',{id:'named'});
  const html=app.node('#dialog').innerHTML;assert.match(html,/<select id="record-tags">/);assert.doesNotMatch(html,/用逗号|Workspace|multiple/);
  for(const type of Core.TYPE_LABELS)assert.match(html,new RegExp('value="'+type+'"'));
  app.node('#record-alias').value='named';app.node('#record-project').value='recent';app.node('#record-summary').value='';app.node('#record-source').value='示例来源';app.node('#record-tags').value='需求规划';
  await app.submit('record-form');assert.deepEqual(Array.from(app.requests.find(request=>request.action==='record-edit').patch.tags),['需求规划']);
});

test('suggestion review edits one canonical type rather than accepting comma-separated categories',async()=>{
  const record={...session('typed',1),tags:['需求规划'],summary:'之前的近况'},proposal={id:'suggestion',recordId:'typed',patch:{tags:['方案设计']}};
  const app=dashboard({...fixture(),items:[record],suggestions:[proposal]},()=>({ok:true}));await app.refresh();await app.action('pending-suggestions');
  const html=app.node('#dialog').innerHTML;assert.match(html,/<select class="suggestion-tags">/);assert.match(html,/value="方案设计" selected/);assert.doesNotMatch(html,/<input class="suggestion-tags"/);
  let type='开发实现，方案设计';
  app.node('#dialog').querySelectorAll=selector=>selector==='.suggestion-card'?[{dataset:{suggestionIndex:'0'},querySelector(selector){return selector==='.suggestion-selected'?{checked:true}:{value:selector==='.suggestion-tags'?type:selector==='.suggestion-project'?'recent':'之前的近况'};}}]:[];
  await assert.rejects(app.action('ai-apply'),/请选择一个有效类型/);assert.equal(app.requests.some(request=>request.action==='ai-apply'),false);
  type='开发实现';await app.action('ai-apply');assert.deepEqual(Array.from(app.requests.find(request=>request.action==='ai-apply').suggestions[0].patch.tags),['开发实现']);
});


test('settings summarize the configured AI group cap and the preview exports the same default',async()=>{
  const app=dashboard({...fixture(),model:{baseUrl:'https://model.example/v1',model:'fixture-model',maxGroups:12}});
  await app.refresh();await app.action('settings');
  assert.match(app.node('#dialog').innerHTML,/期望约 12 个分组/);
  const preview=dashboard({},undefined,{preview:true});
  await preview.refresh();await preview.action('settings');
  assert.match(preview.node('#dialog').innerHTML,/期望约 5 个分组/);
  const snapshot=await preview.request('snapshot');
  assert.equal(snapshot.state.model.maxGroups,5);
  const exported=await preview.request('export',{mode:'config'});
  assert.equal(exported.data.model.maxGroups,5);
});

test('protected group overflow points to cap or manual assignment changes without inventing a model failure',async()=>{
  const message='已有 7 个人工固定或不可自动调整的分组，超过上限 5。请提高上限，或手动调整这些归属后重试。';
  const app=dashboard({...fixture(),model:{baseUrl:'https://model.example/v1',model:'fixture-model',maxGroups:5},organization:{status:'error',message}});
  await app.refresh();await app.action('settings');
  assert.match(app.node('#organization-status').innerHTML,/需保留的分组数超过上限/);
  const html=app.node('#dialog').innerHTML,error=html.match(/<div class="organization-error"[^>]*>([\s\S]*?)<\/div>/)[1];
  assert.match(error,/提高“期望分组数”/);assert.match(error,/手动将这些记录归入其他项目/);
  assert.match(error,/固定归属不会自动改动/);assert.ok(error.includes(message));
  assert.doesNotMatch(error,/服务兼容性|接口地址|无法连接|更换模型/);
  assert.equal(app.requests.every(request=>request.action==='snapshot'),true);
});

test('group cap and incomplete consolidation errors keep recovery advice separate from connection failures',async()=>{
  for(const [message,label,advice] of [
    ['模型提出的分组超过设置上限，当前批次未应用。','模型没有遵守分组上限','提高上限'],
    ['模型未为每条待合并记录选择保留项目，当前批次未应用。','部分记录尚未完成合并','剩余分组'],
    ['当前在用分组超过上限，请先合并已有分组。','需要先合并已有分组','合并自动分组'],
    ['当前已有 5 个在用分组，达到上限 5。','需要先合并已有分组','提高上限'],
  ]){
    const app=dashboard({...fixture(),model:{baseUrl:'https://model.example/v1',model:'fixture-model'},organization:{status:'error',message}});
    await app.refresh();await app.action('settings');
    assert.ok(app.node('#organization-status').innerHTML.includes(label));
    const error=app.node('#dialog').innerHTML.match(/<div class="organization-error"[^>]*>([\s\S]*?)<\/div>/)[1];
    assert.ok(error.includes(advice));assert.doesNotMatch(error,/无法连接|API Key|服务兼容性/);
  }
});
