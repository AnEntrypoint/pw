const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { sleep, mcpSession, processTable, projectProcs, stopPids, finishTest, WRAPPER } = require('./support.cjs');

const DEADLINE_MS = 15000;
const IDLE_MS = '60000';
const OPEN = "return 'opened'";
const CHROME = ['/opt/google/chrome/chrome', '/usr/lib/chromium/chromium.real'].find((candidate) => fs.existsSync(candidate));
const STUB = `
const http = require('node:http');
const fs = require('node:fs');
const port = Number(process.env.STUB_PORT);
if (process.env.STUB_IGNORE_TERM === '1') process.on('SIGTERM', () => {});
http.createServer((req, res) => {
  fs.appendFileSync(process.env.STUB_LOG, req.url.split('?')[0] + '\\n');
  if (req.url.startsWith('/__pwp/ping')) return res.end(JSON.stringify({ project: process.env.STUB_PROJECT, pid: process.pid }));
  if (req.url.startsWith('/__pwp/status')) return res.end(JSON.stringify({ project: process.env.STUB_PROJECT, leases: 0, gate: { pid: process.pid, port } }));
  res.statusCode = 404;
  res.end();
}).listen(port, '127.0.0.1');
`;

const mkProject = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `pw-stale-${name}-`));
const gone = (pid) => !processTable().some((row) => row.pid === pid && row.state !== 'Z');
const answers = (port, route) => fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(1000) })
  .then((res) => res.ok)
  .catch(() => false);

async function waitFor(check, ms) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check()) return Date.now() - started;
    await sleep(200);
  }
  return null;
}

const gateStatus = (proj) => JSON.parse(execFileSync(process.execPath, [WRAPPER, 'status', '--json'], {
  cwd: proj,
  env: { ...process.env, PLAYWRITER_PROJECT_DIR: proj, PLAYWRITER_TELEMETRY: '0' },
  encoding: 'utf8',
  timeout: 20000,
}));

function alternateBrowser() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-stale-browser-'));
  const link = path.join(dir, 'chromium');
  fs.symlinkSync(CHROME, link);
  return { dir, link };
}

function start(proj, extra = {}) {
  const env = { ...process.env, PLAYWRITER_PROJECT_DIR: proj, PLAYWRITER_TELEMETRY: '0', PLAYWRITER_IDLE_MS: IDLE_MS, PLAYWRITER_BROWSER_PATH: CHROME };
  return spawnSync(process.execPath, [WRAPPER, 'start'], { cwd: proj, env: { ...env, ...extra }, encoding: 'utf8', timeout: 90000 });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function stubGate(proj, { gate, ignoreTerm }) {
  const state = path.join(proj, '.playwriter');
  fs.mkdirSync(state, { recursive: true });
  const port = await freePort();
  fs.writeFileSync(path.join(state, 'port'), `${port}\n`);
  fs.writeFileSync(path.join(state, 'debug-port'), `${await freePort()}\n`);
  fs.writeFileSync(path.join(state, 'browser.fingerprint'), 'stale-build\n');
  const log = path.join(proj, 'stub.log');
  const args = gate ? ['--', WRAPPER, '--gate'] : ['--', 'foreign-server'];
  const stub = spawn(process.execPath, ['-e', STUB, ...args], {
    stdio: 'ignore',
    env: { ...process.env, STUB_PORT: String(port), STUB_PROJECT: proj, STUB_LOG: log, STUB_IGNORE_TERM: ignoreTerm ? '1' : '0' },
  });
  const up = await waitFor(() => answers(port, '/__pwp/ping'), 5000);
  assert.notEqual(up, null, 'the stub answers its ping');
  return { stub, port, log };
}

const stubAlive = (stub) => stub.exitCode === null && stub.signalCode === null;

async function replace() {
  assert.ok(CHROME, 'a Chrome or Chromium binary is installed');
  const proj = mkProject('replace');
  const alt = alternateBrowser();
  try {
    const first = start(proj);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /browser ready/);
    const before = gateStatus(proj);
    assert.ok(before.gate && before.gate.pid, 'a gate answers after the first start');
    assert.ok(before.browser && before.browser.pid, 'a browser runs after the first start');
    assert.equal(before.leases, 0, 'the first start leaves no lease');
    const second = start(proj, { PLAYWRITER_BROWSER_PATH: alt.link });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /browser ready/);
    const gateGone = await waitFor(() => gone(before.gate.pid), DEADLINE_MS);
    assert.notEqual(gateGone, null, `old gate ${before.gate.pid} is gone within 15 s of the second start`);
    const browserGone = await waitFor(() => gone(before.browser.pid), DEADLINE_MS);
    assert.notEqual(browserGone, null, `old browser ${before.browser.pid} is gone within 15 s of the second start`);
    const after = gateStatus(proj);
    assert.ok(after.gate && after.gate.pid !== before.gate.pid, 'the second start runs a new gate');
    assert.equal(await answers(after.gate.port, '/__pwp/ping'), true, 'the new gate answers');
    assert.equal(after.browser.running, true, 'the new gate runs a browser');
    assert.ok(fs.readFileSync(path.join(proj, '.playwriter', 'browser.fingerprint'), 'utf8').includes(alt.link), 'the new browser is started with the new fingerprint');
    console.log(`ok: a different fingerprint and no lease replaces gate ${before.gate.pid} (gone in ${gateGone} ms) and its browser ${before.browser.pid} (gone in ${browserGone} ms); the new gate ${after.gate.pid} answers`);
  } finally {
    await stopPids(projectProcs(proj).map((row) => row.pid));
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(alt.dir, { recursive: true, force: true });
  }
}

