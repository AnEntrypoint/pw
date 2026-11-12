const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const file = path.join(ROOT, 'node_modules', 'playwriter', 'dist', 'executor.js');
const text = fs.readFileSync(file, 'utf8');
const helper = text.includes('async defaultBrowserContext(browser) {');
const callSites = (text.match(/await this\.defaultBrowserContext\(browser\)/g) || []).length;
assert.ok(
  helper && callSites === 2,
  'patches/playwriter+0.9.0.patch is not applied to node_modules/playwriter (helper ' + helper + ', call sites ' + callSites + '): run npm install'
);
console.log('ok: node_modules/playwriter carries patches/playwriter+0.9.0.patch');
