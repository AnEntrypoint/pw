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

- patches/playwriter+0.9.0.patch (F1, applied to node_modules/playwriter 0.9.0 by the postinstall patch-package --error-on-fail; test/patch.cjs fails when it is missing): connectToBrowser in dist/executor.js (direct and extension branches, lines 737 and 764) and src/executor.ts (973 and 1010) takes the first page in the default context through defaultBrowserContext when browser.contexts() is empty, instead of browser.newContext(). The headless branch is unchanged. Witness: npm test passes with test/patch.cjs first, and npm run f1 (test/firstpage.cjs) prints firstPageSurvivedGateKill: true after the gate SIGKILL and restart. Open: the same repro passes without the patch, and a zero-window Chrome probe also keeps the page in the default context unpatched, so the loss the owner reports is not reproduced (see docs/UPSTREAM_PLAYWRITER.md). F1 closes only with the owner repro.

Round 5 (launcher leak, extension witness, memory):

- bin/playwriter-project and lib/browsers.js (L1, commit 26174f5): a gate owns the browser that holds its profile lock or its recorded pid. An owned browser, including one a SIGKILLed gate started, is closed when the restarted gate exits; a foreign browser is never stopped. Witness: npm run orphan (test/orphan.cjs) prints both scenarios with after exit 0 and restarted gate owns browser: true.
- test/orphan.cjs (L2, commit 69d34cc): the witness for L1, with the pid file kept and with it dropped. Witness: npm run orphan prints the process count at baseline, after kill, after restart and after exit, exit 0.
- test/mode.cjs (X1, commit eb853a0): the launcher path selects direct CDP and never reaches the extension branch (dist/executor.js:764). Witness: npm run mode prints extensionsConnected 0, relays 0, and childrenWithDirectUrl equal to executorChildren, exit 0.
- test/memory.cjs (M2, npm run witness): exit 0 is required; the Phase B results before option 1 record it red.
- test/memory.cjs (M3, option 1, the change in this commit): the uses-browser scenario closes its reopened page and state.page before session.end(), so the scenario exits instead of waiting for PLAYWRITER_IDLE_MS. The product keeps open pages open (F1 needs it); idle retirement stays covered by test/lifecycle.cjs and test/leases.cjs. Witness: the node test/memory.cjs row of the Phase B results after option 1.
- The defensive patch (33d11b1 through 146b3ae) stays in place in this round and is not reverted.

Phase B results before option 1 (commit after eb853a0 plus this doc change; nothing pushed; wall times from /tmp/f1-phaseb/phase-b.sh):

- npm test: exit 0, wall 126273 ms. Output ends with "lifecycle: 12 checks passed" and "leases: all checks passed".
- npm run f1: exit 0, wall 7974 ms. Output: "F1 defaultHas=true executorIsDefault=true contexts=1" and "firstPageSurvivedGateKill: true".
- npm run orphan: exit 0, wall 27462 ms. Output: "orphan pid file kept: baseline 0 -> started 13 -> after kill 11 -> after restart 13 -> after exit 0; restarted gate owns browser: true; wall 13870 ms" and "orphan pid file dropped: baseline 0 -> started 13 -> after kill 11 -> after restart 13 -> after exit 0; restarted gate owns browser: true; wall 13435 ms".
- npm run mode: exit 0, wall 5429 ms. Output: mode: {"executeReply":"opened","extensionsConnected":0,"relays":0,"executorChildren":1,"childrenWithDirectUrl":1,"selected":"direct CDP (dist/executor.js:737)","notReached":"extension branch (dist/executor.js:764)","wallMs":2198}
- node test/memory.cjs (M2): exit 1, wall 147693 ms. Output: "memory: FAILED: memory uses-browser left its own processes behind: 494863 gate, 494894 playwriter-mcp, 494896 playwriter-mcp". Red. The same failure reproduces on a41c6af, so it predates Round 5. Cause: the uses-browser scenario ends with a caller page still open; an open page holds the browser until PLAYWRITER_IDLE_MS (300 s) when no lease is held, and memory.cjs waits 40 s for drain.

Decision: option 1, chosen for this round. The uses-browser scenario of test/memory.cjs closes its pages before session.end(), so it exits instead of waiting for PLAYWRITER_IDLE_MS. The change was re-derived from the tree; /tmp/memory-option1.patch was not applied.
