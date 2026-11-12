const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn, execFileSync } = require('node:child_process');
const { ROOT, sleep, mcpSession, projectProcs, stopPids, finishTest } = require('./support.cjs');

const EMPTY_MS = 6000;
const MARKER = 'fallback-marker';
const DIST = path.join(ROOT, 'node_modules', 'playwriter', 'dist');
const dist = (file) => pathToFileURL(path.join(DIST, file)).href;
const debugUrl = (proj) => `http://127.0.0.1:${fs.readFileSync(path.join(proj, '.playwriter', 'debug-port'), 'utf8').trim()}`;

async function executorChild(url, mode) {
  const { getChromium } = await import(dist('playwright-import.js'));
  const { PlaywrightExecutor } = await import(dist('executor.js'));
  const chromium = await getChromium();
  const emptyUntil = Date.now() + EMPTY_MS;
  if (mode === 'forced') {
    const connect = chromium.connectOverCDP.bind(chromium);
    chromium.connectOverCDP = async (endpoint, options) => {
      const browser = await connect(endpoint, options);
      const contexts = browser.contexts.bind(browser);
      browser.contexts = () => (Date.now() < emptyUntil ? [] : contexts());
      return browser;
    };
  }
  const executor = new PlaywrightExecutor({ cdpConfig: { directCdpUrl: url }, logger: { log: () => {}, error: console.error } });
  let connected;
  try {
    connected = await executor.connectToBrowser();
  } catch (error) {
    console.log(`FALLBACK threw: ${error.message}`);
    process.exit(0);
  }
  const page = await connected.context.newPage();
  await page.goto(`data:text/html,${MARKER}`);
  console.log('FALLBACK connected');
  setInterval(() => {}, 1000);
}

async function check(url) {
  const { getChromium } = await import(dist('playwright-import.js'));
  const chromium = await getChromium();
  const browser = await chromium.connectOverCDP(url);
  const started = Date.now();
  let found = false;
  while (!found && Date.now() - started < 3000) {
    found = browser.contexts().some((context) => context.pages().some((page) => page.url().includes(MARKER)));
    if (!found) await sleep(200);
  }
  console.log(`CHECK survived=${found}`);
  process.exit(0);
}

function runChild(url, mode, children) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, 'child', url, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${mode} child printed no outcome in 30 s: ${err}`));
    }, 30000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const line = out.split('\n').find((item) => item.startsWith('FALLBACK '));
      if (line) {
        clearTimeout(timer);
        resolve({ child, line });
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      children.delete(child);
      if (!out.includes('FALLBACK ')) reject(new Error(`${mode} child exited ${code} with no outcome: ${err}`));
    });
  });
}

function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGKILL');
  });
}

const surviving = (url) => {
  const out = execFileSync(process.execPath, [__filename, 'check', url], { encoding: 'utf8', timeout: 30000 });
  return out.match(/CHECK survived=(true|false)/)[1] === 'true';
};

async function run() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-fallback-'));
  const launcher = mcpSession(proj);
  const children = new Set();
  try {
    await launcher.initialize();
    assert.match(await launcher.exec("return 'started'"), /started/);
    const url = debugUrl(proj);

    const forced = await runChild(url, 'forced', children);
    if (forced.line === 'FALLBACK connected') {
      await killChild(forced.child);
      await sleep(2000);
      const survived = surviving(url);
      console.log(`forced empty connect: the executor opened a page, then died; page survived ${survived}`);
      assert.equal(survived, true, 'a page the executor opens on a forced empty connect survives the executor dying (the fallback browser.newContext() dies with its connection)');
    } else {
      assert.match(forced.line, /threw: .*lists no default context/, 'a forced empty connect refuses instead of opening a page in a context that dies with the connection');
      console.log(`forced empty connect: ${forced.line.replace('FALLBACK ', '')}`);
    }

    const normal = await runChild(url, 'normal', children);
    assert.equal(normal.line, 'FALLBACK connected', `a normal connect opens a page: ${normal.line}`);
    await killChild(normal.child);
    await sleep(2000);
    assert.equal(surviving(url), true, 'a page the executor opens on a normal connect survives the executor dying');
    console.log('normal connect: the page survived the executor dying');
  } finally {
    for (const child of children) child.kill('SIGKILL');
    await launcher.end(5000);
    await stopPids(projectProcs(proj).map((row) => row.pid));
    fs.rmSync(proj, { recursive: true, force: true });
  }
}

const [mode, url, kind] = process.argv.slice(2);
if (mode === 'child') {
  executorChild(url, kind).catch((error) => {
    console.log(`FALLBACK threw: ${error.message}`);
    process.exit(0);
  });
} else if (mode === 'check') {
  check(url).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
} else {
  (async () => {
    await run();
    await finishTest('fallback');
    console.log('fallback: all checks passed');
  })().catch(async (error) => {
    console.error(`fallback: FAILED: ${error.message}`);
    await finishTest('fallback').catch(() => {});
    process.exitCode = 1;
  });
}
