const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const HOST = '127.0.0.1';
const CACHE_MS = 2000;
const PROBE_MS = 700;
const BROWSER_BINARY = /^(chromium(\.real)?|chromium-browser|chrome|chrome-headless-shell|headless_shell|google[ -]chrome.*)(\.exe)?$/i;

let cache = null;
let latest = null;

const basename = (file) => file.split(/[\\/]/).pop();

const readRaw = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const readText = (file) => readRaw(file)?.trim() ?? null;

const flag = (argv, name) => {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
};

const isBrowserMain = (argv) => argv.length > 0
  && BROWSER_BINARY.test(basename(argv[0]))
  && !argv.some((arg) => arg.startsWith('--type='));

function getJson(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: urlPath, timeout: PROBE_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(body) : null);
        } catch {
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function splitCmdline(raw) {
  const parts = raw.split('\0').filter(Boolean);
  return parts.length > 1 ? parts : (parts[0] ?? '').split(/ (?=--)/).filter(Boolean);
}

function linuxProcesses() {
  const rows = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const argv = splitCmdline(readRaw(`/proc/${entry}/cmdline`) ?? '');
    if (argv.length) rows.push({ pid: Number(entry), argv });
  }
  return rows;
}

function windowsArgv(commandLine) {
  return (commandLine.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((token) => token.replace(/"/g, ''));
}

function windowsProcesses() {
  const script = 'Get-CimInstance Win32_Process -Filter "Name LIKE \'chrom%\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 10000, windowsHide: true }, (error, stdout) => {
      if (error) return reject(error);
      const text = stdout.trim();
      if (!text) return resolve([]);
      const rows = [].concat(JSON.parse(text)).filter((row) => row.CommandLine);
      resolve(rows.map((row) => ({ pid: row.ProcessId, argv: windowsArgv(row.CommandLine) })));
    });
  });
}

function darwinProcesses() {
  const out = execFileSync('ps', ['-axww', '-o', 'pid=,args='], { encoding: 'utf8', timeout: PROBE_MS });
  return out.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), argv: match[2].split(/ (?=--)/) }] : [];
  });
}

function projectOf(profile) {
  if (!profile) return null;
  const dir = path.resolve(profile);
  if (basename(dir) !== 'browser-profile') return null;
  const state = path.dirname(dir);
  return basename(state) === '.playwriter' ? path.dirname(state) : null;
}

async function gateOf(project) {
  const port = Number(readText(path.join(project, '.playwriter', 'port'))) || null;
  const ping = port ? await getJson(port, '/__pwp/ping') : null;
  return ping?.project === project ? { pid: ping.pid ?? null, port } : null;
}

function windowCount(pid) {
  if (process.platform !== 'linux' || !process.env.DISPLAY) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('xdotool', ['search', '--pid', String(pid)], { encoding: 'utf8', timeout: PROBE_MS }, (error, stdout) => {
      if (error && error.code !== 1) return resolve(null);
      resolve(stdout.split('\n').filter(Boolean).length);
    });
  });
}

async function describe({ pid, argv }) {
  const port = Number(flag(argv, 'remote-debugging-port')) || null;
  const profile = flag(argv, 'user-data-dir');
  const project = projectOf(profile);
  const [gate, targets, windows] = await Promise.all([
    project ? gateOf(project) : null,
    port ? getJson(port, '/json/list') : null,
    windowCount(pid),
  ]);
  return {
    pid,
    profile,
    port,
    project,
    gate,
    windows,
    adopted: project !== null && Number(readText(path.join(project, '.playwriter', 'browser.pid'))) !== pid,
    pages: Array.isArray(targets)
      ? targets.filter((target) => target.type === 'page').map(({ id, title, url }) => ({ id, title, url }))
      : null,
  };
}

async function processRows() {
  if (process.platform === 'linux') return linuxProcesses();
  if (process.platform === 'darwin') return darwinProcesses();
  if (process.platform === 'win32') return windowsProcesses();
  return null;
}

async function scan() {
  const started = Date.now();
  const procs = await processRows();
  if (procs === null) return { supported: false, error: `not covered on ${process.platform}`, browsers: [], ms: 0 };
  const found = await Promise.all(procs.filter((proc) => isBrowserMain(proc.argv)).map(describe));
  return { supported: true, error: null, browsers: found.sort((a, b) => a.pid - b.pid), ms: Date.now() - started };
}

function listBrowsers({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.value);
  const run = scan()
    .catch((error) => ({ supported: false, error: error.message, browsers: [], ms: 0 }))
    .then((value) => {
      if (run === latest) cache = { at: Date.now(), value };
      return value;
    });
  latest = run;
  return run;
}

function ownerOf(browser, project) {
  if (browser.project === null) return 'none (not started by pw)';
  if (browser.project === project) return browser.gate ? `this project's gate pid ${browser.gate.pid}` : 'this project, no gate running';
  return browser.gate ? `gate pid ${browser.gate.pid} for ${browser.project}` : `no gate running for ${browser.project}`;
}

function browserLine(browser, project) {
  const pages = browser.pages ? browser.pages.length : browser.port ? '?' : 'n/a';
  const parts = [
    `pid ${browser.pid}`,
    `owner ${ownerOf(browser, project)}`,
    `profile ${browser.profile ?? 'default (no --user-data-dir)'}`,
    `debug port ${browser.port ?? 'none'}`,
    `pages ${pages}`,
  ];
  if (browser.windows !== null) parts.push(`windows ${browser.windows}`);
  if (browser.adopted) parts.push('ADOPTED');
  return parts.join(', ');
}

function browserLines(result, project) {
  if (!result.supported) return [`browsers: not scanned, ${result.error}`];
  if (result.browsers.length === 0) return ['browsers: none open'];
  return [
    `browsers: ${result.browsers.length} open on this machine (scan ${result.ms} ms)`,
    ...result.browsers.flatMap((browser) => [
      `  ${browserLine(browser, project)}`,
      ...(browser.project === project
        ? (browser.pages ?? []).map((page) => `    page ${page.id} ${page.url} "${String(page.title).replace(/\s+/g, ' ')}"`)
        : []),
    ]),
  ];
}

function browserReport(result, project) {
  return {
    supported: result.supported,
    error: result.error,
    scanMs: result.ms,
    browsers: result.browsers.map((browser) => ({
      pid: browser.pid,
      owner: browser.project === null ? 'none' : browser.project === project ? 'this project' : 'other project',
      project: browser.project,
      gatePid: browser.gate?.pid ?? null,
      profile: browser.profile,
      debugPort: browser.port,
      pages: browser.pages ? browser.pages.length : null,
      windows: browser.windows,
      adopted: browser.adopted,
      ...(browser.project === project ? { pageList: browser.pages } : {}),
    })),
  };
}

module.exports = { listBrowsers, browserLines, browserReport };
