const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const {spawn} = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const ORIGIN = 'chrome-extension://' + 'a'.repeat(32);
const otherOrigin = 'chrome-extension://' + 'b'.repeat(32);
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-out-lifecycle-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  return dir;
}
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function launcher(dir, port, arg = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/start.mjs', ...(arg ? [arg] : [])], {
      cwd:ROOT, env:{...process.env, TASK_OUT_PORT:String(port), TASK_OUT_DATA_DIR:dir}, stdio:['ignore','pipe','pipe']
    });
    let output = '';
    child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    child.once('error', reject); child.once('close', code => resolve({code, output}));
  });
}
async function request(port, route, {method='GET', token, origin=ORIGIN, body}={}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {method,
    headers:{...(origin ? {Origin:origin} : {}), ...(token ? {Authorization:`Bearer ${token}`} : {}), ...(body ? {'Content-Type':'application/json'} : {})},
    ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(3000)});
  return {status:response.status, value:await response.json()};
}

test('background launcher exits while service survives; reuse, private pairing state and CLI stop/restart preserve identity', async t => {
  const dir = await directory(t), port = await freePort();
  const runtimePath = path.join(dir, `service-${port}.json`);
  t.after(async () => {
    await launcher(dir, port, '--stop');
  });
  const first = await launcher(dir, port);
  assert.equal(first.code, 0, first.output);
  assert.match(first.output, /现在可以关闭终端窗口/);
  let runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));
  const firstRunId = runtime.runId;
  const health = (await request(port, '/health', {origin:null})).value;
  assert.equal(health.mode, 'background'); assert.equal(health.runId, firstRunId);
  assert.equal(health.pairingCode, undefined);
  assert.equal((await fs.stat(runtimePath)).mode & 0o777, 0o600);
  const repeated = await Promise.all([launcher(dir, port), launcher(dir, port)]);
  for (const result of repeated) { assert.equal(result.code, 0); assert.match(result.output, /继续使用现有服务/); }
  assert.equal(JSON.parse(await fs.readFile(runtimePath, 'utf8')).pid, runtime.pid);
  const pairingCode = runtime.pairingCode;
  const {token} = (await request(port, '/pair', {method:'POST', body:{code:pairingCode}})).value;
  assert.equal(typeof token, 'string');
  assert.equal(JSON.parse(await fs.readFile(runtimePath, 'utf8')).pairingCode, undefined);
  const log = await fs.readFile(path.join(dir, 'service.log'), 'utf8');
  assert.equal(log.includes(pairingCode), false); assert.equal(log.includes(token), false);
  const restart = await launcher(dir, port, '--restart'); assert.equal(restart.code, 0, restart.output);
  runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));
  assert.notEqual(runtime.runId, firstRunId); assert.equal(runtime.instanceId, health.instanceId);
  assert.equal((await request(port, '/v1/service', {token})).value.canStop, true);
  const stopped = await launcher(dir, port, '--stop'); assert.equal(stopped.code, 0, stopped.output);
  await assert.rejects(() => request(port, '/health'));
  await assert.rejects(() => fs.stat(runtimePath), {code:'ENOENT'});
});

test('CLI refuses to stop a live service using a stale or unrelated runtime identity', async t => {
  const dir = await directory(t), {startServer} = await import('../service/server.mjs');
  const running = await startServer({port:0, dataDir:dir, polling:false}); t.after(() => running.close());
  await fs.writeFile(path.join(dir, `service-${running.port}.json`), JSON.stringify({pid:process.pid, runId:'stale', instanceId:running.store.instanceId}));
  const result = await launcher(dir, running.port, '--stop');
  assert.equal(result.code, 1); assert.match(result.output, /无法确认/);
  assert.equal((await request(running.port, '/health', {origin:null})).value.name, 'Task Out');
});

test('a legacy foreground service is reused without claiming it is already detached', async t => {
  const dir = await directory(t);
  const server = http.createServer((_request, response) => { response.setHeader('Content-Type','application/json'); response.end(JSON.stringify({name:'Task Out',version:'1.0.0',paired:true})); });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const result = await launcher(dir, server.address().port);
  assert.equal(result.code,0,result.output);
  assert.match(result.output,/继续使用现有服务/);
  assert.match(result.output,/旧版或前台模式/);
  assert.doesNotMatch(result.output,/现在可以关闭终端窗口/);
});

test('HTTP stop requires paired extension, drains accepted writes, preserves cached data and tokens', async t => {
  const dir = await directory(t), {startServer} = await import('../service/server.mjs');
  const running = await startServer({port:0, dataDir:dir, pairingCode:'12345678', polling:false}); t.after(() => running.close());
  assert.equal((await request(running.port, '/v1/service/stop', {method:'POST', body:{}, origin:null})).status, 403);
  assert.equal((await request(running.port, '/v1/service/stop', {method:'POST', body:{}})).status, 401);
  const {token} = (await request(running.port, '/pair', {method:'POST', body:{code:'12345678'}})).value;
  assert.equal((await request(running.port, '/v1/service/stop', {method:'POST', body:{}, token, origin:'https://example.com'})).status, 403);
  assert.equal((await request(running.port, '/v1/service/stop', {method:'POST', body:{}, token, origin:otherOrigin})).status, 401);
  const root = path.join(dir, 'sessions'); await fs.mkdir(root);
  let pending;
  const completed = new Promise((resolve,reject) => {
    pending = http.request({host:'127.0.0.1', port:running.port, path:'/v1/connections', method:'POST',
      headers:{Origin:ORIGIN, Authorization:`Bearer ${token}`, 'Content-Type':'application/json'}}, response => {
      let body=''; response.on('data', part => body += part); response.on('end', () => resolve({status:response.statusCode, value:JSON.parse(body)}));
    });
    pending.on('error',reject); pending.write('{');
  });
  // Seeing the first body byte on the server guarantees the request is accepted
  // before stop; it may finish writing after the stop acknowledgement.
  await new Promise(resolve => running.server.once('request', req => { if(req.url==='/v1/connections') req.once('data',resolve); }));
  assert.equal((await request(running.port, '/v1/service/stop', {method:'POST', token, body:{}})).status, 200);
  pending.end(JSON.stringify({connectorId:'codex-rollout', root, name:'Fixture', enabled:false}).slice(1));
  assert.equal((await completed).status,201);
  await running.close();
  const restarted = await startServer({port:0, dataDir:dir, polling:false}); t.after(() => restarted.close());
  const connections = await request(restarted.port, '/v1/connections', {token});
  assert.equal(connections.status,200); assert.equal(connections.value.connections.length,1);
  assert.equal(connections.value.connections[0].name,'Fixture');
});
