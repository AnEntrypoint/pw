const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { releaseDirectory } = require('./support.cjs');

const MARK = 'teardown-hold-marker';
const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pw-hold-'));
const holder = (dir, ms) => {
  const child = childProcess.spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`, MARK], { cwd: dir, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, root: { pid: child.pid, cmd: new RegExp(MARK) } };
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

(async () => {
  const dirA = newDir();
  const a = holder(dirA, 2000);
  const releasedA = await releaseDirectory(dirA, [a.root], { graceMs: 15000 });
  assert.deepEqual(releasedA.stopped, [], 'the holder exits by itself, so the teardown waits for it and stops nothing');
  assert.deepEqual(await a.exited, { code: 0, signal: null }, 'the holder exited on its own: it was not signalled');
  assert.equal(fs.existsSync(dirA), false, 'the directory is removed once the holder has exited');
  console.log('teardown-hold: ok: a recorded holder that exits by itself is waited for by its own pid, not signalled, and the directory is then removed');

  const dirB = newDir();
  const b = holder(dirB, 60000);
  const releasedB = await releaseDirectory(dirB, [b.root], { graceMs: 1000 });
  assert.deepEqual(releasedB.stopped, [b.child.pid], 'a holder that outlives the grace is stopped by its own pid');
  assert.equal((await b.exited).signal, 'SIGTERM', 'the stop is the SIGTERM sent to that pid');
  assert.equal(fs.existsSync(dirB), false, 'the directory is removed after the stop');
  console.log('teardown-hold: ok: a holder that outlives the grace is stopped by its own pid and the directory is then removed');

  const dirC = newDir();
  const c = holder(dirC, 60000);
  const reusedRoot = { pid: c.child.pid, cmd: /not-this-process/ };
  const releasedC = await releaseDirectory(dirC, [reusedRoot], { graceMs: 1000 });
  assert.deepEqual(releasedC.stopped, [], 'a recorded pid whose command line is not the recorded one is not waited for and not stopped');
  assert.equal(alive(c.child.pid), true, 'the process that now holds that pid is left running');
  c.child.kill('SIGKILL');
  await c.exited;
  assert.equal(fs.existsSync(dirC), false, 'the directory is removed when only a foreign pid was recorded');
  console.log('teardown-hold: ok: a pid recorded with a different command line is never stopped');

  const dirD = newDir();
  const realRm = fs.rmSync;
  fs.rmSync = () => {
    throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${dirD}'`), { code: 'EBUSY' });
  };
  try {
    await assert.rejects(releaseDirectory(dirD, []), (error) => error.message.includes('is still held after every recorded process stopped (EBUSY)'), 'a directory that stays busy after everything stopped fails the teardown');
  } finally {
    fs.rmSync = realRm;
  }
  fs.rmSync(dirD, { recursive: true, force: true });
  console.log('teardown-hold: ok: a directory still busy after every recorded process stopped fails the teardown');

  console.log('teardown-hold: all checks passed');
  process.exit(0);
})().catch((error) => {
  console.error(`teardown-hold: FAILED: ${error.message}`);
  process.exit(1);
});
