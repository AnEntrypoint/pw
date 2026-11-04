const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WRAPPER = path.join(ROOT, 'bin', 'playwriter-project');
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-test-'));
const STATE = path.join(PROJ, '.playwriter');
const IDLE_MS = 4000;
const ENV = { ...process.env, PLAYWRITER_PROJECT_DIR: PROJ, PLAYWRITER_IDLE_MS: String(IDLE_MS), PLAYWRITER_TELEMETRY: '0' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const httpOk = (port, urlPath) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 3000 }, (res) => {
    res.resume();
    resolve(res.statusCode === 200);
  });
  req.on('error', () => resolve(false));
  req.on('timeout', () => {
    req.destroy();
    resolve(false);
  });
});
const readPort = (name) => Number(fs.readFileSync(path.join(STATE, name), 'utf8'));
const chromeUp = () => httpOk(readPort('debug-port'), '/json/version');
const gateUp = () => httpOk(readPort('port'), '/__pwp/ping');
const textOf = (msg) => (msg.result?.content ?? []).map((c) => c.text).join('') || JSON.stringify(msg);
const until = async (check, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(200);
  }
  return false;
};

function mcpClient() {
  const child = spawn(WRAPPER, [], { cwd: PROJ, env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiters = new Map();
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });
  const call = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method} ${id}`)), 90000);
    waiters.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const exec = (id, code) => call(id, 'tools/call', { name: 'execute', arguments: { code } }).then(textOf);
  return {
    child,
    call,
    exec,
    notify: (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`),
    close: () => child.stdin.end(),
  };
}

const cli = (args) => spawnSync(process.execPath, [WRAPPER, ...args], { cwd: PROJ, env: ENV, encoding: 'utf8', timeout: 120000 });

let checks = 0;
const check = (label) => {
  checks += 1;
  console.log(`ok ${checks}: ${label}`);
};

(async () => {
  const m = mcpClient();
  await m.call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  m.notify('notifications/initialized');
  const tools = await m.call(2, 'tools/list', {});
  assert.ok(tools.result.tools.some((tool) => tool.name === 'browsers'));
  await sleep(1500);
  assert.equal(await gateUp(), true);
  assert.equal(await chromeUp(), false);
  check('startup opens no browser');

  const set = await m.exec(3, "state.page ??= await context.newPage(); await state.page.goto('data:text/html,<title>keep</title>'); await context.addCookies([{ name: 'keep', value: 'yes', url: 'http://example.test/', expires: Math.floor(Date.now() / 1000) + 86400 }]); return 'set'");
  assert.match(set, /set/);
  assert.equal(await until(chromeUp), true);
  check('first tool call opens the browser');

  await sleep(IDLE_MS + 4000);
  assert.equal(await chromeUp(), false);
  assert.equal(fs.existsSync(path.join(STATE, 'browser-profile')), true);
  check('browser stops after idle and keeps its profile directory');

  const reuse = await m.exec(4, "return (await context.cookies('http://example.test/')).map((c) => c.name + '=' + c.value)");
  assert.match(reuse, /keep=yes/);
  assert.equal(await chromeUp(), true);
  check('same MCP session reconnects after idle and the cookie survived');

  const listed = JSON.parse((await m.call(5, 'tools/call', { name: 'browsers', arguments: { action: 'list' } })).result.content[0].text);
  assert.equal(listed.browsers.supported, true);
  check('browsers list reports the machine');

  const closed = JSON.parse((await m.call(6, 'tools/call', { name: 'browsers', arguments: { action: 'close', target: 'project' } })).result.content[0].text);
  assert.equal(closed.closed.length, 1);
  assert.equal(await chromeUp(), false);
  check('browsers close stops the project browser when no other lease is held');

  m.close();
  await sleep(IDLE_MS + 8000);
  assert.equal(await gateUp(), false);
  assert.equal(await chromeUp(), false);
  check('gate exits and the browser stays closed once the agent disconnects');

  const session = cli(['session']);
  const sid = /Session (\d+) created/.exec(`${session.stdout}${session.stderr}`)?.[1];
  assert.equal(session.status, 0, session.stderr);
  assert.ok(sid, 'session id');
  check('CLI session creation starts the gate');

  const first = cli(['-s', sid, '-e', "return 'cli-one'"]);
  assert.match(first.stdout, /cli-one/);
  check('CLI exec runs in the project browser');

  await sleep(IDLE_MS + 4000);
  assert.equal(await chromeUp(), false);
  check('CLI session browser stops after idle');

  const after = cli(['-s', sid, '-e', "return (await context.cookies('http://example.test/')).map((c) => c.name + '=' + c.value)"]);
  assert.match(after.stdout, /keep=yes/);
  check('CLI session reconnects after idle and the cookie survived');

  await sleep(IDLE_MS + 8000);
  assert.equal(await chromeUp(), false);
  assert.equal(await gateUp(), false);
  check('everything is stopped at the end');

  spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'playwriter', 'bin.js'), 'session', 'delete', sid], { env: ENV, encoding: 'utf8' });
  console.log(`lifecycle: ${checks} checks passed`);
})()
  .then(() => {
    fs.rmSync(PROJ, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((error) => {
    console.error(`lifecycle: FAILED: ${error.message}`);
    console.error(`project kept for inspection: ${PROJ}`);
    process.exit(1);
  });
