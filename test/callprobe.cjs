const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { finishTest, mcpSession, sleep } = require('./support.cjs');

const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-callprobe-'));
const STATE = path.join(PROJ, '.playwriter');
const STOP_MS = 3500;

const readPort = (name) => Number(fs.readFileSync(path.join(STATE, name), 'utf8'));
const gateLog = () => fs.readFileSync(path.join(STATE, 'gate.log'), 'utf8');
const get = (port, urlPath, timeout) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      body += chunk;
    });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject);
  req.on('timeout', () => req.destroy(new Error(`${urlPath} timed out on port ${port}`)));
});
const openLease = (port) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/__pwp/lease' }, (res) => {
    res.resume();
    resolve(req);
  });
  req.on('error', reject);
});
const waitFor = async (check, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check().catch(() => null);
    if (value) return value;
    await sleep(200);
  }
  return null;
};
const listenerPid = (port) => {
  const out = execFileSync('ss', ['-H', '-ltnp', 'sport', '=', `:${port}`], { encoding: 'utf8' });
  const pid = Number(/pid=(\d+)/.exec(out)?.[1]);
  assert.ok(pid, `a process listens on port ${port}: ${out.trim() || 'nothing'}`);
  return pid;
};

let stopped = null;
const resume = () => {
  if (stopped === null) return;
  try {
    process.kill(stopped, 'SIGCONT');
  } catch {}
  stopped = null;
};

(async () => {
  const session = mcpSession(PROJ);
  let lease = null;
  try {
    await session.initialize();
    assert.match(await session.exec("return 'first'"), /first/, 'the first call starts the gate and the browser');
    const gate = await waitFor(async () => (fs.existsSync(path.join(STATE, 'port')) ? readPort('port') : null), 10000);
    assert.ok(gate, 'the gate writes its port');
    lease = await openLease(gate);
    const started = await waitFor(async () => {
      const status = JSON.parse((await get(gate, '/__pwp/status?pages=0', 5000)).body);
      return status.browser.running && status.leases >= 1 ? status : null;
    }, 20000);
    assert.ok(started, 'the gate holds a lease and reports a running browser');
    const pid = listenerPid(started.debugPort);

    const mark = gateLog().length;
    stopped = pid;
    process.kill(pid, 'SIGSTOP');
    const timer = setTimeout(resume, STOP_MS);
    let during;
    try {
      during = await get(gate, '/json/version', 30000);
    } finally {
      clearTimeout(timer);
      resume();
    }

    const after = gateLog().slice(mark);
    assert.doesNotMatch(after, /stopped answering/, 'one missed probe during a request does not restart the browser');
    assert.doesNotMatch(after, /browser started/, 'no second browser is started');
    assert.doesNotMatch(after, /went away/, 'one missed probe does not mark the browser gone');
    assert.match(after, /probe failed 1\/3/, 'the missed probe is logged as one miss');
    assert.equal(during.status, 200, 'the request made during the stop is answered');
    assert.match(during.body, /webSocketDebuggerUrl/, 'the answer is the browser version');
    assert.equal(listenerPid(started.debugPort), pid, 'the same browser answers on the debug port');
    console.log('ok: one missed probe during a request is logged as one miss; the browser is not restarted and the request is answered');

    lease.destroy();
    await session.end();
    await finishTest('callprobe');
    fs.rmSync(PROJ, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    console.log('callprobe: all checks passed');
    process.exit(0);
  } catch (error) {
    resume();
    lease?.destroy();
    session.stop();
    await finishTest('callprobe').catch(() => {});
    console.error(`callprobe: FAILED: ${error.message}`);
    console.error(`project kept for inspection: ${PROJ}`);
    process.exit(1);
  }
})();