async function held() {
  assert.ok(CHROME, 'a Chrome or Chromium binary is installed');
  const proj = mkProject('held');
  const alt = alternateBrowser();
  const launcher = mcpSession(proj, { PLAYWRITER_BROWSER_PATH: CHROME });
  try {
    await launcher.initialize();
    assert.match(await launcher.exec(OPEN), /opened/);
    const before = gateStatus(proj);
    assert.ok(before.leases >= 1, 'the MCP session holds a lease on the gate');
    const second = start(proj, { PLAYWRITER_BROWSER_PATH: alt.link });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /the browser was started as .*, not .*; it is not restarted while 1 other lease\(s\) hold this project's gate/, 'the start prints the note that the gate is not replaced');
    assert.match(second.stderr, /browser ready/);
    const after = gateStatus(proj);
    assert.equal(after.gate.pid, before.gate.pid, 'the leased gate is not replaced');
    assert.equal(after.browser.pid, before.browser.pid, 'the leased browser is not replaced');
    console.log(`ok: a leased gate ${before.gate.pid} and browser ${before.browser.pid} are not replaced, and the note prints`);
  } finally {
    await launcher.end(5000);
    await stopPids(projectProcs(proj).map((row) => row.pid));
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(alt.dir, { recursive: true, force: true });
  }
}

async function unanswering() {
  const proj = mkProject('unanswering');
  let stub = null;
  try {
    const gate = await stubGate(proj, { gate: true, ignoreTerm: true });
    stub = gate.stub;
    const result = start(proj);
    assert.equal(result.status, 1, `a gate that ignores SIGTERM is an error: ${result.stderr}`);
    assert.match(result.stderr, /gate \d+ still answers on port \d+ 15 s after SIGTERM; no lease was taken on it/);
    assert.equal(stubAlive(stub), true, 'the gate that ignores SIGTERM is still running');
    const requests = fs.readFileSync(gate.log, 'utf8');
    assert.match(requests, /\/__pwp\/ping/, 'the launcher pinged the stubborn gate');
    assert.doesNotMatch(requests, /\/__pwp\/lease/, 'no lease was requested from the stubborn gate');
    console.log('ok: a gate that still answers 15 s after SIGTERM fails the start, and no lease is taken on it');
  } finally {
    if (stub && stubAlive(stub)) stub.kill('SIGKILL');
    await stopPids(projectProcs(proj).map((row) => row.pid));
    fs.rmSync(proj, { recursive: true, force: true });
  }
}

async function foreign() {
  const proj = mkProject('foreign');
  let stub = null;
  try {
    const gate = await stubGate(proj, { gate: false, ignoreTerm: false });
    stub = gate.stub;
    const result = start(proj);
    assert.equal(result.status, 1, `a foreign process on the gate port is an error: ${result.stderr}`);
    assert.match(result.stderr, /is not this project's gate \(pid \d+\); it was not signalled and no lease was taken on it/);
    assert.equal(stubAlive(stub), true, 'the foreign process was not signalled');
    const requests = fs.readFileSync(gate.log, 'utf8');
    assert.doesNotMatch(requests, /\/__pwp\/lease/, 'no lease was requested from the foreign process');
    console.log('ok: a process on the gate port that is not this project gate is not signalled, and no lease is taken on it');
  } finally {
    if (stub && stubAlive(stub)) stub.kill('SIGKILL');
    await stopPids(projectProcs(proj).map((row) => row.pid));
    fs.rmSync(proj, { recursive: true, force: true });
  }
}

const MODES = { replace, held, unanswering, foreign };
const DEFAULT_MODES = ['replace', 'held', 'unanswering', 'foreign'];

(async () => {
  const requested = process.argv[2];
  if (requested !== undefined && !(requested in MODES)) throw new Error(`unknown mode ${requested}; use one of ${Object.keys(MODES).join(', ')}`);
  for (const mode of requested ? [requested] : DEFAULT_MODES) await MODES[mode]();
  await finishTest('stale');
  console.log('stale: all checks passed');
})().catch(async (error) => {
  console.error(`stale: FAILED: ${error.message}`);
  await finishTest('stale').catch(() => {});
  process.exitCode = 1;
});
