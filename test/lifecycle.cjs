const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { finishTest } = require('./support.cjs');

const ROOT = path.resolve(__dirname, '..');
const WRAPPER = path.join(ROOT, 'bin', 'playwriter-project');
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-test-'));
const STATE = path.join(PROJ, '.playwriter');
const IDLE_MS = 4000;
const ENV = { ...process.env, PLAYWRITER_PROJECT_DIR: PROJ, PLAYWRITER_IDLE_MS: String(IDLE_MS), PLAYWRITER_TELEMETRY: '0' };
const FORCE = process.env.PWP_LIFECYCLE_FORCE;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PROBE_TIMEOUT_MS = 3000;
const probes = new Map();
const recordProbe = (name, reason) => {
  const seen = probes.get(name) ?? { last: '', counts: new Map() };
  seen.last = reason;
  seen.counts.set(reason, (seen.counts.get(reason) ?? 0) + 1);
  probes.set(name, seen);
};
const probeReport = () => [...probes].map(([name, seen]) => `  ${name}: last "${seen.last}"; ${[...seen.counts].map(([reason, n]) => `${reason} x${n}`).join(', ')}`).join('\n');
const probeOnce = (name, port, urlPath) => new Promise((resolve) => {
  let settled = false;
  const finish = (ok, reason) => {
    if (settled) return;
    settled = true;
    recordProbe(name, reason);
    resolve(ok);
  };
  if (!port) return finish(false, `no port file for ${name}`);
  const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: PROBE_TIMEOUT_MS }, (res) => {
    res.resume();
    finish(res.statusCode === 200, res.statusCode === 200 ? 'ok' : `HTTP ${res.statusCode}`);
  });
  req.on('error', (error) => finish(false, `connection error ${error.code ?? error.message} on port ${port}`));
  req.on('timeout', () => {
    finish(false, `timeout after ${PROBE_TIMEOUT_MS} ms on port ${port}`);
    req.destroy();
  });
});
const readPort = (name) => {
  try {
    return Number(fs.readFileSync(path.join(STATE, name), 'utf8'));
  } catch {
    return 0;
  }
};
const chromeUp = () => probeOnce('debug-port /json/version', readPort('debug-port'), '/json/version');
const gateUp = () => probeOnce('gate /__pwp/ping', readPort('port'), '/__pwp/ping');
const gateStatus = () => new Promise((resolve) => {
  const port = readPort('port');
  if (!port) return resolve(null);
  const req = http.get({ host: '127.0.0.1', port, path: '/__pwp/status?pages=0', timeout: 3000 }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      body += chunk;
    });
    res.on('end', () => {
      try {
        resolve(res.statusCode === 200 ? JSON.parse(body) : null);
      } catch {
        resolve(null);
      }
    });
  });
  req.on('error', () => resolve(null));
  req.on('timeout', () => {
    req.destroy();
    resolve(null);
  });
});
const gateNote = async () => ((await gateUp()) ? 'answers /__pwp/ping, status unavailable' : `not answering: ${probes.get('gate /__pwp/ping').last}`);
const textOf = (msg) => (msg.result?.content ?? []).map((c) => c.text).join('') || JSON.stringify(msg);
const until = async (check, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(200);
  }
  return false;
};
const GONE_AFTER_PROBES = 3;
const PROBE_GAP_MS = IDLE_MS / 4;
const confirmedGone = async (probe) => {
  for (let miss = 1; miss <= GONE_AFTER_PROBES; miss += 1) {
    if (await probe()) return false;
    if (miss < GONE_AFTER_PROBES) await sleep(PROBE_GAP_MS);
  }
  return true;
};
const launcherGoneAfter = () => Number(/const GONE_AFTER_PROBES = (\d+);/.exec(fs.readFileSync(WRAPPER, 'utf8'))?.[1]);

