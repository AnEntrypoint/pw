const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MODES = ['refuse', 'ready'];
const MODE = process.argv[2] ?? 'refuse';
if (!MODES.includes(MODE)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
const ROOT = path.resolve(__dirname, '..');
const LAUNCHER = process.argv[3] ?? path.join(ROOT, 'bin', 'playwriter-project');
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-start-poll-'));
const STATE = path.join(PROJ, '.playwriter');
const GATE_LOG = path.join(STATE, 'gate.log');
const SLOW_MS = 2500;
const RUN_LIMIT_MS = 60000;
const REFUSAL = 'browser refused to start: no usable sandbox. Set PLAYWRITER_NO_SANDBOX=1 and restart the agent (manual, chapter 9).';

let polls = 0;
let starts = 0;
let current = null;
let up = false;

const log = (text) => fs.appendFileSync(GATE_LOG, `${new Date().toISOString()} ${text}\n`);

const settle = (instance, status, body) => {
  for (const res of instance.waiting) {
    if (res.writableEnded) continue;
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(body);
  }
};

const refuse = (instance) => {
  if (instance !== current) return;
  clearTimeout(instance.timer);
  current = null;
  log(`browser start failed: ${REFUSAL}`);
  settle(instance, 503, REFUSAL);
};

const answerReady = (instance) => {
  if (instance !== current) return;
  clearTimeout(instance.timer);
  current = null;
  up = true;
  log('browser ready');
  settle(instance, 200, 'ok\n');
};

const begin = () => {
  starts += 1;
  log(`browser started pid=${9000 + starts} profile=${path.join(STATE, 'browser-profile')}`);
  const instance = { waiting: new Set(), timer: null };
  instance.timer = setTimeout(() => (MODE === 'ready' ? answerReady(instance) : refuse(instance)), SLOW_MS);
  current = instance;
  return instance;
};

const server = http.createServer((req, res) => {
  const route = req.url.split('?')[0];
  if (route === '/__pwp/ping') return res.end(JSON.stringify({ project: PROJ, pid: process.pid }));
  if (route === '/__pwp/lease') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.write('leased 1\n');
  }
  if (route === '/__pwp/hold') return res.end('ok\n');
  if (route === '/json/version') {
    polls += 1;
    if (up) return res.end('ok\n');
    const instance = current ?? begin();
    instance.waiting.add(res);
    res.on('close', () => {
      if (!res.writableEnded && MODE === 'refuse') refuse(instance);
    });
    return;
  }
  res.statusCode = 404;
  res.end();
});

const runStart = () => new Promise((resolve) => {
  const child = spawn(process.execPath, [LAUNCHER, 'start'], {
    cwd: PROJ,
    env: { ...process.env, PLAYWRITER_PROJECT_DIR: PROJ, PLAYWRITER_TELEMETRY: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const guard = setTimeout(() => child.kill('SIGKILL'), RUN_LIMIT_MS);
  child.on('exit', (code) => {
    clearTimeout(guard);
    resolve({ code, stdout, stderr });
  });
});

(async () => {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, 'debug-port'), '1\n');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(STATE, 'port'), `${server.address().port}\n`);
  const result = await runStart();
  server.closeAllConnections();
  server.close();
  try {
    assert.ok(starts === 1 && polls === 1, `the browser is started once and one readiness request reaches the gate (${starts} starts, ${polls} readiness requests)`);
    if (MODE === 'ready') {
      assert.equal(result.code, 0, `start succeeds: ${result.stderr}`);
      assert.match(result.stderr, /browser ready/, 'start reports ready');
    } else {
      assert.equal(result.code, 1, `start fails with the gate's reason: ${result.stderr}`);
      assert.match(result.stderr, /browser failed: browser refused to start: no usable sandbox/, 'start reports the refusal');
    }
  } catch (error) {
    console.error(`start-poll ${MODE}: FAILED: ${error.message}`);
    console.error(`launcher exit ${result.code}; launcher stderr:\n${result.stderr.trim()}`);
    console.error(`project kept for inspection: ${PROJ}`);
    process.exit(1);
  }
  fs.rmSync(PROJ, { recursive: true, force: true });
  console.log(`start-poll ${MODE}: launcher exit ${result.code}; ${starts} browser start(s); ${polls} readiness request(s)`);
  console.log(`launcher stderr:\n${result.stderr.trim()}`);
  console.log('start-poll: all checks passed');
  process.exit(0);
})();
