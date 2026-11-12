const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectProcs, stopPids, mcpSession } = require('./support.cjs');

const OPEN = "state.mode = await context.newPage(); await state.mode.goto('data:text/html,mode-witness'); return 'opened'";
const DIRECT = 'PLAYWRITER_DIRECT=ws://';

(async () => {
  const started = Date.now();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-mode-'));
  const launcher = mcpSession(proj);
  let result = null;
  try {
    await launcher.initialize();
    const reply = await launcher.exec(OPEN);
    assert.match(reply, /opened/, 'execute did not open a page with no extension connected: ' + reply.slice(0, 200));
    const rows = projectProcs(proj);
    const relays = rows.filter((row) => row.cmd.includes('playwriter-ws-server'));
    const executors = rows.filter((row) => row.cmd.includes('playwriter/bin.js'));
    assert.equal(relays.length, 0, 'an extension relay runs on the launcher path');
    assert.ok(executors.length > 0, 'no executor child runs');
    const unset = executors.filter((row) => !row.env.includes(DIRECT));
    assert.equal(unset.length, 0, 'executor children without PLAYWRITER_DIRECT: ' + unset.map((row) => row.pid).join(','));
    result = { executeReply: 'opened', extensionsConnected: 0, relays: relays.length, executorChildren: executors.length, childrenWithDirectUrl: executors.length, selected: 'direct CDP (dist/executor.js:737)', notReached: 'extension branch (dist/executor.js:764)', wallMs: Date.now() - started };
  } finally {
    await launcher.end(3000);
    await stopPids(projectProcs(proj).map((row) => row.pid));
    fs.rmSync(proj, { recursive: true, force: true });
  }
  console.log('mode: ' + JSON.stringify(result));
})().catch((error) => {
  console.error('mode: FAILED ' + error.message);
  process.exitCode = 1;
});
