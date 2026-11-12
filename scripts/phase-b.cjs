const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = randomUUID();
const MARK = `PHASEB_RUN=${RUN_ID}`;
const ROW_NAME = /^[\w-]+$/;
const LEFTOVER_GRACE_MS = 15000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const markedPids = () => {
  const pids = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let vars = '';
    try {
      vars = fs.readFileSync(`/proc/${entry}/environ`, 'utf8');
    } catch {
      continue;
    }
    if (vars.split('\0').includes(MARK)) pids.push(Number(entry));
  }
  return pids;
};

const signal = (pid, name) => {
  try {
    process.kill(pid, name);
  } catch {}
};

const stopLeftovers = async () => {
  const deadline = Date.now() + LEFTOVER_GRACE_MS;
  let pids = markedPids();
  while (pids.length > 0 && Date.now() < deadline) {
    await sleep(200);
    pids = markedPids();
  }
  const leftover = pids.length;
  for (const pid of pids) signal(pid, 'SIGTERM');
  if (leftover > 0) await sleep(1500);
  for (const pid of markedPids()) signal(pid, 'SIGKILL');
  return leftover;
};

const runRow = (name, command, logDir) => new Promise((resolve) => {
  const started = Date.now();
  const log = fs.openSync(path.join(logDir, `${name}.log`), 'w');
  const child = spawn('sh', ['-c', command], {
    cwd: ROOT,
    env: { ...process.env, PHASEB_RUN: RUN_ID },
    stdio: ['ignore', log, log],
  });
  child.on('error', (error) => {
    fs.writeSync(log, `${error.message}\n`);
    fs.closeSync(log);
    resolve({ code: 1, wallMs: Date.now() - started });
  });
  child.on('exit', (code) => {
    fs.closeSync(log);
    resolve({ code: code ?? 1, wallMs: Date.now() - started });
  });
});

(async () => {
  const args = process.argv.slice(2);
  const watch = args[0] === '--watch';
  if (watch) args.shift();
  const [logDir, ...specs] = args;
  if (!logDir || specs.length === 0) {
    console.error('usage: node scripts/phase-b.cjs [--watch] <log-dir> <name>=<command>...');
    process.exitCode = 2;
    return;
  }
  const rows = specs.map((spec) => {
    const at = spec.indexOf('=');
    return { name: spec.slice(0, at), command: spec.slice(at + 1) };
  });
  const badName = rows.find((row) => !ROW_NAME.test(row.name));
  if (badName || rows.some((row) => !row.command)) {
    console.error(`bad row: ${JSON.stringify(badName ?? rows.find((row) => !row.command))}`);
    process.exitCode = 2;
    return;
  }

  const resultFile = path.join(logDir, 'result.txt');
  let watcher = null;
  if (watch) {
    const out = fs.openSync(path.join(logDir, 'watch.log'), 'w');
    watcher = spawn(process.execPath, [path.join(ROOT, 'scripts', 'watch.cjs'), logDir, RUN_ID], {
      cwd: ROOT,
      stdio: ['ignore', out, out],
    });
    await sleep(300);
  }

  let worst = 0;
  for (const row of rows) {
    const run = await runRow(row.name, row.command, logDir);
    const leftover = await stopLeftovers();
    const effective = run.code !== 0 ? run.code : leftover > 0 ? 1 : 0;
    worst = Math.max(worst, effective);
    fs.appendFileSync(resultFile, `${row.name} exit ${run.code} wall ${run.wallMs} ms leftover ${leftover} effective ${effective}\n`);
  }

  if (watcher) {
    const stopped = new Promise((resolve) => watcher.once('exit', resolve));
    watcher.kill('SIGTERM');
    await stopped;
  }
  fs.appendFileSync(resultFile, `runner worst exit ${worst}\n`);
  process.exitCode = worst;
})();
