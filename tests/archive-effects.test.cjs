const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function fixture({reduced=false,noAudio=false}={}){
  const events=[],appended=[],animations=[],timers=[];
  const clone=label=>({label,style:{},removeAttribute(){},setAttribute(){},querySelectorAll:()=>[],append(node){appended.push(node);},showPopover(){events.push('top-layer');},remove(){events.push('remove:'+label);},animate(frames,options){animations.push({label,frames,options});return {finished:Promise.resolve()};}});
  const row=id=>({dataset:{recordId:id},getBoundingClientRect:()=>({left:10,top:20,width:200,height:70,bottom:90}),cloneNode:()=>clone(id)});
  const rows=[row('a'),row('b')];
  const card={querySelectorAll:()=>rows,getBoundingClientRect:()=>({left:5,top:15,width:210,height:160,bottom:175}),cloneNode:()=>clone('card')};
  class Audio{
    constructor(){this.sampleRate=1000;this.currentTime=2;this.destination={};events.push('audio-create');}
    resume(){events.push('resume');return Promise.resolve();}
    close(){events.push('audio-close');return Promise.resolve();}
    createBuffer(channels,length){return {getChannelData:()=>new Float32Array(length)};}
    createBufferSource(){return {connect(){},start(){events.push('sound');}};}
    createBiquadFilter(){return {Q:{value:0},frequency:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}};}
    createGain(){return {gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}};}
  }
  const context={Set,Math,AudioContext:noAudio?undefined:Audio,innerHeight:800,matchMedia:()=>({matches:reduced}),
    setTimeout(fn,ms){timers.push({fn,ms});},document:{querySelectorAll:()=>[card],createElement:tag=>clone(tag==='div'?'layer':'particle'),body:{append(node){events.push('mount:'+node.label);}}}};
  vm.createContext(context);vm.runInContext(fs.readFileSync('extension/archive-effects.js','utf8'),context);
  return {effects:context.TaskOutArchiveEffects,events,appended,animations,timers};
}
test('archive gesture resumes audio but produces no sound or visible completion before persistence succeeds',()=>{
  const app=fixture(),prepared=app.effects.prepare(['a','b']);
  assert.deepEqual(app.events,['audio-create','resume']);assert.equal(app.appended.length,0);
  prepared.cancel();assert.equal(app.events.includes('sound'),false);assert.equal(app.events.at(-1),'audio-close');
  prepared.finish(['a']);assert.equal(app.appended.length,0);
});
test('partial archive animates only successful row snapshots even after the real rows disappear',()=>{
  const app=fixture(),prepared=app.effects.prepare(['a','b']);prepared.finish(['a']);
  assert.equal(app.events.filter(event=>event==='sound').length,1);
  assert.deepEqual(app.appended.filter(node=>node.label!=='particle').map(node=>node.label),['a']);
  assert.equal(app.appended.filter(node=>node.label==='particle').length,17);
  assert.equal(app.animations.find(animation=>animation.label==='a').options.duration,200);
  prepared.finish(['b']);assert.equal(app.appended.length,18);
  for(const timer of app.timers)timer.fn();assert.ok(app.events.includes('audio-close'));assert.ok(app.events.includes('remove:a'));
});
test('successful whole-group archive uses the original 250ms shrinking card and one confetti burst',()=>{
  const app=fixture();app.effects.prepare(['a','b']).finish(['a','b']);
  assert.deepEqual(app.appended.filter(node=>node.label!=='particle').map(node=>node.label),['card']);
  assert.equal(app.appended.length,18);assert.ok(app.events.includes('top-layer'));assert.equal(app.animations[0].options.duration,250);
  assert.equal(app.animations[0].frames[1].transform,'scale(0.9)');
});
test('failure results never celebrate and unrelated success IDs cannot trigger effects',()=>{
  const app=fixture();app.effects.prepare(['a']).finish(['unrelated']);
  assert.equal(app.appended.length,0);assert.equal(app.events.includes('sound'),false);assert.ok(app.events.includes('audio-close'));
});
test('reduced motion skips snapshots and confetti while retaining successful sound feedback',()=>{
  const app=fixture({reduced:true});app.effects.prepare(['a']).finish(['a']);
  assert.equal(app.appended.length,0);assert.equal(app.events.filter(event=>event==='sound').length,1);
});
test('unavailable WebAudio does not stop visual completion feedback',()=>{
  const app=fixture({noAudio:true});app.effects.prepare(['a']).finish(['a']);assert.equal(app.appended.length,18);
});
