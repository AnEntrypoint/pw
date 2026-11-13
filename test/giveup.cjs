const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { finishTest, mcpSession, sleep } = require('./support.cjs');

const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-giveup-'));
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
const alive = (pid) => {
  const state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0];
  return state !== undefined && state !== 'Z' && state !== 'X';
};
const aliveNow = (pid) => {
  try {
    return alive(pid);
  } catch {
    return false;
  }
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

    const text = fs.readFileSync(GATE_LOG, 'utf8').slice(mark);
    const giveUps = count(text, /went away after 3 failed probes/g);
    if (giveUps > 0) {
      assert.equal(aliveNow(pid), false, `a browser survived a give-up: pid ${pid} is alive after the gate gave up`);
      assert.match(text, new RegExp(`went away after 3 failed probes; pid ${pid} is dead`), `the gate gave up on pid ${pid} and did not name it as dead`);
    }
    assert.equal(during.status, 200, 'the request made during the stop is answered');
    assert.equal(count(fs.readFileSync(GATE_LOG, 'utf8'), /browser started pid=/g), 1, 'the browser is started once');
    console.log(`giveup: ok: ${giveUps} give-up(s) during the stop; the browser pid ${pid} is ${aliveNow(pid) ? 'alive and kept' : 'dead after its give-up'}`);

    lease.destroy();
    await session.end();
    await finishTest('giveup');
    fs.rmSync(PROJ, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    console.log('giveup: all checks passed');
    process.exit(0);
  } catch (error) {
    resume();
    lease?.destroy();
    session.stop();
    await finishTest('giveup').catch(() => {});
    console.error(`giveup: FAILED: ${error.message}`);
    console.error(`gate log: ${GATE_LOG}`);
    console.error(`project kept for inspection: ${PROJ}`);
    process.exit(1);
  }
})();
