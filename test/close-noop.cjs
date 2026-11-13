const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ROOT, finishTest, mcpSession, sleep, stopPids } = require('./support.cjs');
const { commandOf, isAlive } = require('./procs.cjs');

const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-close-noop-'));
const STATE = path.join(PROJ, '.playwriter');
const GATE_LOG = path.join(STATE, 'gate.log');
const PROFILE = path.join(STATE, 'browser-profile');
const ALT_PROFILE = path.join(PROJ, 'alt-profile');
const CHROME_WRAP = path.join(PROJ, 'chrome-wrap.sh');

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
const wrapperScript = (browser) => [
  '#!/bin/sh',
  'n=$#',
  'i=0',
  'while [ "$i" -lt "$n" ]; do',
  '  a=$1',
  '  shift',
  `  case "$a" in --user-data-dir=*) a="--user-data-dir=${ALT_PROFILE}" ;; esac`,
  '  set -- "$@" "$a"',
  '  i=$((i + 1))',
  'done',
  `exec '${browser}' "$@"`,
  '',
].join('\n');

(async () => {
  const { resolveBrowserExecutablePath } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'playwriter', 'dist', 'browser-config.js')).href);
  fs.writeFileSync(CHROME_WRAP, wrapperScript(resolveBrowserExecutablePath()), { mode: 0o755 });
  const session = mcpSession(PROJ, { PLAYWRITER_BROWSER_PATH: CHROME_WRAP });
  let browserPid = null;
  try {
    await session.initialize();
    assert.match(await session.exec("return 'first'"), /first/, 'the first call starts the gate and the browser');
    const gate = await waitFor(async () => (fs.existsSync(path.join(STATE, 'port')) ? readPort('port') : null), 10000);
    assert.ok(gate, 'the gate writes its port');
    const status = await waitFor(async () => {
      const body = JSON.parse((await request('GET', gate, '/__pwp/status?pages=0', 5000)).body);
      return body.browser.running && body.browser.pid ? body : null;
    }, 30000);
    assert.ok(status, 'the gate reports a running browser');
    browserPid = status.browser.pid;
    assert.equal(status.browser.adopted, false, 'the gate started the browser itself');

    const cmdline = commandOf(browserPid);
    assert.ok(cmdline.includes(`--user-data-dir=${ALT_PROFILE}`), `browser pid ${browserPid} runs on the alternate profile`);
    assert.ok(!cmdline.includes(`--user-data-dir=${PROFILE}`), `browser pid ${browserPid} is not on the gate profile, so the gate does not own it`);

    const outcome = JSON.parse((await request('POST', gate, `/__pwp/close?self=${session.pid}&force=0`, 30000)).body);
    assert.equal(outcome.closed, false, 'a stop that leaves the browser running is reported as not closed');
    assert.equal(outcome.pid, browserPid, 'the report names the browser that is still running');
    assert.match(outcome.reason, /still answers on port \d+ after the stop/, `the report says why: ${outcome.reason}`);
    assert.equal(isAlive(browserPid), true, `browser pid ${browserPid} is still running after the reported stop`);
    assert.equal((await request('GET', status.debugPort, '/json/version', 5000)).status, 200, 'the debug port still answers after the reported stop');
    console.log(`close-noop: ok: browser pid ${browserPid} was left running and reported as not closed: ${outcome.reason}`);

    await stopPids([browserPid]);
    assert.equal(isAlive(browserPid), false, `the test stopped its own browser pid ${browserPid}`);
    await session.end();
    await finishTest('close-noop');
    fs.rmSync(PROJ, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    console.log('close-noop: all checks passed');
    process.exit(0);
  } catch (error) {
    if (browserPid !== null) await stopPids([browserPid]).catch(() => {});
    session.stop();
    await finishTest('close-noop').catch(() => {});
    console.error(`close-noop: FAILED: ${error.message}`);
    console.error(`gate log: ${GATE_LOG}`);
    console.error(`project kept for inspection: ${PROJ}`);
    process.exit(1);
  }
})();
