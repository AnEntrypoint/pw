const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const { ROOT, sleep } = require('./support.cjs');

const MODE = process.argv[2];
const DIST = path.join(ROOT, 'node_modules', 'playwriter', 'dist');
const dist = (file) => pathToFileURL(path.join(DIST, file)).href;
const quiet = { log: () => {}, error: () => {} };

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const answers = (port) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 3000 }, (res) => {
    res.resume();
    resolve(res.statusCode === 200);
  });
  req.on('error', () => resolve(false));
  req.on('timeout', () => {
    req.destroy();
    resolve(false);
  });
});
const waitFor = async (check, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return true;
    await sleep(200);
  }
  return false;
};
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const listenerPid = (port) => {
  const out = execFileSync('ss', ['-H', '-ltnp', 'sport', '=', `:${port}`], { encoding: 'utf8' });
  const pid = Number(/pid=(\d+)/.exec(out)?.[1]);
  assert.ok(pid, `a process listens on port ${port}: ${out.trim() || 'nothing'}`);
  return pid;
};

async function direct() {
  const { PlaywrightExecutor } = await import(dist('executor.js'));
  const { resolveBrowserExecutablePath } = await import(dist('browser-config.js'));
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-executor-direct-'));
  const chrome = spawn(resolveBrowserExecutablePath(), [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });
  let pid = null;
  try {
    assert.ok(await waitFor(() => answers(port), 30000), `Chrome answers on port ${port}`);
    pid = listenerPid(port);
    assert.ok(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(`--user-data-dir=${profile}`), `pid ${pid} on port ${port} is this test's browser`);
    const executor = new PlaywrightExecutor({ cdpConfig: { directCdpUrl: `http://127.0.0.1:${port}` }, logger: quiet });
    const first = await executor.ensureConnection();
    const before = first.browser;
    assert.equal(before.isConnected(), true, 'the executor connects to the live browser');
    process.kill(pid, 'SIGKILL');
    const reported = await waitFor(async () => !before.isConnected(), 15000);
    const outcome = await executor.ensureConnection().then((result) => ({ browser: result.browser }), (error) => ({ error }));
    assert.ok(outcome.error || (outcome.browser !== before && outcome.browser.isConnected()), 'ensureConnection does not hand back the dead browser');
    console.log(`executor direct: ok: browser pid ${pid} killed; isConnected reported false: ${reported}; ensureConnection ${outcome.error ? `threw: ${outcome.error.message.split('\n')[0]}` : 'returned a new connection'}`);
    console.log('executor direct: all checks passed');
  } finally {
    if (pid !== null && pidAlive(pid)) process.kill(pid, 'SIGKILL');
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  }
}

async function headless() {
  const { PlaywrightExecutor } = await import(dist('executor.js'));
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: quiet });
  const first = await executor.ensureConnection();
  const before = first.browser;
  assert.equal(before.isConnected(), true, 'the executor launches a live headless browser');
  await before.close();
  const second = await executor.ensureConnection();
  assert.notEqual(second.browser, before, 'ensureConnection does not hand back the closed headless browser');
  assert.equal(second.browser.isConnected(), true, 'the replacement headless browser is connected');
  const page = await second.context.newPage();
  await page.close();
  await second.browser.close();
  console.log('executor headless: ok: after the browser closed, ensureConnection returned a connected replacement that opens a page');
  console.log('executor headless: all checks passed');
}

(async () => {
  if (MODE === 'direct') await direct();
  else if (MODE === 'headless') await headless();
  else {
    console.error('usage: node test/executor.cjs direct|headless');
    process.exit(2);
  }
  process.exit(0);
})().catch((error) => {
  console.error(`executor ${MODE}: FAILED: ${error.message.split('\n')[0]}`);
  process.exit(1);
});
