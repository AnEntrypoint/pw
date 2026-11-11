const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sleep, projectProcs, mcpSession, finishTest, ROOT } = require('./support.cjs');

const CHILD = path.join(ROOT, 'node_modules', 'playwriter', 'bin.js');
const MCP_TOOLS = require(path.join(ROOT, 'lib', 'mcp-tools.json'));

async function realChildReplies() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-tools-'));
  const child = spawn(process.execPath, [CHILD], {
    cwd: dir,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PLAYWRITER_TELEMETRY: '0', PLAYWRITER_DIRECT: 'ws://127.0.0.1:9/devtools/browser/unused' },
  });
  const replies = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) {
        const msg = JSON.parse(line);
        replies.set(msg.id, msg);
      }
    }
  });
  const waitReply = async (id) => {
    const end = Date.now() + 30000;
    while (!replies.has(id) && Date.now() < end) await sleep(100);
    assert.ok(replies.has(id), `the real child answered request ${id}`);
    return replies.get(id).result;
  };
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'drift', version: '0' } } })}\n`);
    const initialize = await waitReply(1);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    const list = await waitReply(2);
    return { initialize, tools: list.tools };
  } finally {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  const real = await realChildReplies();
  assert.deepEqual(real.initialize, MCP_TOOLS.initialize, 'lib/mcp-tools.json initialize matches the real child');
  assert.deepEqual(real.tools, MCP_TOOLS.tools, 'lib/mcp-tools.json tools match the real child; regenerate it when the pinned playwriter changes');
  console.log(`ok 1: static tool list matches the real child (${real.tools.map((tool) => tool.name).join(', ')})`);

  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-tools-proj-'));
  const session = mcpSession(proj);
  try {
    const initialize = await session.initializeOnly();
    assert.deepEqual(initialize, MCP_TOOLS.initialize);
    const listed = await session.toolsList();
    assert.deepEqual(listed.tools.slice(0, MCP_TOOLS.tools.length), MCP_TOOLS.tools);
    assert.equal(listed.tools.at(-1).name, 'browsers');
    await sleep(500);
    const procs = projectProcs(proj);
    assert.equal(procs.length, 1, `only the launcher runs before a tool call, found ${procs.map((row) => row.cmd).join(' | ')}`);
    console.log('ok 2: the launcher answers initialize and tools/list alone; no child, gate or lease yet');
  } finally {
    session.stop();
    await finishTest('tools');
    fs.rmSync(proj, { recursive: true, force: true });
  }
  await finishTest('tools');
  console.log('tools: all checks passed');
  process.exit(0);
})().catch(async (error) => {
  console.error(`tools: FAILED: ${error.message}`);
  process.exit(1);
});
