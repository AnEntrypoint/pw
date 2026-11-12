const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sleep, mcpSession, processTable, projectProcs, stopPids, finishTest, WRAPPER } = require('./support.cjs');

const DEADLINE_MS = 15000;
const OPEN = "state.signal = await context.newPage(); await state.signal.goto('data:text/html,signal-marker'); return 'opened'";
const AGAIN = "return 'again'";
const SIGNALS = ['SIGTERM', 'SIGHUP'];

const gateStatus = (proj) => JSON.parse(execFileSync(process.execPath, [WRAPPER, 'status', '--json'], {
  cwd: proj,
  env: { ...process.env, PLAYWRITER_PROJECT_DIR: proj, PLAYWRITER_TELEMETRY: '0' },
  encoding: 'utf8',
  timeout: 20000,
})).gate;
const gateGone = (pid) => !processTable().some((row) => row.pid === pid && row.state !== 'Z');

async function waitFor(check, ms) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check()) return Date.now() - started;
    await sleep(200);
  }
  return null;
}

async function reopensAfter(signal) {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), `pw-signal-${signal.toLowerCase()}-`));
  const launcher = mcpSession(proj);
  try {
    await launcher.initialize();
    assert.match(await launcher.exec(OPEN), /opened/);
    const first = gateStatus(proj);
    assert.ok(first && first.pid, 'a gate runs after the first call');
    process.kill(first.pid, signal);
    const gone = await waitFor(() => gateGone(first.pid), DEADLINE_MS);
    assert.notEqual(gone, null, `gate ${first.pid} exits within 15 s of ${signal} with its lease held`);
    assert.match(await launcher.exec(AGAIN), /again/, `the next call after ${signal} runs`);
    const next = gateStatus(proj);
    assert.ok(next && next.pid && next.pid !== first.pid, `the next call after ${signal} starts a new gate`);
    console.log(`ok: ${signal} exits gate ${first.pid} in ${gone} ms with the lease held; the next call reopens gate ${next.pid}`);
  } finally {
    await launcher.end(5000);
    await stopPids(projectProcs(proj).map((row) => row.pid));
    fs.rmSync(proj, { recursive: true, force: true });
  }
}

(async () => {
  for (const signal of SIGNALS) await reopensAfter(signal);
  await finishTest('signals');
  console.log('signals: all checks passed');
})().catch(async (error) => {
  console.error(`signals: FAILED: ${error.message}`);
  await finishTest('signals').catch(() => {});
  process.exitCode = 1;
});
