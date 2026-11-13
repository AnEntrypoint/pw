const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { ROOT, finishTest, mcpSession, sleep, stopPids } = require('./support.cjs');
const { commandOf, isAlive } = require('./procs.cjs');

const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-adopted-refusal-'));
const STATE = path.join(PROJ, '.playwriter');
const GATE_LOG = path.join(STATE, 'gate.log');
const FOREIGN_PROFILE = path.join(PROJ, 'foreign-profile');

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
const waitFor = async (check, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check().catch(() => null);
    if (value) return value;
    await sleep(200);
  }
  return null;
};
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const answers = (port) => request('GET', port, '/json/version', 3000).then((res) => res.status === 200, () => false);
const logText = () => (fs.existsSync(GATE_LOG) ? fs.readFileSync(GATE_LOG, 'utf8') : '');
const count = (text, pattern) => (text.match(pattern) ?? []).length;
const status = async (gate) => JSON.parse((await request('GET', gate, '/__pwp/status?pages=0', 5000)).body);
const close = async (gate, query) => JSON.parse((await request('POST', gate, `/__pwp/close?${query}`, 30000)).body);

(async () => {
  const { resolveBrowserExecutablePath } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'playwriter', 'dist', 'browser-config.js')).href);
  const debug = await freePort();
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, 'debug-port'), `${debug}\n`);
  const foreign = spawn(resolveBrowserExecutablePath(), [
    `--user-data-dir=${FOREIGN_PROFILE}`,
    `--remote-debugging-port=${debug}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });
  const session = mcpSession(PROJ);
  let adoptedPid = null;
  try {
    assert.ok(await waitFor(() => answers(debug), 30000), `a browser this test started answers on port ${debug}`);
    await session.initialize();
    assert.match(await session.exec("return 'first'"), /first/, 'the first call runs on the adopted browser');
    const gate = await waitFor(async () => (fs.existsSync(path.join(STATE, 'port')) ? readPort('port') : null), 10000);
    assert.ok(gate, 'the gate writes its port');
    const adopted = await waitFor(async () => {
      const body = await status(gate);
      return body.browser.adopted === true && body.browser.pid ? body : null;
    }, 30000);
    assert.ok(adopted, 'the gate adopts the browser it did not start');
    adoptedPid = adopted.browser.pid;
    assert.equal(adopted.browser.source, 'adopted', 'the browser is reported as adopted');
    assert.ok(commandOf(adoptedPid).includes(`--user-data-dir=${FOREIGN_PROFILE}`), `pid ${adoptedPid} is the browser this test started, on its own profile`);
    assert.match(logText(), /WARNING browser pid \d+ on debug port \d+ holds neither the recorded pid/, 'the gate logs the adoption warning');

    const mark = logText().length;
    const plain = await close(gate, `self=${session.pid}&force=0`);
    assert.equal(plain.closed, false, 'a close of an adopted browser is refused');
    assert.equal(plain.pid, adoptedPid, 'the refusal names the adopted browser');
    assert.equal(plain.reason, `browser pid ${adoptedPid} was adopted; this gate did not start it, so it is not closed`, 'the refusal says why');
    const forced = await close(gate, `self=${session.pid}&force=1&pid=${adoptedPid}`);
    assert.equal(forced.closed, false, 'force and the browser pid do not close an adopted browser');
    assert.equal(forced.reason, plain.reason, 'the same refusal is given with force and with the pid');
    assert.equal(isAlive(adoptedPid), true, `adopted browser pid ${adoptedPid} is still running after the refused closes`);
    assert.equal(await answers(debug), true, 'the adopted browser still answers on its debug port after the refused closes');
    assert.equal(count(logText().slice(mark), /stopping browser/g), 0, 'the refused closes did not stop the browser');
    console.log(`adopted-refusal: ok: browser pid ${adoptedPid} was adopted, and a close was refused twice: ${plain.reason}`);

    await session.end();
    await stopPids([adoptedPid, foreign.pid]);
    assert.equal(isAlive(adoptedPid), false, `the test stopped its own browser pid ${adoptedPid}`);
    await finishTest('adopted-refusal');
    fs.rmSync(PROJ, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    console.log('adopted-refusal: all checks passed');
    process.exit(0);
  } catch (error) {
    await stopPids([adoptedPid, foreign.pid].filter((pid) => pid !== null)).catch(() => {});
    session.stop();
    await finishTest('adopted-refusal').catch(() => {});
    console.error(`adopted-refusal: FAILED: ${error.message}`);
    console.error(`gate log: ${GATE_LOG}`);
    console.error(`project kept for inspection: ${PROJ}`);
    process.exit(1);
  }
})();
