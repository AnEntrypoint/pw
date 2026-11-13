const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WRAPPER = path.join(ROOT, 'bin', 'playwriter-project');

const TOKEN = randomUUID();
process.env.PWP_TEST_TOKEN = TOKEN;
process.env.PLAYWRITER_NO_SANDBOX = '1';
const TOKEN_MARK = `PWP_TEST_TOKEN=${TOKEN}\0`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const GONE_AFTER_PROBES = 3;
const PROBE_GAP_MS = 1000;
const confirmedGone = async (probe, gapMs = PROBE_GAP_MS) => {
  for (let miss = 1; miss <= GONE_AFTER_PROBES; miss += 1) {
    if (await probe()) return false;
    if (miss < GONE_AFTER_PROBES) await sleep(gapMs);
  }
  return true;
};
const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

function processTable() {
  const rows = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = readText(`/proc/${entry}/stat`);
    if (stat === null) continue;
    const [state, ppid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const statm = readText(`/proc/${entry}/statm`);
    rows.push({
      pid: Number(entry),
      ppid: Number(ppid),
      state,
      rssKb: statm ? Number(statm.split(' ')[1]) * 4 : 0,
      cmd: (readText(`/proc/${entry}/cmdline`) ?? '').replaceAll('\0', ' '),
      env: readText(`/proc/${entry}/environ`) ?? '',
    });
  }
  return rows;
}

function projectProcs(proj) {
  const marker = `PLAYWRITER_PROJECT_DIR=${proj}\0`;
  return processTable().filter((row) => row.state !== 'Z' && row.pid !== process.pid && (row.cmd.includes(proj) || row.env.includes(marker)));
}

function label(row) {
  if (row.cmd.includes('playwriter-ws-server')) return 'relay';
  if (row.cmd.includes('--gate')) return 'gate';
  const type = /--type=(\S+)/.exec(row.cmd)?.[1];
  if (type) {
    const sub = /--utility-sub-type=(\S+)/.exec(row.cmd)?.[1];
    return sub ? `browser-${type}:${sub.split('.').pop()}` : `browser-${type}`;
  }
  if (row.cmd.includes('--user-data-dir=')) return 'browser';
  if (row.cmd.includes('playwriter-project')) return 'launcher';
  return 'playwriter-mcp';
}

function summarize(proj) {
  const rows = projectProcs(proj);
  const byLabel = {};
  for (const row of rows) {
    const key = label(row);
    byLabel[key] ??= { processes: 0, rssMB: 0 };
    byLabel[key].processes += 1;
    byLabel[key].rssMB += Math.round(row.rssKb / 1024);
  }
  return { processes: rows.length, rssMB: Math.round(rows.reduce((sum, row) => sum + row.rssKb, 0) / 1024), byLabel };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function stopPids(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  await sleep(1500);
  for (const pid of pids.filter(alive)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

function ownedRows() {
  return processTable().filter((row) => row.pid !== process.pid && row.state !== 'Z' && row.env.includes(TOKEN_MARK));
}

async function finishTest(name, { graceMs = 15000 } = {}) {
  const end = Date.now() + graceMs;
  let rows = ownedRows();
  while (rows.length > 0 && Date.now() < end) {
    await sleep(200);
    rows = ownedRows();
  }
  const leftovers = rows.map((row) => `${row.pid} ${label(row)}`);
  await stopPids(rows.map((row) => row.pid));
  if (leftovers.length > 0) throw new Error(`${name} left its own processes behind: ${leftovers.join(', ')}`);
  return { leftovers };
}

function mcpSession(proj, env = {}) {
  const child = spawn(process.execPath, [WRAPPER], {
    cwd: proj,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PLAYWRITER_PROJECT_DIR: proj, PLAYWRITER_TELEMETRY: '0', ...env },
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const waiters = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 90000);
    waiters.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return {
    pid: child.pid,
    exited,
    stderr: () => stderr,
    async initialize() {
      await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'witness', version: '0' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return call('tools/list', {});
    },
    async initializeOnly() {
      const msg = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'witness', version: '0' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return msg.result;
    },
    async toolsList() {
      return (await call('tools/list', {})).result;
    },
    async exec(code) {
      const msg = await call('tools/call', { name: 'execute', arguments: { code } });
      return (msg.result?.content ?? []).map((part) => part.text).join('') || JSON.stringify(msg);
    },
    async end(ms = 15000) {
      child.stdin.end();
      await Promise.race([exited, sleep(ms)]);
    },
    stop() {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    },
  };
}

module.exports = { ROOT, WRAPPER, TOKEN, sleep, GONE_AFTER_PROBES, PROBE_GAP_MS, confirmedGone, processTable, projectProcs, label, summarize, stopPids, alive, finishTest, ownedRows, mcpSession };
