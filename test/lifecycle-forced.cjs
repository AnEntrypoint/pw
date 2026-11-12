const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const POINTS = {
  check11: { message: 'forced failure at check 11', marker: "FORCE === 'check11'" },
  cleanup: { message: 'forced failure in cleanup', marker: "FORCE === 'cleanup'" },
};
const point = process.argv[2];
assert.ok(point in POINTS, `use one of ${Object.keys(POINTS).join(', ')}`);

const lifecycle = path.join(__dirname, 'lifecycle.cjs');
const expectedLine = fs.readFileSync(lifecycle, 'utf8').split('\n').findIndex((line) => line.includes(POINTS[point].marker)) + 1;
assert.ok(expectedLine > 0, `the marker for ${point} is in lifecycle.cjs`);

const run = spawnSync(process.execPath, [lifecycle], {
  env: { ...process.env, PWP_LIFECYCLE_FORCE: point },
  encoding: 'utf8',
  timeout: 300000,
});
assert.equal(run.error, undefined, `the forced run ended: ${run.error}`);
assert.equal(run.status, 1, `a forced ${point} failure exits 1: ${run.stderr}`);
assert.match(run.stderr, new RegExp(`failure: ${POINTS[point].message}`), 'stderr names the message');
const kept = /project kept for inspection: (\S+)/.exec(run.stderr)?.[1];
assert.ok(kept, 'stderr names the kept directory');
const text = fs.readFileSync(path.join(kept, 'failure.txt'), 'utf8');
assert.match(text, new RegExp(`failure: ${POINTS[point].message}`), 'failure.txt names the message');
assert.match(text, new RegExp(`line: ${expectedLine}\n`), `failure.txt names line ${expectedLine}`);
assert.match(text, /stack:\n[\s\S]*lifecycle\.cjs:\d+/, 'failure.txt holds the stack');
assert.match(text, /gate status: \{"project":/, 'failure.txt holds the gate status');
assert.match(text, /browser\.log, last 20 lines:/, 'failure.txt holds the browser log tail');
console.log(`ok: forced ${point} fails with the message, line ${expectedLine}, the stack, the gate status and the browser log tail; kept ${kept}`);