function mcpClient() {
  const child = spawn(process.execPath, [WRAPPER], { cwd: PROJ, env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
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

const tail = (file, lines = 20) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').slice(-(lines + 1)).join('\n');
  } catch (error) {
    return `unreadable (${error.code ?? error.message})`;
  }
};
const failureLine = (error) => /lifecycle\.cjs:(\d+)/.exec(error.stack ?? '')?.[1] ?? 'unknown';
const failureReport = (error, gateText, probeText) => [
  `failure: ${error.message}`,
  `line: ${failureLine(error)}`,
  `checks passed before the failure: ${checks}`,
  `stack:\n${error.stack}`,
  `probes:\n${probeText}`,
  `gate status: ${gateText}`,
  `gate.log, last 20 lines:\n${tail(path.join(STATE, 'gate.log'))}`,
  `browser.log, last 20 lines:\n${tail(path.join(STATE, 'browser.log'))}`,
].join('\n\n') + '\n';

(async () => {
  assert.equal(launcherGoneAfter(), GONE_AFTER_PROBES, 'the test counts a gate or browser as gone after the same number of failed probes as the launcher');
  const m = mcpClient();
  await m.call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  m.notify('notifications/initialized');
  const tools = await m.call(2, 'tools/list', {});
  assert.ok(tools.result.tools.some((tool) => tool.name === 'browsers'));
  await sleep(1500);
  assert.equal(await confirmedGone(gateUp), true, 'listing tools starts no gate');
  assert.equal(await confirmedGone(chromeUp), true, 'listing tools starts no browser');
  check('listing tools starts no gate and no browser');

  const set = await m.exec(3, "state.page ??= await context.newPage(); await state.page.goto('data:text/html,<title>keep</title>'); await context.addCookies([{ name: 'keep', value: 'yes', url: 'http://example.test/', expires: Math.floor(Date.now() / 1000) + 86400 }]); return 'set'");
  assert.match(set, /set/);
  assert.equal(await until(chromeUp, 15000), true, 'the debug port answers after the first call');
  let startedPid = null;
  assert.equal(await until(async () => {
    startedPid = (await gateStatus())?.browser?.pid ?? null;
    return startedPid !== null;
  }, 10000), true, 'the gate reports the browser it started');
  check('first tool call opens the browser');

  await sleep(IDLE_MS + 4000);
  let held = null;
  const heldByGate = await until(async () => {
    held = await gateStatus();
    return held?.leases >= 1 && held.browser?.pid === startedPid;
  }, 10000);
  assert.equal(heldByGate, true, `the gate still holds the MCP lease and the browser it started: ${JSON.stringify(held)}`);
  assert.equal(await until(chromeUp, 10000), true, 'the debug port answers');
  assert.equal(fs.existsSync(path.join(STATE, 'browser-profile')), true);
  check('a held MCP lease keeps the browser open past the idle time');

  const reuse = await m.exec(4, "return (await context.cookies('http://example.test/')).map((c) => c.name + '=' + c.value)");
  assert.match(reuse, /keep=yes/);
  assert.equal(await until(chromeUp, 10000), true, 'the debug port answers after the reuse');
  check('same MCP session still has the cookie');

  const listed = JSON.parse((await m.call(5, 'tools/call', { name: 'browsers', arguments: { action: 'list' } })).result.content[0].text);
  assert.equal(listed.browsers.supported, true);
  check('browsers list reports the machine');

  const closed = JSON.parse((await m.call(6, 'tools/call', { name: 'browsers', arguments: { action: 'close', target: 'project' } })).result.content[0].text);
  assert.equal(closed.closed.length, 1);
  assert.equal(await until(() => confirmedGone(chromeUp), 10000), true, 'the debug port stops answering after the close');
  check('browsers close stops the project browser when no other lease is held');

  m.close();
  assert.equal(await until(() => confirmedGone(gateUp), IDLE_MS + 30000), true, 'the gate exits once the agent disconnects');
  assert.equal(await until(() => confirmedGone(chromeUp), 10000), true, 'the browser stays closed once the agent disconnects');
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
  assert.equal(await until(() => confirmedGone(chromeUp), 12000), true, 'the CLI session browser stops after idle');
  check('CLI session browser stops after idle');

  const after = cli(['-s', sid, '-e', "return (await context.cookies('http://example.test/')).map((c) => c.name + '=' + c.value)"]);
  if (FORCE === 'check11') assert.fail('forced failure at check 11 (PWP_LIFECYCLE_FORCE=check11)');
  assert.match(after.stdout, /keep=yes/);
  check('CLI session reconnects after idle and the cookie survived');

  await sleep(IDLE_MS + 8000);
  assert.equal(await until(async () => !(await chromeUp()) && !(await gateUp()), 15000), true, 'the browser and the gate are stopped at the end');
  check('everything is stopped at the end');

  spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'playwriter', 'bin.js'), 'session', 'delete', sid], { env: ENV, encoding: 'utf8' });
  console.log(`lifecycle: ${checks} checks passed`);
  console.log(`probes:\n${probeReport()}`);
})()
  .then(async () => {
    if (FORCE === 'cleanup') throw new Error('forced failure in cleanup (PWP_LIFECYCLE_FORCE=cleanup)');
    await finishTest('lifecycle');
    fs.rmSync(PROJ, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    process.exit(0);
  })
  .catch(async (error) => {
    const status = await gateStatus();
    const gateText = status ? JSON.stringify(status) : await gateNote();
    const probeText = probeReport();
    await finishTest('lifecycle').catch(() => {});
    const report = failureReport(error, gateText, probeText);
    const file = path.join(PROJ, 'failure.txt');
    try {
      fs.writeFileSync(file, report);
    } catch (writeError) {
      console.error(`could not write ${file}: ${writeError.message}`);
    }
    console.error(`lifecycle: FAILED: ${error.message}`);
    console.error(report);
    console.error(`failure file: ${file}`);
    console.error(`project kept for inspection: ${PROJ}`);
    process.exit(1);
  });
