const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [logDir, runId] = process.argv.slice(2);
const file = path.join(logDir, 'watch.jsonl');
const mark = `PHASEB_RUN=${runId}`;
const GM = /gm-core|gm-tool|gm serve|gm-job/;
const TRACKED = new Set(['gate', 'browser', 'executor', 'launcher', 'foreign-gate', 'foreign-browser', 'gm']);
const INTERVAL_MS = 50;

const emit = (event) => fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
const read = (target) => {
  try {
    return fs.readFileSync(target, 'utf8');
  } catch {
    return '';
  }
};
const tail = (target, lines = 6) => read(target).trimEnd().split('\n').filter(Boolean).slice(-lines);
const procs = require('../test/procs.cjs');
const { pids, statOf, commandOf } = procs;
const varsOf = (pid) => procs.envOf(pid).split('\0');
const varOf = (vars, key) => {
  const hit = vars.find((item) => item.startsWith(`${key}=`));
  return hit ? hit.slice(key.length + 1) : null;
};
const oomKills = () => {
  const match = read('/sys/fs/cgroup/memory.events').match(/oom_kill (\d+)/);
  return match ? Number(match[1]) : null;
};

const roleOf = (command, marked) => {
  if (marked) {
    if (command.includes('--gate')) return 'gate';
    if (command.includes('--type=')) return 'browser-child';
    if (command.includes('--user-data-dir=')) return 'browser';
    if (command.includes('playwriter/bin.js')) return 'executor';
    if (command.includes('playwriter-project')) return 'launcher';
    return 'marked';
  }
  if (command.includes('playwriter-project') && command.includes('--gate')) return 'foreign-gate';
  if (command.includes('--user-data-dir=') && !command.includes('--type=')) return 'foreign-browser';
  if (GM.test(command)) return 'gm';
  return null;
};

const chainOf = (pid) => {
  const chain = [];
  let cursor = pid;
  while (cursor > 1 && chain.length < 40) {
    const info = statOf(cursor);
    if (!info) break;
    const command = commandOf(cursor);
    const role = roleOf(command, varsOf(cursor).includes(mark));
    chain.push({ pid: cursor, role: role ?? '-', command: command.slice(0, 160) });
    cursor = info.ppid;
  }
  return chain;
};

const interesting = (command) => /playwriter|--user-data-dir|gm-core|gm-tool|gm serve|gm-job/.test(command);

let previous = new Map();
let lastOom = oomKills();

const sample = () => {
  const current = new Map();
  for (const pid of pids()) {
    const info = statOf(pid);
    if (!info || info.state === 'Z') continue;
    const command = commandOf(pid);
    if (!command || !interesting(command)) continue;
    const vars = varsOf(pid);
    const marked = vars.includes(mark);
    const role = roleOf(command, marked);
    if (!role || !TRACKED.has(role)) continue;
    const project = varOf(vars, 'PLAYWRITER_PROJECT_DIR');
    current.set(pid, {
      role,
      command: command.slice(0, 160),
      ppid: info.ppid,
      project,
      marked,
      chain: marked ? chainOf(pid) : null,
    });
  }

  const gmAtLastSample = [...previous].filter(([, value]) => value.role === 'gm').map(([pid, value]) => ({ pid, ppid: value.ppid, command: value.command.slice(0, 100) }));
  for (const [pid, before] of previous) {
    if (current.has(pid)) continue;
    const gmAncestors = (before.chain ?? []).filter((entry) => entry.role === 'gm');
    const logs = before.role === 'gate' && before.project
      ? { gateLog: tail(path.join(before.project, '.playwriter', 'gate.log')) }
      : before.role === 'browser' && before.project
        ? { browserLog: tail(path.join(before.project, '.playwriter', 'browser.log'), 3) }
        : {};
    emit({ event: 'gone', pid, role: before.role, command: before.command, ppid: before.ppid, project: before.project, marked: before.marked, chain: before.chain, gmAncestors, gmAtLastSample, oomKill: lastOom, ...logs });
  }
  for (const [pid, now] of current) {
    if (!previous.has(pid)) emit({ event: 'appear', pid, role: now.role, ppid: now.ppid, project: now.project, marked: now.marked, command: now.command });
  }

  const oom = oomKills();
  if (oom !== lastOom) {
    emit({ event: 'oom-kill-count', from: lastOom, to: oom });
    lastOom = oom;
  }
  previous = current;
};

emit({ event: 'start', pid: process.pid, mark });
const timer = setInterval(() => {
  try {
    sample();
  } catch (error) {
    emit({ event: 'sample-error', message: error.message });
  }
}, INTERVAL_MS);
process.on('SIGTERM', () => {
  clearInterval(timer);
  emit({ event: 'stop', tracked: [...previous.values()].map((value) => value.role) });
  process.exit(0);
});
