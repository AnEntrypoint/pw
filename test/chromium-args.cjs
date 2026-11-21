const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { WRAPPER, sleep, stopPids, finishTest } = require('./support.cjs');
const { commandOf, isAlive } = require('../lib/procs');

const LAUNCHER = process.env.PWP_LAUNCHER || WRAPPER;
const PROJECTS = [
  { name: 'a', flags: ['--enable-unsafe-webgpu', '--pw-witness-flag=a'] },
  { name: 'b', flags: ['--use-vulkan=swiftshader', '--pw-witness-flag=b'] },
];

const CONTAINER = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-chromium-args-')));
fs.mkdirSync(path.join(CONTAINER, '.playwriter'));
const makeProject = (name) => {
  const dir = path.join(CONTAINER, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
};
const stateOf = (project) => path.join(project, '.playwriter');
const environmentFor = (variable) => {
  const env = { ...process.env, PLAYWRITER_TELEMETRY: '0', PLAYWRITER_CHROMIUM_ARGS: variable };
  delete env.PLAYWRITER_PROJECT_DIR;
  return env;
};
const start = (project, variable) => spawnSync(process.execPath, [LAUNCHER, 'start'], { cwd: project, env: environmentFor(variable), encoding: 'utf8', timeout: 120000 });
const gatePidOf = (project) => Number(/gate pid=(\d+)/.exec(fs.readFileSync(path.join(stateOf(project), 'gate.log'), 'utf8'))?.[1]);
const gone = async (pids) => {
  for (let waited = 0; waited < 15000 && pids.some(isAlive); waited += 250) await sleep(250);
  return !pids.some(isAlive);
};

(async () => {
  const started = [];
  const dirs = [CONTAINER];
  try {
    const rows = [];
    for (const project of PROJECTS) {
      const dir = makeProject(project.name);
      dirs.push(dir);
      const result = start(dir, JSON.stringify(project.flags));
      assert.equal(result.status, 0, 'start in project ' + project.name + ' failed: ' + result.stderr.slice(-400));
      assert.ok(fs.existsSync(path.join(stateOf(dir), 'browser.pid')), 'project ' + project.name + ' has no browser state of its own under ' + stateOf(dir) + ': its project root was taken from an ancestor');
      const browser = Number(fs.readFileSync(path.join(stateOf(dir), 'browser.pid'), 'utf8'));
      const gate = gatePidOf(dir);
      started.push(browser, gate);
      rows.push({ ...project, dir, browser, gate, command: commandOf(browser) ?? '', log: fs.readFileSync(path.join(stateOf(dir), 'gate.log'), 'utf8') });
    }
    for (const row of rows) {
      const profile = '--user-data-dir=' + path.join(row.dir, '.playwriter', 'browser-profile');
      assert.ok(row.command.includes(profile), 'the browser of project ' + row.name + ' does not run with ' + profile + ': ' + row.command.slice(0, 300));
      for (const flag of row.flags) assert.ok(row.command.split(' ').includes(flag), 'the browser of project ' + row.name + ' lacks the configured flag ' + flag + ': ' + row.command.slice(0, 400));
      assert.ok(!row.command.split(' ').includes('--disable-gpu'), 'the browser of project ' + row.name + ' still runs with --disable-gpu although its flags enable the GPU');
      assert.ok(row.log.includes('browser flags applied from PLAYWRITER_CHROMIUM_ARGS: ' + row.flags.join(' ')), 'the gate log of project ' + row.name + ' does not name the flags applied');
      assert.ok(row.log.includes('project ' + row.dir + ' from cwd'), 'the gate log of project ' + row.name + ' does not say its project came from the working directory');
    }
    const [first, second] = rows;
    assert.notEqual(first.browser, second.browser, 'both projects share one browser pid');
    assert.notEqual(first.gate, second.gate, 'both projects share one gate pid');
    assert.ok(!first.command.includes(second.dir) && !second.command.includes(first.dir), 'a browser command line names the other project');
    assert.ok(!first.command.includes(second.flags[1]) && !second.command.includes(first.flags[1]), 'a browser carries the other project flags');

    const invalidDir = makeProject('invalid');
    dirs.push(invalidDir);
    for (const bad of ['not json', '{"a":1}', '["--ok", 3]']) {
      const refused = start(invalidDir, bad);
      assert.notEqual(refused.status, 0, 'PLAYWRITER_CHROMIUM_ARGS=' + bad + ' was accepted');
      assert.ok(refused.stderr.includes('PLAYWRITER_CHROMIUM_ARGS'), 'the refusal of ' + bad + ' does not name the variable: ' + refused.stderr.slice(0, 300));
    }
    assert.ok(!fs.existsSync(stateOf(invalidDir)), 'an invalid variable still started a gate for the project');

    console.log('chromium-args: ok (' + rows.map((row) => 'project ' + row.name + ': browser ' + row.browser + ', gate ' + row.gate + ', ' + row.command.split(' ').find((part) => part.startsWith('--user-data-dir=')) + ', ' + row.flags.join(' ')).join('; ') + '; three invalid values refused with the variable named)');
  } catch (error) {
    console.error('chromium-args: FAILED: ' + error.message);
    process.exitCode = 1;
  } finally {
    await stopPids(started);
    await gone(started);
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    await finishTest('chromium-args').catch((error) => {
      console.error('chromium-args: FAILED: ' + error.message);
      process.exitCode = 1;
    });
  }
})();
