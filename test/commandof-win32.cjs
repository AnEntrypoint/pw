const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { commandOf } = require('../lib/procs');

const CHROME = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir=C:\\pw\\profile --remote-debugging-port=9222';
const calls = [];
const realExecFileSync = childProcess.execFileSync;
let respond = () => '';

childProcess.execFileSync = function execFileSync(file, args, options) {
  if (file !== 'powershell.exe') return realExecFileSync.call(childProcess, file, args, options);
  const script = args.at(-1);
  calls.push({ script, timeout: options.timeout });
  return respond(script);
};
Object.defineProperty(process, 'platform', { value: 'win32' });

const lastScript = () => calls.at(-1).script;

try {
  respond = () => `${CHROME}\r\n`;
  assert.equal(commandOf(4242), CHROME, 'the command line of one pid comes back trimmed, with the CRLF PowerShell prints removed');
  assert.ok(lastScript().includes('-Filter "ProcessId=4242"'), 'the query names the pid');
  assert.ok(lastScript().includes('Win32_Process') && lastScript().includes(').CommandLine'), 'the query reads the command line of Win32_Process');
  assert.equal(calls.at(-1).timeout, 10000, 'the query has the same 10 s timeout as the launcher had');
  console.log('commandof-win32: ok: the success path returns the trimmed command line from PowerShell');

  assert.ok(commandOf(4242).includes('--user-data-dir=C:\\pw\\profile'), 'the gate finds its own profile in a Windows command line');
  assert.equal(commandOf(4242).includes('--user-data-dir=C:\\pw\\other'), false, 'another profile is not matched as the gate profile');
  console.log('commandof-win32: ok: the profile match the gate uses (ownedBrowserPids) finds this project profile and no other');

  respond = () => {
    throw Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' });
  };
  assert.equal(commandOf(4242), '', 'when PowerShell cannot run, the command line is empty, so the pid is not claimed as this project browser');
  console.log('commandof-win32: ok: a PowerShell failure gives an empty command line');

  respond = (script) => {
    if (script.includes('ProcessId=NaN')) throw new Error('Cannot convert the value to a type');
    return CHROME;
  };
  assert.equal(commandOf('4242; Remove-Item C:\\x'), '', 'a pid that is not a number gives an empty command line');
  assert.ok(lastScript().includes('ProcessId=NaN'), 'the pid is converted to a number before it reaches PowerShell');
  assert.equal(lastScript().includes('Remove-Item'), false, 'the text of the pid never reaches the PowerShell script');
  console.log('commandof-win32: ok: a pid that is not a number is converted to NaN and never reaches the script as text');

  respond = () => '';
  assert.equal(commandOf(4242), '', 'a pid with no process gives an empty command line');
  console.log('commandof-win32: ok: an unknown pid gives an empty command line');

  const launcher = fs.readFileSync(path.join(__dirname, '..', 'bin', 'playwriter-project'), 'utf8');
  assert.ok(launcher.includes("const { commandOf } = require('../lib/procs');"), 'the launcher imports commandOf from lib/procs');
  assert.equal(launcher.includes('function commandOf('), false, 'the launcher does not define its own commandOf');
  console.log('commandof-win32: ok: the gate imports this commandOf and defines none of its own');

  console.log('commandof-win32: all checks passed');
  process.exit(0);
} catch (error) {
  console.error(`commandof-win32: FAILED: ${error.message}`);
  process.exit(1);
}
