'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const C = require('../extension/core.js');
const now = Date.now() - 1000;
const event = (id, patch = {}) => ({id, at: now, baseUrl:'https://model.example/v1', model:'fixture', purpose:'grouping', trigger:'manual', status:'response', inputTokens:1000, outputTokens:200, totalTokens:1200, cachedInputTokens:0, recordCount:2, attempt:0, ...patch});
const price = (state, patch = {}) => C.saveModelPricing(state, {baseUrl:'https://model.example/v1', model:'fixture', currency:'CNY', inputPerMillion:2, outputPerMillion:5, cachedInputPerMillion:0.5, ...patch});
const report = state => C.usageReport(state, {days:30, now:now + 500});

test('usage absence remains unknown while reported zero tokens and free pricing remain zero', () => {
  const state=C.initial();price(state,{inputPerMillion:0,outputPerMillion:0,cachedInputPerMillion:0});
  C.recordUsage(state,event('unknown',{inputTokens:null,outputTokens:null,totalTokens:null,cachedInputTokens:null}));
  let totals=report(state).totals;
  assert.equal(totals.requests,1);assert.equal(totals.inputTokens,null);assert.equal(totals.outputTokens,null);assert.equal(totals.totalTokens,null);assert.equal(totals.unknownUsageRequests,1);assert.equal(totals.unpricedRequests,1);assert.deepEqual(totals.estimatedCosts,{});
  C.recordUsage(state,event('zero',{inputTokens:0,outputTokens:0,totalTokens:0,cachedInputTokens:0}));
  totals=report(state).totals;assert.equal(totals.inputTokens,0);assert.equal(totals.estimatedCosts.CNY,0);assert.equal(totals.partial,true);
});

test('cached tokens are an input subset and pricing is frozen per event despite later edits', () => {
  const state=C.initial();price(state);
  const saved=C.recordUsage(state,event('cached',{cachedInputTokens:400})).event;
  assert.equal(saved.cost,0.0024);assert.equal(saved.costPartial,false);assert.equal(saved.totalTokens,1200);
  price(state,{inputPerMillion:100,outputPerMillion:100,cachedInputPerMillion:100});
  const recent=report(state).recent[0];assert.equal(recent.cost,0.0024);assert.equal(recent.pricing.inputPerMillion,2);assert.equal(report(state).totals.totalTokens,1200);
});

test('unknown cache splits or cache prices use standard input price and label incomplete estimates', () => {
  const state=C.initial();price(state,{cachedInputPerMillion:null});
  let result=C.recordUsage(state,event('missing-cache-price',{cachedInputTokens:400})).event;
  assert.equal(result.cost,0.003);assert.equal(result.costPartial,true);assert.equal(result.pricing.cachedInputPerMillion,null);
  result=C.recordUsage(state,event('missing-cache-count',{cachedInputTokens:null})).event;
  assert.equal(result.cost,0.003);assert.equal(result.costPartial,true);
  const totals=report(state).totals;assert.equal(totals.costPartialRequests,2);assert.equal(totals.unpricedRequests,0);assert.equal(totals.partial,true);
});

test('prices are independent by canonical endpoint and model, and currencies are never combined', () => {
  const state=C.initial();price(state,{baseUrl:'https://model.example/v1/chat/completions/',currency:'USD'});
  price(state,{baseUrl:'https://other.example/v1',currency:'EUR',inputPerMillion:3});
  C.recordUsage(state,event('usd'));C.recordUsage(state,event('eur',{baseUrl:'https://other.example/v1'}));
  C.recordUsage(state,event('unpriced-model',{model:'other-model'}));
  const result=report(state);assert.equal(result.models.length,3);assert.equal(result.totals.unpricedRequests,1);assert.deepEqual(result.totals.estimatedCosts,{USD:0.003,EUR:0.004});
  assert.equal(result.pricing.length,2);assert.equal(result.pricing[0].baseUrl,'https://model.example/v1');
});

test('empty prices stay null, invalid values reject atomically and safe metadata alone is retained', () => {
  const state=C.initial();const saved=price(state,{inputPerMillion:' ',outputPerMillion:'0',cachedInputPerMillion:''});
  assert.equal(saved.inputPerMillion,null);assert.equal(saved.outputPerMillion,0);assert.equal(saved.cachedInputPerMillion,null);
  const before=structuredClone(state.modelPrices);
  for(const value of [Infinity,NaN,-1,true,{},'1e100',1e20])assert.throws(()=>price(state,{inputPerMillion:value}));
  assert.deepEqual(state.modelPrices,before);assert.throws(()=>price(state,{currency:'__proto__'}));assert.throws(()=>price(state,{baseUrl:'https://model.example/v1?api_key=secret'}));
  const input=event('__proto__',{apiKey:'DO_NOT_SAVE',messages:['DO_NOT_SAVE'],rawError:'DO_NOT_SAVE',reasoningTokens:999999});
  C.recordUsage(state,input);assert.equal(JSON.stringify(state.usage).includes('DO_NOT_SAVE'),false);assert.equal(JSON.stringify(state.usage).includes('reasoningTokens'),false);assert.equal({}.polluted,undefined);
  const inherited=Object.create(event('inherited'));assert.throws(()=>C.recordUsage(state,inherited));
});

