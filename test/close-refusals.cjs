const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { finishTest, mcpSession, sleep } = require('./support.cjs');

const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-close-refusals-'));
const STATE = path.join(PROJ, '.playwriter');
const GATE_LOG = path.join(STATE, 'gate.log');

const readPort = (name) => Number(fs.readFileSync(path.join(STATE, name), 'utf8'));
const request = (method, port, urlPath, timeout) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, timeout }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      body += chunk;
    });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject);
  req.on('timeout', () => req.destroy(new Error(`${urlPath} timed out on port ${port}`)));
  req.end();
});
const openLease = (port, pid) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/__pwp/lease', headers: { 'X-Pwp-Pid': String(pid) } }, (res) => {
    res.resume();
    resolve(req);
  });
  req.on('error', reject);
});
const waitFor = async (check, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check().catch(() => null);
    if (value) return value;
    await sleep(200);
  }
  return null;
};
const alive = (pid) => {
  try {
    const state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0];
    return state !== undefined && state !== 'Z' && state !== 'X';
  } catch {
    return false;
  }
};
const logLength = () => fs.readFileSync(GATE_LOG, 'utf8').length;
const logSince = (mark) => fs.readFileSync(GATE_LOG, 'utf8').slice(mark);
const count = (text, pattern) => (text.match(pattern) ?? []).length;
const status = async (gate) => JSON.parse((await request('GET', gate, '/__pwp/status?pages=0', 5000)).body);
const close = async (gate, query) => JSON.parse((await request('POST', gate, `/__pwp/close?${query}`, 30000)).body);

(async () => {
  const session = mcpSession(PROJ);
  let second = null;
  try {
    await session.initialize();
    assert.match(await session.exec("return 'first'"), /first/, 'the first call starts the gate and the browser');
    const gate = await waitFor(async () => (fs.existsSync(path.join(STATE, 'port')) ? readPort('port') : null), 10000);
    assert.ok(gate, 'the gate writes its port');
    const started = await waitFor(async () => {
      const body = await status(gate);
      return body.browser.running && body.browser.pid && body.leases >= 1 ? body : null;
    }, 30000);
    assert.ok(started, 'the gate holds the MCP lease and reports a running browser');
    const browserPid = started.browser.pid;
    const debug = started.debugPort;

    let mark = logLength();
    const wrongPid = await close(gate, `self=${session.pid}&force=0&pid=${process.pid}`);
    assert.equal(wrongPid.closed, false, 'a close for a pid that is not this project browser is refused');
    assert.equal(wrongPid.pid, browserPid, 'the refusal names this project browser');
    assert.equal(wrongPid.reason, `pid ${process.pid} is not this project's browser, which is pid ${browserPid}`, 'the refusal names the pid it was asked for and the browser it is');
    assert.equal(alive(browserPid), true, `browser pid ${browserPid} is still running after the refused close`);
    assert.equal((await request('GET', debug, '/json/version', 5000)).status, 200, 'the debug port still answers after the refused close');
    assert.equal(count(logSince(mark), /stopping browser/g), 0, 'the refused close did not stop the browser');
    console.log(`close-refusals: ok: a close for pid ${process.pid} was refused; browser pid ${browserPid} kept: ${wrongPid.reason}`);

    second = await openLease(gate, process.pid);
    const withSecond = await waitFor(async () => ((await status(gate)).leases === 2 ? true : null), 10000);
    assert.ok(withSecond, 'a second lease is held beside the MCP lease');

    mark = logLength();
    const otherLease = await close(gate, `self=${session.pid}&force=0`);
    assert.equal(otherLease.closed, false, 'a close with another lease held and no force is refused');
    assert.equal(otherLease.pid, browserPid, 'the refusal names this project browser');
    assert.equal(otherLease.reason, '1 other lease(s) held', 'the refusal counts the other lease');
    assert.equal(otherLease.leases.length, 1, 'the refusal lists exactly the other lease');
    assert.equal(otherLease.leases[0].pid, process.pid, 'the listed lease is the other holder, not the MCP session');
    assert.equal(alive(browserPid), true, `browser pid ${browserPid} is still running after the refused close`);
    assert.equal((await request('GET', debug, '/json/version', 5000)).status, 200, 'the debug port still answers after the refused close');
    assert.equal(count(logSince(mark), /stopping browser/g), 0, 'the refused close did not stop the browser');
    console.log(`close-refusals: ok: a close with another lease held was refused; browser pid ${browserPid} kept: ${otherLease.reason}`);

    second.destroy();
    await session.end();
    await finishTest('close-refusals');
    fs.rmSync(PROJ, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    console.log('close-refusals: all checks passed');
    process.exit(0);
  } catch (error) {
    second?.destroy();
    session.stop();
    await finishTest('close-refusals').catch(() => {});
    console.error(`close-refusals: FAILED: ${error.message}`);
    console.error(`gate log: ${GATE_LOG}`);
    console.error(`project kept for inspection: ${PROJ}`);
    process.exit(1);
  }
})();
