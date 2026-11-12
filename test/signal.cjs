const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { signalPid } = require('../lib/signal');
const { finishTest } = require('./support.cjs');

const collect = () => {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
};

const exitedPid = () => new Promise((resolve) => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  child.on('exit', () => resolve(child.pid));
});

const exited = (child) => new Promise((resolve) => child.on('exit', resolve));

function foreignPid() {
  if (process.getuid() === 0) return null;
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let status = '';
    try {
      status = fs.readFileSync(`/proc/${entry}/status`, 'utf8');
    } catch {
      continue;
    }
    const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
    if (Number.isInteger(uid) && uid !== process.getuid()) return Number(entry);
  }
  return null;
}

(async () => {
  const gone = await exitedPid();
  const esrch = collect();
  assert.equal(signalPid(gone, 'SIGTERM', { log: esrch.log }), false, 'a pid that has exited is not signalled');
  assert.deepEqual(esrch.lines, [], 'ESRCH is not logged');
  console.log(`ok: ESRCH for exited pid ${gone} returns false and logs nothing`);

  const injected = collect();
  const eperm = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
  assert.equal(signalPid(4242, 'SIGTERM', { kill: () => { throw eperm; }, log: injected.log }), false);
  assert.equal(injected.lines.length, 1, 'a non-ESRCH error is logged once');
  assert.match(injected.lines[0], /could not send SIGTERM to pid 4242: kill EPERM/);
  console.log('ok: an injected EPERM returns false and logs the EPERM line');

  const other = foreignPid();
  if (other === null) {
    console.log('skip: a real EPERM needs a process of another user, and this run is root or finds none');
  } else {
    const real = collect();
    assert.equal(signalPid(other, 0, { log: real.log }), false, 'a process of another user is not signalled');
    assert.equal(real.lines.length, 1, 'the real EPERM is logged once');
    assert.match(real.lines[0], /could not send 0 to pid \d+: kill EPERM/);
    console.log(`ok: a real EPERM from pid ${other} (signal 0 delivers nothing) is logged`);
  }

  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  const quiet = collect();
  const done = exited(sleeper);
  assert.equal(signalPid(sleeper.pid, 'SIGTERM', { log: quiet.log }), true, 'a live pid is signalled');
  await done;
  assert.deepEqual(quiet.lines, [], 'a delivered signal logs nothing');
  console.log(`ok: a live pid ${sleeper.pid} is signalled and nothing is logged`);

  await finishTest('signal');
  console.log('signal: all checks passed');
})().catch(async (error) => {
  console.error(`signal: FAILED: ${error.message}`);
  await finishTest('signal').catch(() => {});
  process.exitCode = 1;
});
