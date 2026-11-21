const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin');
const ORIGINAL = path.join(BIN, 'playwriter-project');
const BROKEN = path.join(BIN, '.playwriter-project-red');
const CONTROLS = [
  { name: 'the variable is ignored', from: "args.push(...extra, 'about:blank');", to: "args.push('about:blank');", message: 'lacks the configured flag' },
  { name: 'the project root is taken from the farthest .playwriter', from: "findUp(cwd, ['.playwriter', '.git']) || cwd", to: "findUp(cwd, ['.playwriter']) || findUp(cwd, ['.git']) || cwd", message: 'has no browser state of its own' },
];

const source = fs.readFileSync(ORIGINAL, 'utf8');
let failed = false;
for (const control of CONTROLS) {
  if (source.split(control.from).length !== 2) {
    console.error('chromium-args-red: FAILED: expected one line ' + control.from + ' in bin/playwriter-project');
    process.exit(2);
  }
  fs.writeFileSync(BROKEN, source.replace(control.from, control.to), { mode: 0o755 });
  try {
    const run = spawnSync(process.execPath, [path.join(__dirname, 'chromium-args.cjs')], { env: { ...process.env, PWP_LAUNCHER: BROKEN }, encoding: 'utf8', timeout: 600000 });
    const refused = run.status !== 0 && run.stderr.includes(control.message);
    console.log('chromium-args-red: ' + (refused ? 'ok' : 'FAILED') + ' (' + control.name + '; status ' + run.status + '): ' + (run.stderr.split('\\n')[0] || run.stdout).slice(0, 220));
    failed = failed || !refused;
  } finally {
    fs.rmSync(BROKEN, { force: true });
  }
}
process.exitCode = failed ? 1 : 0;
