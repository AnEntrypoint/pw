const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { finishTest, mcpSession, sleep } = require('./support.cjs');

const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-live-browser-'));
const STATE = path.join(PROJ, '.playwriter');
const GATE_LOG = path.join(STATE, 'gate.log');
const STOP_MS = 15000;

const readPort = (name) => Number(fs.readFileSync(path.join(STATE, name), 'utf8'));
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
const count = (text, pattern) => (text.match(pattern) ?? []).length;

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
    const pid = started.browser.pid;
    assert.ok(pid, 'the gate records the browser pid');

    const mark = fs.readFileSync(GATE_LOG, 'utf8').length;
    stopped = pid;
    process.kill(pid, 'SIGSTOP');
    const timer = setTimeout(resume, STOP_MS);
    let during;
    try {
      during = await get(gate, '/json/version', 60000);
    } finally {
      clearTimeout(timer);
      resume();
    }

    const after = JSON.parse((await get(gate, '/__pwp/status?pages=0', 5000)).body);
    const text = fs.readFileSync(GATE_LOG, 'utf8').slice(mark);
    const misses = count(text, /probe failed \d\/3|is alive after 3 failed probes|went away after 3 failed probes/g);
    assert.ok(misses >= 3, `the stopped browser (pid ${pid}) missed its probes: ${misses} miss lines in the gate log`);
    assert.equal(count(text, /went away/g), 0, `the gate forgot the live browser (pid ${pid}) after its probes missed`);
    assert.equal(during.status, 200, 'the request made during the stop is answered');
    assert.match(during.body, /webSocketDebuggerUrl/, 'the answer is the browser version');
    assert.equal(after.browser.running, true, 'the browser answers after the stop');
    assert.equal(after.browser.pid, pid, 'the same live browser answers after the stop');
    assert.equal(count(fs.readFileSync(GATE_LOG, 'utf8'), /browser started pid=/g), 1, 'the browser is started once');
    console.log(`live-browser: ok: browser pid ${pid} kept through ${misses} missed probe lines; the request made during the stop was answered`);

    process.kill(pid, 'SIGKILL');
    const restarted = await get(gate, '/json/version', 60000);
    const next = JSON.parse((await get(gate, '/__pwp/status?pages=0', 5000)).body);
    const dead = fs.readFileSync(GATE_LOG, 'utf8').slice(mark);
    assert.match(dead, new RegExp(`went away after 3 failed probes; pid ${pid} is dead`), 'the gate forgets a browser whose pid is dead');
    assert.equal(restarted.status, 200, 'the request after the browser died is answered by a new browser');
    assert.notEqual(next.browser.pid, pid, 'the new browser has a new pid');
    assert.equal(count(fs.readFileSync(GATE_LOG, 'utf8'), /browser started pid=/g), 2, 'the new browser is started once');
    console.log(`live-browser: ok: browser pid ${pid} killed; the gate forgot it and started pid ${next.browser.pid}`);

    lease.destroy();
    await session.end();
    await finishTest('live-browser');
    fs.rmSync(PROJ, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    console.log('live-browser: all checks passed');
    process.exit(0);
  } catch (error) {
    resume();
    lease?.destroy();
    session.stop();
    await finishTest('live-browser').catch(() => {});
    console.error(`live-browser: FAILED: ${error.message}`);
    console.error(`gate log: ${GATE_LOG}`);
    console.error(`project kept for inspection: ${PROJ}`);
    process.exit(1);
  }
})();
