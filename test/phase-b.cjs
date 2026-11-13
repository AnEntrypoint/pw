const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('./support.cjs');
const { isAlive } = require('./procs.cjs');

const RUNNER = path.join(ROOT, 'scripts', 'phase-b.cjs');
const LEAK = "node -e \"const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},120000)'],{stdio:'ignore'});c.unref();require('node:fs').writeFileSync(process.env.LEAK_PID_FILE,String(c.pid))\"";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pw-phase-b-'));
const runner = (logDir, specs, flags = []) => spawnSync(process.execPath, [RUNNER, ...flags, logDir, ...specs], { encoding: 'utf8', timeout: 120000 });
const resultOf = (logDir) => fs.readFileSync(path.join(logDir, 'result.txt'), 'utf8');

(async () => {
  const red = scratch();
  const redRun = runner(red, ['green=node -e "process.exit(0)"', 'red=node -e "process.exit(3)"']);
  assert.equal(redRun.status, 3, redRun.stderr);
  const redResult = resultOf(red);
  assert.match(redResult, /green exit 0 wall \d+ ms leftover 0 effective 0/);
  assert.match(redResult, /red exit 3 wall \d+ ms leftover 0 effective 3/);
  assert.match(redResult, /runner worst exit 3/);
  console.log(`ok 1: a red row makes the runner exit ${redRun.status}, with every row recorded`);

  const leak = scratch();
  const pidFile = path.join(leak, 'leak.pid');
  const leakRun = runner(leak, [`leak=LEAK_PID_FILE=${pidFile} ${LEAK}`]);
  assert.equal(leakRun.status, 1, leakRun.stderr);
  assert.match(resultOf(leak), /leak exit 0 wall \d+ ms leftover 1 effective 1/);
  const leaked = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(isAlive(leaked), false, `the process left behind by the row (${leaked}) is stopped`);
  console.log(`ok 2: a row that leaves process ${leaked} behind makes the runner exit ${leakRun.status}, and the process is stopped`);

  const watched = scratch();
  const watchedRun = runner(watched, ['green=node -e "setTimeout(()=>{},500)"'], ['--watch']);
  assert.equal(watchedRun.status, 0, watchedRun.stderr);
  const events = fs.readFileSync(path.join(watched, 'watch.jsonl'), 'utf8');
  assert.match(events, /"event":"start"/);
  assert.match(events, /"event":"stop"/);
  console.log('ok 3: --watch records a start and a stop event beside the rows');

  for (const dir of [red, leak, watched]) fs.rmSync(dir, { recursive: true, force: true });
  console.log('phase-b: all checks passed');
})().catch((error) => {
  console.error(`phase-b: FAILED: ${error.message}`);
  process.exit(1);
});
