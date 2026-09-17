/* Completion feedback is independent of persistence and never owns real rows. */
(() => {
  'use strict';
  const colors=['#c8713a','#e8a070','#5a7a62','#8aaa92','#5a6b7a','#8a9baa','#d4b896','#b35a5a'];
  function prepare(ids,root=document) {
    const selected=new Set(ids),reduced=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const captured=[];
    if(!reduced)for(const card of root.querySelectorAll('.project-card, .unassigned-items')) {
      const bounds=card.classList?.contains('unassigned-items')?card.getBoundingClientRect():null;
      const rows=[...card.querySelectorAll('[data-record-id]')];
      const targets=rows.filter(row=>selected.has(row.dataset.recordId));
      if(!targets.length)continue;
      const capture=(node,recordIds,group=false)=>{
        const rect=node.getBoundingClientRect();
        if(rect.width<=0||rect.height<=0||rect.bottom<0||rect.top>globalThis.innerHeight) return null;
        // The unassigned tray scrolls independently. Never animate hidden rows
        // outside its viewport or make clipped content reappear over projects.
        const visible=bounds?{left:Math.max(rect.left,bounds.left),top:Math.max(rect.top,bounds.top),right:Math.min(rect.right,bounds.right),bottom:Math.min(rect.bottom,bounds.bottom)}:null;
        if(visible&&(visible.right<=visible.left||visible.bottom<=visible.top))return null;
        const clone=node.cloneNode(true);clone.removeAttribute('id');
        clone.querySelectorAll('[id]').forEach(child=>child.removeAttribute('id'));
        clone.setAttribute('aria-hidden','true');clone.inert=true;
        Object.assign(clone.style,{position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',margin:'0',zIndex:'200',pointerEvents:'none',background:'var(--card, #fffdfa)',overflow:'hidden',boxSizing:'border-box'});
        if(visible)clone.style.clipPath=`inset(${visible.top-rect.top}px ${rect.right-visible.right}px ${rect.bottom-visible.bottom}px ${visible.left-rect.left}px)`;
        return {clone,rect:visible?{...visible,width:visible.right-visible.left,height:visible.bottom-visible.top}:rect,recordIds,group};
      };
      const whole=!bounds&&rows.every(row=>selected.has(row.dataset.recordId))?capture(card,rows.map(row=>row.dataset.recordId),true):null;
      captured.push({whole,rows:targets.map(row=>capture(row,[row.dataset.recordId])).filter(Boolean)});
    }
    // WebAudio must be resumed in the original click, before the worker round-trip.
    let context;
    try {const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;if(Audio){context=new Audio();context.resume()?.catch(()=>{});}}catch{}
    const close=()=>{try{context?.close()?.catch(()=>{});}catch{}};
    let finished=false;
    return {
      cancel(){if(finished)return;finished=true;close();},
      finish(successIds){
        if(finished)return;finished=true;
        const success=new Set(successIds.filter(id=>selected.has(id)));
        if(!success.size){close();return;}
        if(context)try{
          const duration=.25,buffer=context.createBuffer(1,Math.floor(context.sampleRate*duration),context.sampleRate),data=buffer.getChannelData(0);
          for(let i=0;i<data.length;i++){const t=i/data.length;data[i]=(Math.random()*2-1)*(t<.1?t/.1:Math.pow((1-t)/.9,1.5));}
          const noise=context.createBufferSource(),filter=context.createBiquadFilter(),gain=context.createGain(),now=context.currentTime;
          noise.buffer=buffer;filter.type='bandpass';filter.Q.value=2;filter.frequency.setValueAtTime(4000,now);filter.frequency.exponentialRampToValueAtTime(400,now+duration);
          gain.gain.setValueAtTime(.15,now);gain.gain.exponentialRampToValueAtTime(.001,now+duration);
          noise.connect(filter);filter.connect(gain);gain.connect(context.destination);noise.start(now);setTimeout(close,600);
        }catch{close();}
        let layer;
        for(const entry of captured){
          const targets=entry.whole&&entry.whole.recordIds.every(id=>success.has(id))?[entry.whole]:entry.rows.filter(row=>success.has(row.recordIds[0]));
          for(const {clone,rect,group} of targets){
            if(!layer){
              // A batch action can originate in a native dialog. Use a manual
              // popover so feedback stays visible without closing that dialog.
              layer=document.createElement('div');layer.setAttribute('popover','manual');layer.setAttribute('aria-hidden','true');layer.inert=true;
              Object.assign(layer.style,{position:'fixed',inset:'0',margin:'0',padding:'0',width:'100vw',height:'100dvh',border:'0',background:'transparent',overflow:'visible',pointerEvents:'none',zIndex:'200'});
              document.body.append(layer);try{if(layer.showPopover)layer.showPopover();else layer.removeAttribute('popover');}catch{layer.removeAttribute('popover');}
              const mounted=layer;setTimeout(()=>mounted.remove(),1100);
            }
            layer.append(clone);
            const animation=clone.animate?.([{opacity:1,transform:'scale(1)'},{opacity:0,transform:`scale(${group?.9:.8})`}],{duration:group?250:200,easing:'ease',fill:'forwards'});
            if(animation)animation.finished.catch(()=>{}).finally(()=>clone.remove());
            setTimeout(()=>clone.remove(),350);
            confetti(rect.left+rect.width/2,rect.top+rect.height/2,layer);
          }
        }
      }
    };
  }
  function confetti(x,y,layer){
    for(let i=0;i<17;i++){
      const particle=document.createElement('i'),size=5+Math.random()*6,angle=Math.random()*Math.PI*2,velocity=60+Math.random()*120,duration=700+Math.random()*200;
      const vx=Math.cos(angle)*velocity,vy=Math.sin(angle)*velocity-80,rotation=Math.random()*360;
      Object.assign(particle.style,{position:'fixed',left:x+'px',top:y+'px',width:size+'px',height:size+'px',background:colors[i%colors.length],borderRadius:Math.random()<.5?'50%':'2px',pointerEvents:'none',zIndex:'201'});
      particle.setAttribute('aria-hidden','true');layer.append(particle);
      const seconds=duration/1000,frames=Array.from({length:11},(_,n)=>{const t=n/10,s=t*seconds;return {offset:t,opacity:t<.5?1:(1-t)*2,transform:`translate(${vx*s}px,${vy*s+100*s*s}px) rotate(${rotation+t*360}deg)`};});
      const animation=particle.animate?.(frames,{duration,easing:'linear',fill:'forwards'});
      if(animation)animation.finished.catch(()=>{}).finally(()=>particle.remove());
      setTimeout(()=>particle.remove(),1000);
    }
  }
  globalThis.TaskOutArchiveEffects={prepare};
})();
