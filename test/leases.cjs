const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sleep, projectProcs, stopProject, mcpSession } = require('./support.cjs');

const DEADLINE_MS = 10000;
const OPEN = "state.page ??= await context.newPage(); return 'open'";
const cleanups = new Set();

const gates = (proj) => projectProcs(proj).filter((row) => row.cmd.includes('--gate')).length;
const browsers = (proj) => projectProcs(proj).filter((row) => row.cmd.includes('--user-data-dir=') && !row.cmd.includes('--type=')).length;

async function waitFor(check, ms) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check()) return Date.now() - started;
    await sleep(200);
  }
  return null;
}

function makeProject() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-lease-'));
  const sessions = [];
  const stop = async () => {
    for (const session of sessions) session.stop();
    await stopProject(proj);
    fs.rmSync(proj, { recursive: true, force: true });
    cleanups.delete(stop);
  };
  cleanups.add(stop);
  return {
    proj,
    session: () => {
      const session = mcpSession(proj);
      sessions.push(session);
      return session;
    },
    stop,
  };
}

async function noGateForListing() {
  const p = makeProject();
  try {
    const listing = p.session();
    await listing.initialize();
    await sleep(1500);
    assert.equal(gates(p.proj), 0);
    assert.equal(browsers(p.proj), 0);
    console.log('ok: tools/list starts no gate and no browser');
  } finally {
    await p.stop();
  }
}

async function sigkillReleasesLease() {
  const p = makeProject();
  try {
    const launcher = p.session();
    await launcher.initialize();
    assert.match(await launcher.exec(OPEN), /open/);
    assert.equal(gates(p.proj), 1);
    assert.equal(browsers(p.proj), 1);
    process.kill(launcher.pid, 'SIGKILL');
    const took = await waitFor(() => gates(p.proj) === 0 && browsers(p.proj) === 0, DEADLINE_MS);
    assert.notEqual(took, null, 'gate and browser stop within 10 s of a SIGKILLed launcher');
    console.log(`ok: SIGKILLed launcher releases its lease; gate and browser gone in ${took} ms`);
  } finally {
    await p.stop();
  }
}

async function sharedGateKeepsBrowserForLastLease() {
  const p = makeProject();
  try {
    const a = p.session();
    const b = p.session();
    await a.initialize();
    await b.initialize();
    assert.match(await a.exec(OPEN), /open/);
    assert.match(await b.exec(OPEN), /open/);
    assert.equal(gates(p.proj), 1);
    assert.equal(browsers(p.proj), 1);
    process.kill(a.pid, 'SIGKILL');
    await sleep(7000);
    assert.equal(gates(p.proj), 1);
    assert.equal(browsers(p.proj), 1);
    assert.match(await b.exec("return 'still-open'"), /still-open/);
    console.log('ok: killing one of two launchers keeps the shared gate and browser for the other');
    process.kill(b.pid, 'SIGKILL');
    const took = await waitFor(() => gates(p.proj) === 0 && browsers(p.proj) === 0, DEADLINE_MS);
    assert.notEqual(took, null, 'gate and browser stop within 10 s once both launchers are dead');
    console.log(`ok: killing both launchers stops the gate and browser in ${took} ms`);
  } finally {
    await p.stop();
  }
}

const hard = setTimeout(async () => {
  console.error('leases: timed out, stopping what it started');
  for (const fn of [...cleanups]) await fn().catch(() => {});
  process.exit(1);
}, 240000);

(async () => {
  await noGateForListing();
  await sigkillReleasesLease();
  await sharedGateKeepsBrowserForLastLease();
  clearTimeout(hard);
  console.log('leases: all checks passed');
  process.exit(0);
})().catch(async (error) => {
  clearTimeout(hard);
  console.error(`leases: FAILED: ${error.message}`);
  for (const fn of [...cleanups]) await fn().catch(() => {});
  process.exit(1);
});
