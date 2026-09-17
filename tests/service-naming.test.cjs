const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const ID='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const NOW=Date.now(),iso=n=>new Date(NOW+n).toISOString();
const jsonl=rows=>rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
const meta={type:'session_meta',timestamp:iso(-5000),payload:{id:ID,timestamp:iso(-5000),originator:'codex_cli_rs'}};
const user=text=>({type:'event_msg',timestamp:iso(-4000),payload:{type:'user_message',message:text}});
const assistant=text=>({type:'event_msg',timestamp:iso(-3000),payload:{type:'agent_message',message:text}});
async function fixture(t){
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'task-out-naming-')));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const root=path.join(dir,'sessions'),metadataRoot=path.join(dir,'metadata');
  await fs.mkdir(root);await fs.mkdir(metadataRoot);
  const file=path.join(root,`rollout-${ID}.jsonl`);
  await fs.writeFile(file,jsonl([meta,user('First meaningful request'),assistant('Latest meaningful response')]));
  const connection={id:'connection-1',connectorId:'codex-rollout',root,canonicalRoot:root,storageId:'test-store',historyDays:30,allowAI:true,includeSummary:true};
  return {dir,root,metadataRoot,file,connection};
}
async function database(dir,{name='Database session name',title='First meaningful request',first='First meaningful request',updated=NOW-1000,modern=true}={}){
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(path.join(dir,'state_5.sqlite'));
  db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,${modern?'name TEXT,':''}title TEXT,first_user_message TEXT,updated_at_ms INTEGER);`);
  if(modern)db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run(ID,name,title,first,updated);
  else db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run(ID,title,first,updated);
  return db;
}

test('Codex metadata needs explicit scope and resolves DB/index names by stable id and freshness',async t=>{
  const x=await fixture(t),{scan,connectorCatalog,discover}=await import('../service/connectors/registry.mjs');
  const db=await database(x.metadataRoot);t.after(()=>db.close());
  await fs.writeFile(path.join(x.metadataRoot,'session_index.jsonl'),jsonl([{id:ID,thread_name:'Older index name',updated_at:iso(-2000)},{id:OTHER,thread_name:'Unrelated private name',updated_at:iso(1000)}]));
  const unconfigured=(await scan(x.connection)).records[0];
  assert.equal(unconfigured.sourceTitle,'');assert.equal(unconfigured.titleBasis,'first-message');
  assert.equal(unconfigured.firstMessage,'First meaningful request');assert.equal(unconfigured.latestMessage,'Latest meaningful response');
  assert.equal(unconfigured.observations[0].includeNaming,false,'summary consent must not imply naming consent');
  const cfg={...x.connection,metadataRoot:x.metadataRoot,canonicalMetadataRoot:x.metadataRoot,includeNaming:true};
  const first=(await scan(cfg)).records[0];
  assert.equal(first.sourceTitle,'Database session name');assert.equal(first.titleBasis,'codex-db-name');
  assert.equal(first.observations[0].includeNaming,true);assert.equal(first.updatedAt,unconfigured.updatedAt);
  await fs.appendFile(path.join(x.metadataRoot,'session_index.jsonl'),jsonl([{id:ID,thread_name:'Newer index name',updated_at:iso(0)},{id:ID,thread_name:'Appended but stale name',updated_at:iso(-3000)}]));
  const next=(await scan(cfg)).records;
  assert.equal(next.length,1);assert.equal(next[0].sourceTitle,'Newer index name');assert.equal(next[0].titleBasis,'codex-index');
  assert.equal(next[0].updatedAt,first.updatedAt);assert.equal(next[0].id,first.id);
  const catalog=connectorCatalog().find(c=>c.id==='codex-rollout');
  assert.equal(catalog.configFields.find(f=>f.key==='metadataRoot').default,'');
  assert.equal(catalog.configFields.find(f=>f.key==='includeNaming').default,false);
  assert.ok(Array.isArray(catalog.metadataRootSuggestions));
  const candidates=await discover({connectorId:'codex-rollout',roots:[x.root]});
  assert.ok(Array.isArray(candidates[0].metadataRootSuggestions));assert.equal(candidates[0].metadataRoot,undefined);
});

test('modern raw prompt title is not a source name; legacy distinct single-line titles can be used',async t=>{
  const x=await fixture(t),{scan}=await import('../service/connectors/registry.mjs');
  let db=await database(x.metadataRoot,{name:'',title:'First meaningful request'});db.close();
  const cfg={...x.connection,metadataRoot:x.metadataRoot,canonicalMetadataRoot:x.metadataRoot};
  assert.equal((await scan(cfg)).records[0].sourceTitle,'');
  await fs.rm(path.join(x.metadataRoot,'state_5.sqlite'));
  db=await database(x.metadataRoot,{modern:false,title:'A concise legacy title'});t.after(()=>db.close());
  const legacy=(await scan(cfg)).records[0];
  assert.equal(legacy.sourceTitle,'A concise legacy title');assert.equal(legacy.titleBasis,'codex-db-title');
  db.prepare('UPDATE threads SET title=?').run('First meaningful request');
  assert.equal((await scan(cfg)).records[0].sourceTitle,'');
});

test('metadata directory/file symlink redirection cannot expand authorized naming scope',async t=>{
  const x=await fixture(t),{scan}=await import('../service/connectors/registry.mjs');
  const outside=path.join(x.dir,'outside');await fs.mkdir(outside);
  await fs.writeFile(path.join(outside,'session_index.jsonl'),jsonl([{id:ID,thread_name:'Outside name',updated_at:iso(0)}]));
  const cfg={...x.connection,metadataRoot:x.metadataRoot,canonicalMetadataRoot:x.metadataRoot};
  await fs.symlink(path.join(outside,'session_index.jsonl'),path.join(x.metadataRoot,'session_index.jsonl'));
  const fileAttempt=await scan(cfg);assert.equal(fileAttempt.records[0].sourceTitle,'');assert.ok(fileAttempt.warnings.length);
  await fs.rename(x.metadataRoot,x.metadataRoot+'-old');await fs.symlink(outside,x.metadataRoot);
  const directoryAttempt=await scan(cfg);assert.equal(directoryAttempt.records[0].sourceTitle,'');assert.equal(directoryAttempt.records[0].sourceNameChecked,false);
  assert.ok(directoryAttempt.warnings.length);
});

test('old cursors recover first message from approved DB metadata and keep the latest actual message',async t=>{
  const x=await fixture(t),{scan}=await import('../service/connectors/registry.mjs');
  const db=await database(x.metadataRoot,{first:'Original first message from approved metadata'});t.after(()=>db.close());
  const cursors=new Map(),options={loadCursor:key=>cursors.get(key),saveCursor:(key,cursor)=>cursors.set(key,structuredClone(cursor))};
  await scan(x.connection,options);
  for(const cursor of cursors.values()){
    delete cursor.state.namingVersion;delete cursor.state.firstMessage;delete cursor.state.latestMessage;
    cursor.state.timeline=cursor.state.timeline.slice(-1);
  }
  const followup={...user('Later followup must not become the first message'),timestamp:iso(0)};
  await fs.appendFile(x.file,jsonl([followup]));
  const record=(await scan({...x.connection,metadataRoot:x.metadataRoot,canonicalMetadataRoot:x.metadataRoot},options)).records[0];
  assert.equal(record.firstMessage,'Original first message from approved metadata');
  assert.equal(record.latestMessage,'Later followup must not become the first message');
  assert.equal([...cursors.values()][0].state.namingVersion,2);
  assert.equal([...cursors.values()][0].state.firstMessage,record.firstMessage);
});

test('Claude custom titles outrank messages, rename without changing activity, and preserve bounded first/latest context',async t=>{
  const x=await fixture(t),{scan}=await import('../service/connectors/registry.mjs');
  const file=path.join(x.root,ID+'.jsonl');await fs.rm(x.file);
  const row=(type,content,stamp)=>({type,sessionId:ID,entrypoint:'sdk-ts',timestamp:stamp,message:{role:type,content}});
  await fs.writeFile(file,jsonl([row('user','first'.repeat(400),iso(-3000)),{type:'custom-title',sessionId:ID,customTitle:'Real Claude title',timestamp:iso(-2000)},row('assistant','latest'.repeat(400),iso(-1000))]));
  const cfg={...x.connection,connectorId:'claude-jsonl'},cursors=new Map(),options={loadCursor:key=>cursors.get(key),saveCursor:(key,cursor)=>cursors.set(key,structuredClone(cursor))};
  const first=(await scan(cfg,options)).records[0];
  assert.equal(first.sourceTitle,'Real Claude title');assert.equal(first.titleBasis,'claude-custom-title');
  assert.equal(first.firstMessage.length,1200);assert.equal(first.latestMessage.length,1200);
  await fs.appendFile(file,jsonl([{type:'custom-title',sessionId:ID,customTitle:'Renamed Claude title',timestamp:iso(0)}]));
  const renamed=(await scan(cfg,options)).records[0];
  assert.equal(renamed.sourceTitle,'Renamed Claude title');assert.equal(renamed.updatedAt,first.updatedAt);assert.equal(renamed.firstMessage,first.firstMessage);
  for(const cursor of cursors.values()){delete cursor.state.namingVersion;delete cursor.state.sourceTitle;delete cursor.state.firstMessage;delete cursor.state.latestMessage;delete cursor.state.sourceTitleSeen;}
  const upgraded=(await scan(cfg,options)).records[0];
  assert.equal(upgraded.sourceTitle,'Renamed Claude title');assert.equal(upgraded.firstMessage,first.firstMessage);
});

test('cache merge propagates name-only changes without replacing activity or losing first/latest evidence',async t=>{
  const x=await fixture(t),{Store}=await import('../service/store.mjs'),{scan}=await import('../service/connectors/registry.mjs');
  const store=new Store(path.join(x.dir,'cache'));t.after(()=>store.close());
  const raw=(await scan(x.connection)).records[0];
  store.mergeRecord({...raw,sourceTitle:'Previous name',title:'Previous name',sourceTitleUpdatedAt:NOW-1000,sourceNameChecked:true,titleBasis:'codex-db-name'});
  const merged=store.mergeRecord({...raw,title:'New source name',sourceTitle:'New source name',sourceTitleUpdatedAt:NOW,sourceNameChecked:true,titleBasis:'codex-index',timeline:raw.timeline.slice(-1)});
  assert.equal(merged.title,'New source name');assert.equal(merged.sourceTitle,'New source name');assert.equal(merged.updatedAt,raw.updatedAt);
  assert.equal(merged.firstMessage,raw.firstMessage);assert.equal(merged.latestMessage,raw.latestMessage);
  const stale=store.mergeRecord({...raw,sourceTitle:'Stale replica name',sourceTitleUpdatedAt:NOW-2000,sourceNameChecked:true});
  assert.equal(stale.sourceTitle,'New source name');
  const unavailable=store.mergeRecord({...raw,sourceTitle:'',sourceNameChecked:false});
  assert.equal(unavailable.sourceTitle,'New source name');
});

test('an incomplete name index does not certify missing names or promise unsupported continuation',async t=>{
  const x=await fixture(t),{readCodexNames}=await import('../service/connectors/codex-names.mjs');
  const row=JSON.stringify({id:OTHER,thread_name:'Unrelated synthetic title',padding:'x'.repeat(32000)})+'\n';
  await fs.writeFile(path.join(x.metadataRoot,'session_index.jsonl'),row.repeat(530)+JSON.stringify({id:ID,thread_name:'Beyond the first budget',updated_at:iso(0)})+'\n');
  const cfg={...x.connection,metadataRoot:x.metadataRoot,canonicalMetadataRoot:x.metadataRoot};
  const result=await readCodexNames(cfg,[ID]);
  assert.equal(result.checked,false);assert.equal(result.names.has(ID),false);
  assert.ok(result.warnings.some(w=>w.includes('16 MB')));
  assert.equal(result.warnings.some(w=>w.includes('下次同步继续')),false);
});
