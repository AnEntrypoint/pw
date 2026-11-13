const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sleep, projectProcs, stopPids, mcpSession, WRAPPER, confirmedGone } = require('./support.cjs');

const OPEN = "state.orphan = await context.newPage(); await state.orphan.goto('data:text/html,orphan-witness'); return 'opened'";
const RESTART = "return 'restarted'";
const count = (proj) => projectProcs(proj).length;
const gateCount = (proj) => projectProcs(proj).filter((row) => row.cmd.includes('--gate')).length;
const answers = (port) => fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const statusOf = (proj) => JSON.parse(execFileSync(process.execPath, [WRAPPER, 'status', '--json'], {
  cwd: proj,
  env: { ...process.env, PLAYWRITER_PROJECT_DIR: proj, PLAYWRITER_TELEMETRY: '0' },
  encoding: 'utf8',
  timeout: 20000,
}));
async function settle(proj, ms) {
  const end = Date.now() + ms;
  while (count(proj) > 0 && Date.now() < end) await sleep(300);
  return count(proj);
}

async function scenario(name, dropPidFile) {
  const started = Date.now();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orphan-'));
  const counts = { baseline: count(proj) };
  let exitState = null;
  let debug = null;
  const launcher = mcpSession(proj, { PLAYWRITER_IDLE_MS: '4000' });
  let adopted = null;
  try {
    await launcher.initialize();
    await launcher.exec(OPEN);
    const status = statusOf(proj);
    const gate = status.gate;
    debug = status.debugPort;
    assert.ok(gate && gate.pid, name + ': a gate runs after the first call');
    counts.started = count(proj);
    process.kill(gate.pid, 'SIGKILL');
    await sleep(2000);
    counts.afterKill = count(proj);
    if (dropPidFile) fs.rmSync(path.join(proj, '.playwriter', 'browser.pid'), { force: true });
    await launcher.exec(RESTART);
    counts.afterRestart = count(proj);
    adopted = statusOf(proj).browser.adopted;
    assert.equal(adopted, false, name + ': the restarted gate owns the browser it adopted');
    await launcher.end(3000);
    counts.afterExit = await settle(proj, 40000);
    exitState = { gates: gateCount(proj), answering: !(await confirmedGone(() => answers(debug))) };
  } finally {
    await stopPids(projectProcs(proj).map((row) => row.pid));
    fs.rmSync(proj, { recursive: true, force: true });
  }
  return { scenario: name, counts, adoptedAfterRestart: adopted, exitState, wallMs: Date.now() - started };
}

(async () => {
  const results = [];
  let failed = null;
  for (const [name, drop] of [['pid file kept', false], ['pid file dropped', true]]) {
    try {
      results.push(await scenario(name, drop));
    } catch (error) {
      failed = failed ?? name + ': ' + error.message;
    }
  }
  for (const r of results) {
    console.log('orphan ' + r.scenario + ': baseline ' + r.counts.baseline + ' -> started ' + r.counts.started + ' -> after kill ' + r.counts.afterKill + ' -> after restart ' + r.counts.afterRestart + ' -> after exit ' + r.counts.afterExit + '; restarted gate owns browser: ' + (r.adoptedAfterRestart === false) + '; gates after exit: ' + r.exitState.gates + '; browser answers /json/version after exit: ' + r.exitState.answering + '; wall ' + r.wallMs + ' ms');
    if (r.counts.afterExit !== 0) failed = failed ?? r.scenario + ': ' + r.counts.afterExit + ' processes left after exit';
    if (r.exitState.gates !== 0) failed = failed ?? r.scenario + ': a gate process remains after exit';
    if (r.exitState.answering) failed = failed ?? r.scenario + ': a browser it started still answers /json/version after exit';
  }
  if (failed) {
    console.error('orphan: FAILED ' + failed);
    process.exitCode = 1;
  }
})();
