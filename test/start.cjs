const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { projectProcs, stopPids, finishTest, WRAPPER } = require('./support.cjs');

const BUDGET_MS = 20000;
const MODES = {
  refusal: {
    script: "#!/bin/sh\necho 'No usable sandbox' >&2\nexit 1\n",
    expect: /browser failed: browser refused to start: no usable sandbox/,
  },
  exit: {
    script: '#!/bin/sh\nexit 3\n',
    expect: /browser failed: browser exited \(3\) before opening debug port/,
  },
};

function fakeBrowser(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-start-browser-'));
  const file = path.join(dir, 'browser');
  fs.writeFileSync(file, script, { mode: 0o755 });
  return { dir, file };
}

async function run(name) {
  const { script, expect } = MODES[name];
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), `pw-start-${name}-`));
  const browser = fakeBrowser(script);
  try {
    const began = Date.now();
    const result = spawnSync(process.execPath, [WRAPPER, 'start'], {
      cwd: proj,
      env: { ...process.env, PLAYWRITER_PROJECT_DIR: proj, PLAYWRITER_TELEMETRY: '0', PLAYWRITER_BROWSER_PATH: browser.file },
      encoding: 'utf8',
      timeout: 90000,
    });
    const elapsed = Date.now() - began;
    assert.equal(result.status, 1, `${name}: start fails: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, expect, `${name}: start reports the gate's reason`);
    assert.ok(elapsed < BUDGET_MS, `${name}: start returns in ${elapsed} ms, within ${BUDGET_MS} ms`);
    const gateLog = fs.readFileSync(path.join(proj, '.playwriter', 'gate.log'), 'utf8');
    assert.match(gateLog, /browser start failed: /, `${name}: the gate logs the failure`);
    assert.equal((gateLog.match(/browser started pid=/g) ?? []).length, 1, `${name}: the browser is started once, not on each probe`);
    console.log(`ok ${name}: start returns in ${elapsed} ms with the gate's reason; the browser is started once`);
  } finally {
    await stopPids(projectProcs(proj).map((row) => row.pid));
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(browser.dir, { recursive: true, force: true });
  }
}

(async () => {
  for (const name of Object.keys(MODES)) await run(name);
  await finishTest('start');
  console.log('start: all checks passed');
})().catch(async (error) => {
  console.error(`start: FAILED: ${error.message}`);
  await finishTest('start').catch(() => {});
  process.exitCode = 1;
});
