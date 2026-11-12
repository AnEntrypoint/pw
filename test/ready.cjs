const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sleep, mcpSession, projectProcs, stopPids, finishTest } = require('./support.cjs');

const TRIALS = 3;
const WATCH_MS = 30000;
const OPEN = "state.ready = await context.newPage(); await state.ready.goto('data:text/html,ready-marker'); return 'opened'";
const CHECK = "const contexts = context.browser().contexts(); return 'READY executorIsDefault=' + (contexts[0] === context) + ' contexts=' + contexts.length";

const answers = (port) => fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
  .then((res) => res.ok)
  .catch(() => false);
const pageTargets = (port) => fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
  .then((res) => res.json())
  .then((list) => list.filter((target) => target.type === 'page').length)
  .catch(() => 0);

async function timeStartup(proj, started, isDone) {
  const file = path.join(proj, '.playwriter', 'debug-port');
  let port = null;
  let portAt = null;
  let pageAt = null;
  while (!isDone() && pageAt === null && Date.now() - started < WATCH_MS) {
    if (port === null && fs.existsSync(file)) port = fs.readFileSync(file, 'utf8').trim();
    if (port !== null && portAt === null && (await answers(port))) portAt = Date.now() - started;
    if (portAt !== null && (await pageTargets(port)) > 0) pageAt = Date.now() - started;
    await sleep(20);
  }
  return { portAt, pageAt };
}

async function trial(index) {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ready-'));
  const launcher = mcpSession(proj);
  try {
    await launcher.initialize();
    let finished = false;
    const started = Date.now();
    const watch = timeStartup(proj, started, () => finished);
    const opened = await launcher.exec(OPEN).finally(() => {
      finished = true;
    });
    const { portAt, pageAt } = await watch;
    assert.match(opened, /opened/, `trial ${index}: the first call opens a page`);
    const reply = await launcher.exec(CHECK);
    const line = (reply.match(/READY executorIsDefault=\w+ contexts=\d+/) || ['no READY line'])[0];
    const gap = portAt === null || pageAt === null ? 'n/a' : `${pageAt - portAt} ms`;
    console.log(`ready trial ${index}: port answered at ${portAt} ms, first page target at ${pageAt} ms, gap ${gap}; ${line}`);
    assert.match(line, /executorIsDefault=true contexts=[1-9]/, `trial ${index}: the executor uses the default context the browser lists`);
  } finally {
    await launcher.end(5000);
    await stopPids(projectProcs(proj).map((row) => row.pid));
    fs.rmSync(proj, { recursive: true, force: true });
  }
}

(async () => {
  for (let index = 1; index <= TRIALS; index += 1) await trial(index);
  await finishTest('ready');
  console.log('ready: all checks passed');
})().catch(async (error) => {
  console.error(`ready: FAILED: ${error.message}`);
  await finishTest('ready').catch(() => {});
  process.exitCode = 1;
});
