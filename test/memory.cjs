const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sleep, projectProcs, summarize, finishTest, mcpSession } = require('./support.cjs');

const SETTLE_MS = 3000;
const PAGE_IDLE_MS = 60000;
const DRAIN_MS = 40000;
const HARD_MS = 280000;
const cleanups = new Set();

async function cleanAll() {
  for (const fn of [...cleanups]) await fn().catch(() => {});
}

async function scenario(name, useBrowser) {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-mem-'));
  const session = mcpSession(proj);
  const stop = async () => {
    session.stop();
    await finishTest(`memory ${name}`);
    fs.rmSync(proj, { recursive: true, force: true });
    cleanups.delete(stop);
  };
  cleanups.add(stop);
  const out = { scenario: name };
  try {
    await session.initialize();
    await sleep(SETTLE_MS);
    out.afterToolsList = summarize(proj);
    if (useBrowser) {
      const text = await session.exec("state.page ??= await context.newPage(); return 'ready'");
      if (!/ready/.test(text)) throw new Error(`execute did not answer: ${text}`);
      await sleep(SETTLE_MS);
      out.afterBrowserUse = summarize(proj);
      await sleep(PAGE_IDLE_MS + SETTLE_MS);
      out.afterPageIdle = summarize(proj);
      out.reopened = await session.exec("const page = await context.newPage(); await page.goto('data:text/html,<title>again</title>'); return await page.title()");
      out.afterReopen = summarize(proj);
    }
    await session.end();
    const started = Date.now();
    while (Date.now() - started < DRAIN_MS && projectProcs(proj).length > 0) await sleep(500);
    out.drainMs = Date.now() - started;
    out.afterSessionEnd = summarize(proj);
  } finally {
    await stop();
  }
  return out;
}

const hard = setTimeout(async () => {
  console.error('memory: timed out, stopping what it started');
  await cleanAll();
  process.exit(1);
}, HARD_MS);

(async () => {
  const results = [];
  results.push(await scenario('never-uses-browser', false));
  results.push(await scenario('uses-browser', true));
  clearTimeout(hard);
  console.log(JSON.stringify(results, null, 2));
  await cleanAll();
  process.exit(0);
})().catch(async (error) => {
  clearTimeout(hard);
  console.error(`memory: FAILED: ${error.message}`);
  await cleanAll();
  process.exit(1);
});
