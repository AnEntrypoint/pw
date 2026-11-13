const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { finishTest, mcpSession, sleep } = require('./support.cjs');

const ROOT = path.resolve(__dirname, '..');
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-negative-control-'));
const STATE = path.join(PROJ, '.playwriter');
const STOP_MS = 3500;
const PROBE_TIMEOUT_MS = 3000;
const PROBE_GAP_MS = 1000;
const GONE_AFTER_PROBES = 3;

const readPort = (name) => Number(fs.readFileSync(path.join(STATE, name), 'utf8'));
const launcherGoneAfter = () => Number(/const GONE_AFTER_PROBES = (\d+);/.exec(fs.readFileSync(path.join(ROOT, 'bin', 'playwriter-project'), 'utf8'))?.[1]);
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
const answers = (port) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: PROBE_TIMEOUT_MS }, (res) => {
    res.resume();
    resolve(res.statusCode === 200);
  });
  req.on('error', () => resolve(false));
  req.on('timeout', () => {
    req.destroy();
    resolve(false);
  });
});
const singleProbeGone = async (port) => !(await answers(port));
const confirmedGone = async (port) => {
  for (let miss = 1; miss <= GONE_AFTER_PROBES; miss += 1) {
    if (await answers(port)) return false;
    if (miss < GONE_AFTER_PROBES) await sleep(PROBE_GAP_MS);
  }
  return true;
};
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
  assert.equal(launcherGoneAfter(), GONE_AFTER_PROBES, 'the control counts a browser as gone after the same number of failed probes as the launcher');
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
    const debugPort = started.debugPort;
    assert.equal(await answers(debugPort), true, 'the debug port answers before the stop');
    const pid = listenerPid(debugPort);

    stopped = pid;
    process.kill(pid, 'SIGSTOP');
    const timer = setTimeout(resume, STOP_MS);
    let oldGone;
    let newGone;
    try {
      oldGone = await singleProbeGone(debugPort);
      newGone = await confirmedGone(debugPort);
    } finally {
      clearTimeout(timer);
      resume();
    }

    assert.equal(oldGone, true, 'the single-probe check reads the stopped browser as gone (the red control); it read it as running in this run');
    assert.equal(newGone, false, 'the confirmed check does not read the stopped browser as gone');
    console.log(`single-probe check: FAILED: the live browser (pid ${pid}) on port ${debugPort} is reported gone after one missed probe; this is the red control`);
    console.log(`confirmed check: ok: the live browser (pid ${pid}) on port ${debugPort} is not reported gone after ${GONE_AFTER_PROBES} missed probes`);

    lease.destroy();
    await session.end();
    await finishTest('negative-control');
    fs.rmSync(PROJ, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    console.log('negative-control: all checks passed');
    process.exit(0);
  } catch (error) {
    resume();
    lease?.destroy();
    session.stop();
    await finishTest('negative-control').catch(() => {});
    console.error(`negative-control: FAILED: ${error.message}`);
    console.error(`project kept for inspection: ${PROJ}`);
    process.exit(1);
  }
})();
