const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sleep, processTable, projectProcs, stopPids, mcpSession, finishTest, WRAPPER } = require('./support.cjs');

const DEADLINE_MS = 15000;
const MARKER = 'first-open-marker';
const OPEN = "state.first = await context.newPage(); await state.first.goto('data:text/html," + MARKER + "'); return 'opened'";
const CHECK = "const contexts = context.browser().contexts(); const defaultUrls = contexts[0].pages().map((p) => p.url()).join(' '); return 'F1 defaultHas=' + defaultUrls.includes('" + MARKER + "') + ' executorIsDefault=' + (contexts[0] === context) + ' contexts=' + contexts.length";

const gateStatus = (proj) => JSON.parse(execFileSync(process.execPath, [WRAPPER, 'status', '--json'], {
  cwd: proj,
  env: { ...process.env, PLAYWRITER_PROJECT_DIR: proj, PLAYWRITER_TELEMETRY: '0' },
  encoding: 'utf8',
  timeout: 20000,
}));
const gateGone = (pid) => !processTable().some((row) => row.pid === pid && row.state !== 'Z');

async function waitFor(check, ms) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check()) return Date.now() - started;
    await sleep(200);
  }
  return null;
}

async function firstPageSurvivesGateKill() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-firstpage-'));
  const launcher = mcpSession(proj);
  try {
    await launcher.initialize();
    console.log('opened: ' + (await launcher.exec(OPEN)));
    const gate = gateStatus(proj).gate;
    assert.ok(gate && gate.pid, 'a gate runs after the first call');
    console.log('gate pid ' + gate.pid + ' port ' + gate.port);
    process.kill(gate.pid, 'SIGKILL');
    const gone = await waitFor(() => gateGone(gate.pid), DEADLINE_MS);
    assert.notEqual(gone, null, 'gate pid ' + gate.pid + ' is gone within 15 s of SIGKILL');
    const check = await launcher.exec(CHECK);
    const probe = (check.match(/F1 defaultHas=.{0,120}/) || ['no F1 line in reply'])[0];
    console.log(probe);
    const survived = probe.startsWith('F1 defaultHas=true');
    console.log('firstPageSurvivedGateKill: ' + survived);
    return survived;
  } finally {
    await launcher.end(5000);
    await stopPids(projectProcs(proj).map((row) => row.pid));
    fs.rmSync(proj, { recursive: true, force: true });
  }
}

(async () => {
  const survived = await firstPageSurvivesGateKill();
  await finishTest('firstpage');
  process.exitCode = survived ? 0 : 1;
})().catch(async (error) => {
  console.error(error.message);
  process.exitCode = 1;
  await finishTest('firstpage').catch((e) => console.error(e.message));
});
