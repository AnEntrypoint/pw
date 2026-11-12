# Pending validation

Each line names a change, the file it touches, and the witness that must be green before the push. Status after Phase B (commit 24646cc): all rows green, `npm test` exit 0, `node test/memory.cjs` exit 0.

- test/support.cjs, test/lifecycle.cjs, test/leases.cjs, test/tools.cjs, test/memory.cjs (T1): each test process carries a unique PWP_TEST_TOKEN in its environment; a test stops only processes carrying its token, and finishTest fails the run if any of its processes is still alive after the grace. Witness: `npm test` passes, and no test prints a leftover error.
- test/tools.cjs (T2): the raw child runs with PLAYWRITER_DIRECT, so it starts no CDP relay. Witness: `lsof -t -iTCP:19988 -sTCP:LISTEN` shows the same pids before and after `node test/tools.cjs`.
- test/memory.cjs (M1): per-type table, idle page close, reopen check. Witness: `node test/memory.cjs` prints afterPageIdle and reopened with title "again".
- bin/playwriter-project (B1): trimmed Chromium flags, --disable-gpu unless PLAYWRITER_WEBGPU=1, one renderer per site. Witness: memory.cjs browser table after the change, and npm test green.
- bin/playwriter-project (B2): idle pages closed while a lease is held (PLAYWRITER_PAGE_IDLE_MS, default 60000); the browser stays up. Witness: memory.cjs afterPageIdle has fewer page targets, reopened returns "again".
- docs/CONSUMERS.md (D1): pin updated to the commit that carries B1 and B2. Witness: the pin resolves to that commit on origin.

Round 3 (idle held lease, renderers, gate RSS):

- bin/playwriter-project (R1): the browser path is resolved in a short-lived node child, so the gate never loads playwright-core. Witness: memory.cjs gate RSS falls from about 118 MB to about 60 MB.
- bin/playwriter-project (R2): calls mark their lease busy and idle through /__pwp/busy; the gate exits when no browser is up and no call is in flight for a grace; the launcher retires its child and lease when its browser has gone idle, and reopens on the next call. Witness: test/leases.cjs reopenAfterIdle and idleSessionWhileSharedCallRuns pass.
- bin/playwriter-project (R3): --renderer-process-limit=1, and the startup about:blank tab closes once another page exists. Witness: memory.cjs renderer count below 4 with one page.
- test/leases.cjs, test/memory.cjs (R4): the new lease scenarios and the idle wait for retirement. Witness: npm test exit 0; memory.cjs exit 0.
- docs/CONSUMERS.md (R5): final pin and the note that the relay needs no work in this repo. Witness: the pin resolves on origin.

Round 4 (first-open page survives a gate restart):

- node_modules/playwriter/dist/executor.js:737 and :764, and src/executor.ts:973 and :1010 (F1, upstream playwriter 0.9.0; node_modules is gitignored, so the change lands in the playwriter package, not in this repo): connectToBrowser picks contexts[0] when browser.contexts() lists one, else browser.newContext(). With no listed context, the run's page goes into a new context that Chrome disposes when the executor connection closes, so a gate SIGKILL loses it. Change needed: when browser.contexts() is empty, open the first page in the default context (Target.createTarget with no browserContextId, sent on a browser-level CDP session) and use browser.contexts()[0] instead of browser.newContext(). The headless branch (dist/executor.js:785, src/executor.ts:1038) is not used by the launcher and is left alone. This reverses the rule in the connectToBrowser doc comment (never opens a tab), so the owner decides it before the playwriter change lands. Witness: open a page through the launcher, SIGKILL the gate by its own PID, start a new gate, then a new executor lists that page URL in browser.contexts()[0].pages() in the default context; the check prints firstPageSurvivedGateKill: true. Open until the playwriter change lands and the pin in package.json moves off 0.9.0.
