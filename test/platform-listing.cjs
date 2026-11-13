const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const procs = require('./procs.cjs');
const { finishTest, processTable } = require('./support.cjs');

const CHROME = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir=C:\\pw\\profile --remote-debugging-port=9222';
const powershellScripts = [];
const procReads = [];
const realExecFileSync = childProcess.execFileSync;
const realReadFileSync = fs.readFileSync;
const realReaddirSync = fs.readdirSync;

const refuseProc = (target, syscall) => {
  procReads.push(`${syscall} ${target}`);
  throw Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${target}'`), { code: 'ENOENT' });
};
fs.readFileSync = function readFileSync(target, ...rest) {
  if (typeof target === 'string' && target.startsWith('/proc')) refuseProc(target, 'open');
  return realReadFileSync.call(fs, target, ...rest);
};
fs.readdirSync = function readdirSync(target, ...rest) {
  if (typeof target === 'string' && target.startsWith('/proc')) refuseProc(target, 'scandir');
  return realReaddirSync.call(fs, target, ...rest);
};
childProcess.execFileSync = function execFileSync(file, args, options) {
  if (file !== 'powershell.exe') return realExecFileSync.call(childProcess, file, args, options);
  const script = args.at(-1);
  powershellScripts.push(script);
  if (script.includes('ProcessId=')) return `${CHROME}\n`;
  return JSON.stringify([{ ProcessId: 4242, ParentProcessId: 4000, WorkingSetSize: 1048576, CommandLine: CHROME }]);
};
Object.defineProperty(process, 'platform', { value: 'win32' });

(async () => {
  try {
    const rows = processTable();
    const row = rows.find((item) => item.pid === 4242);
    assert.ok(row, 'the PowerShell listing supplies the process table on win32');
    assert.equal(row.ppid, 4000, 'the parent comes from the listing');
    assert.equal(row.rssKb, 1024, 'the working set comes from the listing');
    assert.ok(row.cmd.includes('--user-data-dir=C:\\pw\\profile'), 'the command line comes from the listing');
    assert.equal(row.env, '', 'no environment is read on win32');
    assert.equal(procs.commandOf(4242), CHROME, 'one pid is looked up through PowerShell');
    assert.equal(procs.envOf(4242), '', 'the environment of another process is not read on win32');
    assert.equal(procs.isAlive(process.pid), true, 'this process is alive, checked without /proc');
    const outcome = await finishTest('platform-listing');
    assert.deepEqual(outcome.leftovers, [], 'the sweep finds no leftovers on win32 and stops nothing');
    assert.ok(powershellScripts.some((script) => script.includes('Win32_Process')), 'the process listing went through PowerShell');
    assert.deepEqual(procReads, [], 'no /proc path was read');
    console.log(`platform-listing: ok: the win32 listing supplied ${rows.length} process row(s) through PowerShell, with no /proc read`);
    console.log('platform-listing: all checks passed');
    process.exit(0);
  } catch (error) {
    console.error(`platform-listing: FAILED: ${error.message}`);
    console.error(`/proc reads: ${procReads.join(', ') || 'none'}`);
    process.exit(1);
  }
})();
