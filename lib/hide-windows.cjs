'use strict';

const CONSOLE = /(^|[\\/])(node|tsx|ffmpeg|ffprobe|powershell|pwsh|unzip|cmd)(\.exe|\.cmd)?$/i;
const NAMES = ['spawn', 'spawnSync', 'execFile', 'execFileSync'];

function hidden(file, rest) {
  if (typeof file !== 'string' || !CONSOLE.test(file)) return rest;
  const args = [...rest];
  const at = args.findIndex((arg) => arg && typeof arg === 'object' && !Array.isArray(arg));
  if (at >= 0) {
    args[at] = { windowsHide: true, ...args[at] };
    return args;
  }
  const callback = args.findIndex((arg) => typeof arg === 'function');
  args.splice(callback >= 0 ? callback : args.length, 0, { windowsHide: true });
  return args;
}

function patch(target) {
  for (const name of NAMES) {
    const original = target[name];
    target[name] = function (file, ...rest) {
      return original.call(this, file, ...hidden(file, rest));
    };
  }
  return target;
}

function nodeOptions(current) {
  const flag = `--require "${__filename.replaceAll('\\', '/')}"`;
  return current && current.includes(flag) ? current : [current, flag].filter(Boolean).join(' ');
}

if (process.platform === 'win32') {
  patch(require('node:child_process'));
  require('node:module').syncBuiltinESMExports();
}

module.exports = { patch, hidden, nodeOptions };
