const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WRAPPER = path.join(ROOT, 'bin', 'playwriter-project');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  if (row.cmd.includes('--gate')) return 'gate';
  if (row.cmd.includes('--type=')) return 'browser-child';
  if (row.cmd.includes('--user-data-dir=')) return 'browser';
  if (row.cmd.includes('playwriter-project')) return 'launcher';
  return 'playwriter-mcp';
}

function summarize(proj) {
  const rows = projectProcs(proj);
  const byLabel = {};
  for (const row of rows) byLabel[label(row)] = (byLabel[label(row)] ?? 0) + 1;
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

const stopProject = async (proj) => stopPids(projectProcs(proj).map((row) => row.pid));

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
    async exec(code) {
      const msg = await call('tools/call', { name: 'execute', arguments: { code } });
      return (msg.result?.content ?? []).map((part) => part.text).join('');
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

module.exports = { sleep, projectProcs, summarize, stopProject, stopPids, alive, mcpSession };
