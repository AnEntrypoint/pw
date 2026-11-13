const fs = require('node:fs');
const childProcess = require('node:child_process');

const readRaw = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const powershell = (script) => childProcess.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
  timeout: 20000,
  maxBuffer: 256 * 1024 * 1024,
});

const linuxPids = () => fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).map(Number);

const statFields = (pid) => {
  const raw = readRaw(`/proc/${pid}/stat`);
  if (raw === null) return null;
  const close = raw.lastIndexOf(')');
  const [state, ppid] = raw.slice(close + 2).split(' ');
  return { state, ppid: Number(ppid) };
};

const linuxRow = (pid) => {
  const stat = statFields(pid);
  if (stat === null) return null;
  const statm = readRaw(`/proc/${pid}/statm`);
  return {
    pid,
    ppid: stat.ppid,
    state: stat.state,
    rssKb: statm ? Number(statm.split(' ')[1]) * 4 : 0,
    cmd: (readRaw(`/proc/${pid}/cmdline`) ?? '').replaceAll('\0', ' '),
    env: readRaw(`/proc/${pid}/environ`) ?? '',
  };
};

const windowsRows = () => {
  const text = powershell('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress').trim();
  if (!text) return [];
  return [].concat(JSON.parse(text)).map((row) => ({
    pid: Number(row.ProcessId),
    ppid: Number(row.ParentProcessId),
    state: '',
    rssKb: Math.round(Number(row.WorkingSetSize ?? 0) / 1024),
    cmd: row.CommandLine ?? '',
    env: '',
  }));
};

const psRows = () => {
  const out = childProcess.execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,rss=,args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return out.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), state: '', rssKb: Number(match[3]), cmd: match[4], env: '' }] : [];
  });
};

function processRows() {
  if (process.platform === 'linux') return linuxPids().map(linuxRow).filter(Boolean);
  if (process.platform === 'win32') return windowsRows();
  return psRows();
}

function pids() {
  return process.platform === 'linux' ? linuxPids() : processRows().map((row) => row.pid);
}

function statOf(pid) {
  return process.platform === 'linux' ? statFields(pid) : null;
}

function commandOf(pid) {
  try {
    if (process.platform === 'linux') return (readRaw(`/proc/${pid}/cmdline`) ?? '').replaceAll('\0', ' ').trim();
    if (process.platform === 'win32') return powershell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`).trim();
    return childProcess.execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function envOf(pid) {
  return process.platform === 'linux' ? (readRaw(`/proc/${pid}/environ`) ?? '') : '';
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === 'EPERM';
  }
  const state = statOf(pid)?.state;
  return state !== 'Z' && state !== 'X';
}

module.exports = { processRows, pids, statOf, commandOf, envOf, isAlive };
