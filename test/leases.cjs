const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sleep, projectProcs, mcpSession, finishTest } = require('./support.cjs');

const DEADLINE_MS = 10000;
const OPEN = "state.page ??= await context.newPage(); return 'open'";
const REOPEN = "const page = await context.newPage(); await page.goto('data:text/html,<title>again</title>'); const title = await page.title(); await page.close(); return title";
const cleanups = new Set();

const gates = (proj) => projectProcs(proj).filter((row) => row.cmd.includes('--gate')).length;
const browsers = (proj) => projectProcs(proj).filter((row) => row.cmd.includes('--user-data-dir=') && !row.cmd.includes('--type=')).length;
const children = (proj) => projectProcs(proj).filter((row) => row.cmd.includes('playwriter/bin.js')).length;

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
    await finishTest('leases');
    fs.rmSync(proj, { recursive: true, force: true });
    cleanups.delete(stop);
  };
  cleanups.add(stop);
  return {
    proj,
    session: (env = {}) => {
      const session = mcpSession(proj, env);
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

async function reopenAfterRelease() {
  const p = makeProject();
  try {
    const s = p.session();
    await s.initialize();
    assert.match(await s.exec(OPEN), /open/);
    assert.equal(browsers(p.proj), 1);
    await sleep(8000);
    assert.equal(gates(p.proj), 1, 'the gate stays while its lease is held');
    assert.equal(browsers(p.proj), 1, 'the browser stays while its lease is held, with no idle close');
    assert.equal(children(p.proj), 1);
    s.stop();
    const took = await waitFor(() => browsers(p.proj) === 0 && gates(p.proj) === 0 && children(p.proj) === 0, 60000);
    assert.notEqual(took, null, 'browser, gate and playwriter child retire once the lease closes');
    console.log(`ok: browser, gate and child retire ${took} ms after the lease closes`);
    const next = p.session();
    await next.initialize();
    assert.match(await next.exec(REOPEN), /again/);
    assert.equal(gates(p.proj), 1);
    assert.equal(browsers(p.proj), 1);
    assert.equal(children(p.proj), 1);
    console.log('ok: the next session reopens the gate, browser and child');
  } finally {
    await p.stop();
  }
}

async function idleSessionWhileSharedCallRuns() {
  const p = makeProject();
  try {
    const idle = p.session();
    const busy = p.session();
    await idle.initialize();
    await busy.initialize();
    assert.match(await idle.exec(OPEN), /open/);
    const slow = busy.exec("const page = await context.newPage(); await new Promise((r) => setTimeout(r, 9000)); await page.close(); return 'slow-done'");
    await sleep(6000);
    assert.equal(gates(p.proj), 1);
    assert.equal(browsers(p.proj), 1, 'the browser stays up while a shared call is in flight');
    assert.equal(children(p.proj), 2, 'the idle launcher keeps its child while the browser is up');
    assert.match(await slow, /slow-done/);
    console.log('ok: an idle session keeps the shared browser while the other session is mid-call');
    idle.stop();
    busy.stop();
    const took = await waitFor(() => browsers(p.proj) === 0 && gates(p.proj) === 0 && children(p.proj) === 0, 60000);
    assert.notEqual(took, null, 'after both sessions close, the browser, gate and children retire');
    console.log(`ok: both sessions closed; browser, gate and children retired in ${took} ms`);
    const next = p.session();
    await next.initialize();
    assert.match(await next.exec(REOPEN), /again/);
    assert.equal(gates(p.proj), 1);
    assert.equal(browsers(p.proj), 1);
    console.log('ok: a new session reopens the shared gate and browser on its first call');
  } finally {
    await p.stop();
  }
}

const hard = setTimeout(async () => {
  console.error('leases: timed out, stopping what it started');
  for (const fn of [...cleanups]) await fn().catch(() => {});
  process.exit(1);
}, 420000);

(async () => {
  await noGateForListing();
  await sigkillReleasesLease();
  await sharedGateKeepsBrowserForLastLease();
  await reopenAfterRelease();
  await idleSessionWhileSharedCallRuns();
  clearTimeout(hard);
  await finishTest('leases');
  console.log('leases: all checks passed');
  process.exit(0);
})().catch(async (error) => {
  clearTimeout(hard);
  console.error(`leases: FAILED: ${error.message}`);
  for (const fn of [...cleanups]) await fn().catch(() => {});
  process.exit(1);
});