test('invalid token magnitudes become unknown, impossible cache counts are not added and totals do not overflow', () => {
  const state=C.initial();price(state);
  const invalid=C.recordUsage(state,event('invalid',{inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:Infinity,totalTokens:-1,cachedInputTokens:'10'})).event;
  assert.equal(invalid.inputTokens,null);assert.equal(invalid.outputTokens,null);assert.equal(invalid.totalTokens,null);assert.equal(invalid.cost,null);
  const cache=C.recordUsage(state,event('cache-over-input',{cachedInputTokens:2000})).event;
  assert.equal(cache.cachedInputTokens,null);assert.equal(cache.totalTokens,1200);assert.equal(cache.cost,0.003);assert.equal(cache.costPartial,true);
  const maximum=C.recordUsage(state,event('large-valid',{inputTokens:1e9,outputTokens:1e9,totalTokens:null,cachedInputTokens:0})).event;
  assert.equal(maximum.totalTokens,2e9);assert.ok(Number.isFinite(maximum.cost));assert.ok(Number.isSafeInteger(report(state).totals.totalTokens));
  assert.throws(()=>C.recordUsage(state,event('future',{at:Date.now()+60000})));
});

test('daily aggregates and event idempotence survive recent trimming and serialized restart', () => {
  const state=C.initial();price(state);
  for(let i=0;i<135;i++)C.recordUsage(state,event('record-'+i,{at:now-i}));
  assert.equal(state.usage.recent.length,100);assert.equal(report(state).totals.requests,135);
  assert.equal(report(state).totals.totalTokens,135*1200);
  const restarted=JSON.parse(JSON.stringify(state));const retry=C.recordUsage(restarted,event('record-134',{at:now-134}));
  assert.equal(retry.recorded,false);assert.equal(report(restarted).totals.requests,135);assert.equal(restarted.usage.recent.length,100);
});

test('day buckets retain more than 90 days while selectable reports use local natural days', () => {
  const state=C.initial();
  for(let age=0;age<=100;age++)C.recordUsage(state,event('day-'+age,{at:now-age*86400000}));
  assert.equal(state.usage.daily.length,101);
  assert.equal(C.usageReport(state,{days:1,now:now+500}).totals.requests,1);
  assert.equal(C.usageReport(state,{days:7,now:now+500}).totals.requests,7);
  assert.equal(report(state).totals.requests,30);
  const ignored=C.recordUsage(state,event('very-old',{at:now-130*86400000}));assert.equal(ignored.recorded,false);assert.equal(state.usage.daily.length,101);
  assert.throws(()=>C.usageReport(state,{days:365}));
});

test('forecast waits at least 24 hours and keeps unknown data and per-currency costs explicit', () => {
  const state=C.initial();price(state,{currency:'USD'});
  C.recordUsage(state,event('first',{at:now-23*3600000}));
  assert.equal(report(state).forecast.available,false);assert.equal(report(state).forecast.totals,null);
  C.recordUsage(state,event('older',{at:now-2*86400000}));
  C.recordUsage(state,event('unknown',{inputTokens:null,outputTokens:null,totalTokens:null,cachedInputTokens:null}));
  const forecast=report(state).forecast;assert.equal(forecast.available,true);assert.ok(forecast.basisDays>=2&&forecast.basisDays<2.01);assert.equal(forecast.basisRequests,3);assert.equal(forecast.partial,true);assert.ok(forecast.totals.estimatedCosts.USD>0);assert.equal(forecast.totals.estimatedCosts.CNY,undefined);
});

test('request-time internal price snapshots survive in-flight edits and cannot be supplied through provider events',()=>{
  const state=C.initial(),startedPrice=price(state);
  price(state,{inputPerMillion:100,outputPerMillion:100,cachedInputPerMillion:100});
  const stored=C.recordUsage(state,event('in-flight'),{pricing:startedPrice}).event;
  assert.equal(stored.cost,0.003);assert.equal(stored.pricing.inputPerMillion,2);
  const unconfigured=C.recordUsage(state,event('unconfigured-at-start'),{pricing:null}).event;
  assert.equal(unconfigured.cost,null);assert.equal(unconfigured.pricing,null);
  const injected=C.recordUsage(state,event('event-pricing',{pricing:startedPrice})).event;
  assert.equal(injected.pricing.inputPerMillion,100);
  const before=structuredClone(state.usage);
  for(const pricing of [{...startedPrice,model:'wrong-model'},{...startedPrice,baseUrl:'https://other.example/v1'},{...startedPrice,apiKey:'NOT_ALLOWED'},{...startedPrice,inputPerMillion:Infinity}])assert.throws(()=>C.recordUsage(state,event('invalid-snapshot'),{pricing}));
  assert.deepEqual(state.usage,before);
});
