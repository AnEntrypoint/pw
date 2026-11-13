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
Phase B on 0c807f9 (the test change and its row; nothing pushed; wall times from /tmp/f1-phaseb/phase-b2.sh and /tmp/f1-phaseb/npmtest-rerun.sh):

- npm test, attempt 1: exit 1, wall 108279 ms. lifecycle: 12 checks passed; leases: FAILED: Expected values to be strictly equal: 0 !== 1. Inferred from the output order: the bare gate-count assert.equal after the six-second wait in idleSessionWhileSharedCallRuns, so the gate was missing six seconds into a shared call.
- npm test, attempt 2 (rerun of this row only): exit 1, wall 163334 ms. lifecycle: 12 checks passed; leases: FAILED: leases left its own processes behind: 579499 playwriter-mcp, 579501 playwriter-mcp.
- npm run f1: exit 0, wall 8576 ms. Output: F1 defaultHas=true executorIsDefault=true contexts=1; firstPageSurvivedGateKill: true.
- npm run orphan: exit 0, wall 27578 ms. Both scenarios end with after exit 0 and restarted gate owns browser: true.
- npm run mode: exit 0, wall 5280 ms. extensionsConnected 0, relays 0, childrenWithDirectUrl equal to executorChildren (1).
- node test/memory.cjs (M3): exit 0, wall 96010 ms. drainMs 5113; afterSessionEnd processes 0.

Open: npm test is red on two attempts, with two different leases failures. After attempt 2, a Chromium from that run was still running with its gate gone and its project directory deleted. It answered /json/version and listed its page, so the gate exited while its own healthy browser was up. Candidate exit paths in bin/playwriter-project: the tick check that exits when the browser is down and no call is in flight (it does not check leaseHolders and does not stop the browser), and exitUnleased, where releaseBrowser returns early when chromeUp is false. This breaks the item 1 rule that a browser a gate starts is closed when that gate exits. Nothing is pushed until npm test is green.

Round 6 (gate exit paths, witnesses assert the invariant):

- bin/playwriter-project (G1): every automatic exit goes through exitGate, which refuses while a lease is held and stops the browser the gate started before it exits; the tick exit no longer checks totalBusy, only leases and the browser; releaseBrowser no longer returns early when chromeUp is false; stopChrome signals the owned pids (the browser the gate recorded, its spawned child, or the profile lock owner, each checked against this project's --user-data-dir) with SIGTERM then SIGKILL when the browser does not stop on Browser.close; a listen error and SIGINT, SIGTERM and SIGHUP stop the owned browser and exit. A foreign browser is never stopped. Known bend: a signal exits even with a lease held, because it is an explicit kill; the launchers see the gate close and reopen it on their next call.
- test/orphan.cjs (W1): after the gate exits, the witness asserts no gate process remains and no browser answers /json/version on the gate's debug port, in both pid-file scenarios.
- test/leases.cjs (W2): every gate-exit wait (SIGKILLed launcher, both launchers killed, last lease released, idle session with a shared call) for the two 10 s checks (a SIGKILLed launcher, and both launchers killed), also requires that no browser answers on the debug port, with the original gate and browser counts and deadline; the 60 s retirement checks also require that no executor child remains.
- Cause: the failed npm test run left a Chromium with its gate gone and its project directory deleted; it answered /json/version, so the gate had exited without stopping the browser it started (see Phase B on 0c807f9 above).

Phase B on fb927aa (the gate exit fix in 283206 and the test fix in fb927aa; npm ci first; logs in a mktemp -d directory, /tmp/tmp.O9V7qEdEm6):

- npm ci: exit 0, wall 3320 ms.
- npm test: exit 0, wall 112917 ms. tools, lifecycle and leases all pass.
- lifecycle then leases, run 1: exit 0, wall 107589 ms; run 2: exit 0, wall 107468 ms; run 3: exit 0, wall 108487 ms. The failing order passes three times in a row.
- npm run f1: exit 0, wall 7910 ms. firstPageSurvivedGateKill: true.
- npm run orphan: exit 0, wall 26138 ms. Both pid-file scenarios: after exit 0, gates after exit 0, browser answers /json/version after exit false, restarted gate owns browser true.
- npm run mode: exit 0, wall 4931 ms. extensionsConnected 0, relays 0, childrenWithDirectUrl 1 of 1.
- node test/memory.cjs: exit 0, wall 96302 ms. drainMs 11 (never-uses-browser) and 5617 (uses-browser).

Before the test fix, on 283206: npm test exit 1, wall 62150 ms, leases: gate and browser stop within 10 s of a SIGKILLed launcher, and nothing answers on the debug port; lifecycle then leases exit 1, wall 78964 ms, leases: gate and browser stop within 10 s once both launchers are dead, and nothing answers on the debug port. The cause was the executor child: the 10 s checks counted it, and it lives about 5 s past the gate exit (the gate and browser were gone at 5.2 s, the child at 10.3 s). The 10 s checks counted only the gate and browser before the port check was added, so fb927aa restores those counts and keeps the port check. The 60 s retirement checks still count the executor child.

Round 7 (gate signals and the first-open call site; docs only in Phase A, no build or code change):

- docs/UPSTREAM_PLAYWRITER.md (S1): records that SIGINT, SIGTERM and SIGHUP exit the gate even while a lease is held, and why; the build is unchanged. Witness: the "Gate signals" section exists, and the signal loop is at bin/playwriter-project:778-779.
- docs/UPSTREAM_PLAYWRITER.md (C1): the first-open call-site candidates (gm kOpenRunContext, dist/executor.js:727 fallback, :797 headless, :1435 reset) and the rule for the verdict. Witness: the Phase B row below, npm run f1 (test/firstpage.cjs), which prints firstPageSurvivedGateKill and the executor's context against contexts[0]; the verdict is written after that run.
- Phase B for Round 7: npm test once, npm run f1 once, each with exit code and wall time, logs in a mktemp -d directory. Nothing is pushed unless every row is green.

Phase B on e851ebe (Round 7; logs in /tmp/tmp.LjOKdrYbDB):

- npm test: exit 1, wall 32208 ms. tools passes. lifecycle fails at test/lifecycle.cjs:102 (`assert.equal(await chromeUp(), true)`, "a held MCP lease keeps the browser open past the idle time"): after the first call and an 8 s hold with one MCP lease, the project browser no longer answers /json/version (`false !== true`). leases did not run, since the chain stops at the first failing file. The project was kept at /tmp/pw-test-KVdRFs.
- Cause not established. The gate log has only its start (gate 9596 on 19:25:36Z) and the browser start (pid 633879 on 19:25:37Z), and no stop or exit line. The browser log has only the DevTools line and a DBus UPower error. Both processes were gone by the time of the check. Ruled out: memory (15 GB total, 2 GB free, 8 GB available), a kernel OOM kill (dmesg gives none), a pkill or killall in the gm native, scripts or tools trees, and a gm run folder dated 21:10 to 21:29 local (checked by name only).
- npm run f1: exit 0, wall 8444 ms. F1 defaultHas=true executorIsDefault=true contexts=1; firstPageSurvivedGateKill: true. This is the measured row for candidate 2 in docs/UPSTREAM_PLAYWRITER.md, and the verdict is recorded there: not lost, no code change.
- Diagnostic only, not a second npm test: node test/lifecycle.cjs alone, exit 0, wall 41393 ms, lifecycle: 12 checks passed. The failure does not reproduce on a rerun of that row.
- Not pushed. npm test was red on its one run, so the push rule does not allow it. The lifecycle failure is intermittent and its cause is open; this commit changes docs only.

Round 8 (the queue: the Phase B runner, the signals, fallback and cold start witnesses, the lifecycle cause, and the launcher wait decision):

- Tested commit: d27a154, the code and test tree. The runner started at 22:03:38 local, after the last code edit (test/ready.cjs 22:02:30, package.json 22:03:13); the only later edits are docs/UPSTREAM_PLAYWRITER.md and this file, and no test reads them. Commits after d27a154 are docs only, and origin/main had f26b5ce already, so this push carries no f26b5ce edits.
- Phase A: scripts/phase-b.cjs exits with the worst effective row exit, and a row that leaves a marked process behind counts as 1. Witness test/phase-b.cjs: a red row exits 3, a leaking row exits 1 and its process is stopped, and --watch records start and stop. Output: "phase-b: all checks passed".
- Item 4, test/signals.cjs: SIGTERM exits gate 851698 in 432 ms with the lease held, and the next call reopens gate 851976. SIGHUP exits gate 852378 in 429 ms, and the next call reopens gate 852613. Output: "signals: all checks passed".
- Item 6, test/fallback.cjs: before the change, the forced empty connect opened a page through browser.newContext(), and the page did not survive the executor dying (`page survived false`; the row failed with exit 1, 18309 ms). The patch now throws there, in dist/executor.js and src/executor.ts. After the change the forced connect prints "threw: the browser lists no default context after about:blank", and a normal connect's page survives the executor dying. Output: "fallback: all checks passed".
- The patch was rebuilt by hand, because patch-package fetches the package and fails offline. The hunk headers were shifted by the three added lines, and the result was checked by applying the patch to the pristine playwriter 0.9.0 tarball (`npm pack --offline`): the output matches node_modules byte for byte.
- Item 5, the page-target wait: the reason for the revert 001cf63 of b6b8939 is not recorded in either commit message, in these docs, or in the pre-compaction transcript, which only says each of the pair is reverted by the next. The wait is not restored. test/ready.cjs, three cold starts: the first page target appeared 19, 12 and 12 ms after the debug port answered, and the first executor used the default context in 3 of 3 (`executorIsDefault=true contexts=1`). The wait would return at once on this host. A counter-measurement on another host would reopen the decision.
- Item 8: no change. test/leases.cjs passed in this run (leases: all checks passed). Its 10 s gate-exit checks count the gate and browser, and its 60 s retirement checks count the executor child (fb927aa).
- Item 7, memory: wall 96164 ms, exit 0. memory.log has two drain figures, 8 ms and 5625 ms; the larger is 5625 ms against the 40 s budget, a margin of 34375 ms.
- Item 1, the lifecycle failure, settled: the cause is gm's check-lazy-browser (native/components/tool/checks/lazy_browser.cpp:64-76 in the gm repo). It takes `gate pid N` from the reply of its first browser call, including another project's gate from the machine-wide listing, and then SIGKILLs that gate's process tree (gate, browser, executor children). Reproduced: a gate held by a lease, then the gm check, gave the gate and browser gone with no exit line while the launcher stayed alive; the watcher shows the kill wave at 19:56:05.283Z. This Phase B run did not run that check, so the path rests on the reproduction. In this run the watcher recorded 23 gate gone events for this run's own gates, each with an exit line (`no lease for the grace period`, or `signal SIGTERM` or `SIGHUP`), none without one. No gone event had a gm ancestor, and oom_kill stayed 0.
- Foreign gate 2531: it went at 19:56:12, during the Round 7 window. No watcher was running then, so its cause is not proven. It was absent when checked after this run, and this run did not stop it. Processes 9567, 10301 and 10302 were alive and untouched at 22:08 local.
- In this run, three foreign gates in gm's own /tmp/gm-first-open-* sandboxes went away at 20:04:23 and 20:04:28 UTC, with two foreign browsers at the same instant as a gm process appeared 1.8 s earlier. That is the same wave shape as the reproduction. It is consistent with a gm check, not proven. The fix belongs in gm's repo, which this round did not change: restrict the roots to the check's own sandbox, or stop printing foreign owners as `gate pid N`.
- Phase B on d27a154 (logs /tmp/tmp.7ZPPabtwhu; runner worst exit 0; leftover 0 on every row):
  - npm test: exit 0, wall 160958 ms. Chain: patch ok; tools 2 checks; lifecycle 12 checks passed; leases all passed; signals, fallback and ready all passed. Per-file wall times inside the chain were not recorded separately.
  - npm run f1: exit 0, wall 7914 ms. F1 defaultHas=true executorIsDefault=true contexts=1; firstPageSurvivedGateKill: true.
  - npm run orphan: exit 0, wall 26507 ms. Both scenarios end at after exit 0 with restarted gate owns browser: true.
  - npm run mode: exit 0, wall 4900 ms. extensionsConnected 0, relays 0, childrenWithDirectUrl 1.
  - node test/memory.cjs: exit 0, wall 96164 ms (item 7 above).
  - npm run phase-b: exit 0, wall 17806 ms. Output: "phase-b: all checks passed".

Round 9 (the stale-gate work on f26b5ce; Phase A commits, then Phase B on the tree of e4ecc3b):

- Commits, in order: 320a7fb (start waits up to 60 s for the browser), 565018c (the identity check before SIGTERM, the 15 s refusal, the ESRCH-only catch, commandOf at module level), e4ecc3b (test/stale.cjs with four modes, npm scripts for each, and the npm test chain). The tested tree is the working tree the runner ran at 22:18:08 local, after its last edit at 22:18:00. It was first one local commit, 4d9c50b, which was never pushed. It was regrouped into the three commits above, and `git diff 4d9c50b e4ecc3b` is empty.
- Start race, fixed in 320a7fb: on a fresh gate, start printed "browser failed (503)". The gate log shows the browser started at 20:15:50.214Z and the lease released at 20:15:50.423Z, so the 503 came from the proxied debug port before it opened.
- Witness replace (no lease): old gate 933284 gone in 14 ms, its browser 933299 gone in 13 ms, and the new gate 933516 answers. Output: "stale: all checks passed".
- Witness held: the leased gate 933993 and browser 934121 are not replaced, and the note prints: "the browser was started as ..., not ...; it is not restarted while 1 other lease(s) hold this project's gate".
- Fix (b), witness unanswering: a gate that ignores SIGTERM for 15 s fails the start with "gate N still answers on port P 15 s after SIGTERM; no lease was taken on it" (exit 1), and the stub receives no /__pwp/lease request. Before the fix, the same row failed with "gate on port 40481 did not grant a lease", so a lease had been requested.
- Fix (c), witness foreign: a process on the gate port that lacks this launcher's --gate is not signalled. It is still running after the start, which exits 1 with "is not this project's gate (pid N); it was not signalled and no lease was taken on it", and no lease request reaches it. Before the fix, the start went on past it and printed "browser failed (503)".
- The ESRCH-only catch has no witness. A dead pid cannot be the listener on the port, so the test cannot reach ESRCH, and EPERM needs a process owned by another user.
- Test environment: the first stale runs deleted PLAYWRITER_NO_SANDBOX, which this shell exports as 1, and the first browser did not start. The cause was not isolated; the 503 race above is confirmed separately. The rows now set PLAYWRITER_BROWSER_PATH: Chrome for the first gate, and a symlink to the same binary for the second. Whether the browser starts with the variable unset is not tested.
- Phase B on e4ecc3b (logs /tmp/tmp.0VDH0MW13n; runner worst exit 0; leftover 0 on every row):
  - npm test: exit 0, wall 190751 ms. tools, lifecycle (12 checks), leases, signals, fallback, ready and stale all passed.
  - npm run f1: exit 0, wall 8347 ms. npm run orphan: exit 0, wall 27305 ms. npm run mode: exit 0, wall 5167 ms. node test/memory.cjs: exit 0, wall 96459 ms. npm run phase-b: exit 0, wall 17785 ms.
  - npm run stale-replace: exit 0, wall 5802 ms. npm run stale-held: exit 0, wall 7156 ms. npm run stale-unanswering: exit 0, wall 18603 ms. npm run stale-foreign: exit 0, wall 3493 ms.
- Watcher, 380 events: 31 gates went away. 26 exited with a log line ("no lease for the grace period", or a signal). The other 5 were killed by their own test: 3 by the SIGKILL in the f1 and orphan witnesses, and 2 stub gates by the cleanup in test/stale.cjs. No oom kill, and no gone event had a gm ancestor.

Round 10 (the open queue after Round 9: the nosandbox rows, package.json, the patch-package regeneration; Phase B on the tree of 9cae4c4):

- Commits on d4d1559, in order, all local and not pushed: c041377 (start returns as soon as the gate logs a browser start failure), d4d1559 (lib/signal.js: ESRCH is silent, every other signal error is logged; test/signal.cjs), 1821835 (witnesses set PLAYWRITER_NO_SANDBOX themselves; a stale run with no mode leaves out foreign), ae75d1a (package.json: npm test runs test/start.cjs and test/signal.cjs; scripts start-refusal and signal), 9cae4c4 (patches/playwriter+0.9.0.patch regenerated). c041377 and d4d1559 were not recorded in Round 9; they are recorded here.
- Start early return (c041377), witness test/start.cjs: before the fix, start waited 63.5 s and printed the wrong message. After: "ok refusal: start returns in 667 ms with the gate's reason; the browser is started once" and "ok exit: start returns in 856 ms with the gate's reason; the browser is started once".
- ESRCH and EPERM (d4d1559): the two empty catches in stopAdopted and signalPids now call signalPid in lib/signal.js. The catch is ESRCH-only; any other error is logged as "could not send SIGTERM to pid N: <message>" and the call returns false. The kill and the log are injectable, so the EPERM branch is reachable without a dead pid. Witness output: "ok: ESRCH for exited pid 1031088 returns false and logs nothing"; "ok: an injected EPERM returns false and logs the EPERM line"; "ok: a real EPERM from pid 1 (signal 0 delivers nothing) is logged"; "ok: a live pid 1031095 is signalled and nothing is logged"; "signal: all checks passed".
- The nosandbox rows, cause: this environment has no usable Chromium sandbox. kernel.apparmor_restrict_unprivileged_userns is 1, unshare --user fails with "Operation not permitted", and /usr/lib/chromium has no chrome-sandbox helper. Chrome reports "No usable sandbox", and the launcher refuses to start a browser unless PLAYWRITER_NO_SANDBOX is set. That refusal is by design. The two rows ran with the variable unset and the witnesses never set it, so the rows failed for a witness reason. Before the fix: stale-nosandbox exit 1 (4006 ms) with "browser refused to start: no usable sandbox"; lifecycle-nosandbox exit 1 (27894 ms). The earlier reading that these were expected is withdrawn.
- Fix (1821835): test/support.cjs sets PLAYWRITER_NO_SANDBOX=1 for every witness. lifecycle.cjs and stale.cjs take it from process.env. Each row rerun alone: stale-nosandbox exit 0, wall 27592 ms, leftover 0; lifecycle-nosandbox exit 0, wall 41637 ms, leftover 0. Not added: an automatic fallback to --no-sandbox in the launcher. That is a product and security decision for the owner.
- Foreign kept out of the default run (1821835): test/stale.cjs with no mode runs replace, held and unanswering, and prints "stale: foreign is not run by default; run node test/stale.cjs foreign". The foreign mode runs only when named. npm test and both nosandbox rows therefore do not run it. The reason is the instruction not to run the foreign-gate witness until gm's kill-scope fix lands.
- patch-package failure, cause: makePatch writes the lockfile's resolved URL for playwriter (https://registry.npmjs.org/playwriter/-/playwriter-0.9.0.tgz, from getPackageResolution's pkg.resolved) into a temporary package.json and runs npm i --force. Here npm is 12.2.0 with allow-remote set to none, so npm refuses the remote spec: "npm error code EALLOWREMOTE ... Fetching packages of type "remote" have been disabled". patch-package sends npm's output to ignore, retries with --ignore-scripts (same refusal), and exits 1 with no message. Reproduced in a mktemp directory: the URL spec exits 1 with EALLOWREMOTE; the version spec "0.9.0" exits 0 in about 13 s; the URL spec with npm_config_allow_remote=all exits 0.
- Regeneration (9cae4c4): npm_config_allow_remote=all npx patch-package playwriter exits 0 in 7.5 s. The override applies to that one command; no npm config and no lockfile changed. Byte comparison with the hand-edited patch (4274 bytes before, 4539 after): the + and - lines are identical; the differences are format only. Two index lines were added, one per patched file; six hunk headers gained the function context " export class PlaywrightExecutor {"; one blank context line now carries its single leading space. The hunk line numbers did not change. The regenerated file is the committed patch, and test/patch.cjs passes inside npm test.
- package.json (ae75d1a): committed, not reverted. It holds the witness wiring for items 2 and 4 (start-refusal and signal). Phase B runs those rows, and reverting would leave both unwired from npm test.
- Phase B on the tree of 9cae4c4 (logs /tmp/tmp.tCHiAuUJLq; runner exit 0; worst exit 0; leftover 0 on every row):
  - npm test: exit 0, wall 201247 ms.
  - npm run f1: exit 0, wall 8487 ms. npm run orphan: exit 0, wall 26920 ms. npm run mode: exit 0, wall 5107 ms. npm run witness (test/memory.cjs): exit 0, wall 96344 ms. npm run phase-b: exit 0, wall 17774 ms.
  - npm run start-refusal: exit 0, wall 6221 ms. npm run signal: exit 0, wall 1685 ms.
  - npm run stale-replace: exit 0, wall 5775 ms. npm run stale-held: exit 0, wall 7057 ms. npm run stale-unanswering: exit 0, wall 18559 ms.
  - stale-nosandbox: exit 0, wall 27766 ms. lifecycle-nosandbox: exit 0, wall 41301 ms.
  - Not run: npm run stale-foreign (item 10), deferred until gm's kill-scope fix lands.
- Push: withheld. Phase B did not run every listed row (stale-foreign), so the push condition is not met. Local, unpushed commits: 1821835, ae75d1a, 9cae4c4, and this round's docs commit.
- Not touched: the foreign processes 9567, 10301 and 10302 (npx playwriter-project) were alive after Phase B and were not signalled. Foreign gate 2531 is not in the process table.

Open items after the push of 53d4051 (numbers as given in the latest queue; the item numbers in the Round 9 and Round 10 notes above come from earlier queues):

- Item 10, stale-foreign, and item 4, the cause of gate 2531's disappearance, wait on gm's kill-scope fix. The foreign mode runs a process on the gate port that is not this project's gate, and it kills gates if gm's kill scope is wrong. Gate 2531's disappearance is unexplained, and the earlier evidence (the wave of foreign gates in gm's /tmp/gm-first-open-* sandboxes) points at the same kill scope. Neither is run, and neither is a push condition, until the fix lands on origin/main.
- Witness for both: `node test/stale.cjs foreign`, run alone, after gm's fix is on origin/main. Record its exit code, wall time and leftover count here when it runs. Until then the row is not run.
- Item 7, the pw-test directories (checked in this round):
  - The only code that creates them is test/lifecycle.cjs:11 (mkdtemp with the prefix pw-test-). It removes its directory on success and keeps it on failure (test/lifecycle.cjs:160, "project kept for inspection"). Keeping it on failure is deliberate, so it is not a leak, and the witness is unchanged.
  - /tmp/pw-test-KVdRFs: created at 19:25:34Z by lifecycle inside an npm test run. That run failed at the check after "ok 2: first tool call opens the browser", which is the held-lease check ("false !== true"). This round inspected the directory at 19:26:27Z. No process still used it when it was removed, after proof that this run made it. The cause of that failure is not isolated, so treat it as an unexplained lifecycle failure, not a fixed one.
  - /tmp/pw-test-lG6Lle (16:10:10Z) and /tmp/pw-test-start (16:10:05Z) predate this run, which started at 17:54:18Z. No code path writes a file named pw-test-start, and that file holds an epoch timestamp, so a command wrote it. Neither can be proven mine, so both are left in place.
- Item 3, the sandboxed launch path: OPEN. Cause: the kernel restricts unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1, and unshare --user fails with EPERM), and /usr/lib/chromium has no chrome-sandbox helper, so Chromium's sandbox cannot start. The browser only starts here with PLAYWRITER_NO_SANDBOX set, and no witness runs the launcher with the sandbox on. The launcher default is unchanged. To close it, run the launch witness without the variable on a host where the Chromium sandbox works.
- Item 2, the refusal default: DECIDED. The launcher refuses to start a browser without PLAYWRITER_NO_SANDBOX, and it does not fall back to --no-sandbox automatically. That is a security downgrade, so the owner decides it.
- Item 5, the patch-package regeneration: DECIDED. The npm override (npm_config_allow_remote=all) applies only to the one npx patch-package playwriter command that produced 9cae4c4. No npm config or lockfile was changed.
- Item 6, upstream: DECIDED. No upstream defensive patch is sent (docs/UPSTREAM_PLAYWRITER.md).

Lifecycle failure at 19:25:34Z: cause and fix.

- The failure: in an npm test run, test/lifecycle.cjs failed after "ok 2: first tool call opens the browser" with "false !== true". The failing assertion was line 102 before the fix, the held-lease check, which asserted `chromeUp()` is true eight seconds after the first call. Line 103 (the browser-profile directory) could not have failed: the browser had been started with that profile, and the kept directory held one subdirectory.
- The state that made it false: one probe of the debug port (`/json/version`, 3 s budget, no retry) returned false. The gate had the browser up. Its log for that run (its only lines, at 19:25:36.165Z and 19:25:37.361Z) records no probe failure, no "last lease released" and no stop in the eight seconds before the failure. The gate logs each failed probe while the browser is up, and it needs three consecutive misses before it drops the browser (GONE_AFTER_PROBES = 3). A single failed probe therefore never reached the gate's log.
- Why that one probe failed is not recorded. httpOk turns a timeout, an error and a non-200 answer into the same false, so the reason was lost. The kept directory, with its gate.log and browser.log, was removed in the previous round after inspection and before this analysis. That removal was a mistake: it deleted the only evidence for the probe's reason. The rerun at 19:27:55Z (lifecycle-rerun.log) passed all twelve checks.
- Fix (23e505a): the held-lease check reads the gate's own status and asserts at least one lease and the browser pid recorded after the first call, retrying for 10 s. It then retries the debug-port probe for 10 s. The reuse check after the cookie (the second positive probe) retries the same way. A failure now prints the gate status.
- Not fixed: the transient cause of the single probe failure, which this round could not reproduce or record. The negative checks (`chromeUp()` false) remain single probes. They can only pass falsely, not fail.
- Phase B on 932d40d (code as 23e505a; the commit after it is docs only):
  - Five runs of lifecycle alone, each through the runner under a 400 s timeout on the runner PID (logs /tmp/tmp.XR8yQVYZFW, /tmp/tmp.ONNWjy5Lvj, /tmp/tmp.K9nwpW1FKF, /tmp/tmp.Qu3apXnODm, /tmp/tmp.amhLrnwH2p): exit 0 each, wall 41265, 41322, 41315, 41317 and 41311 ms, leftover 0 each, "lifecycle: 12 checks passed" each time.
  - Rerun of lifecycle alone on the final tree (logdir /tmp/tmp.nvRzupLaje): exit 0, wall 41228 ms, leftover 0.
  - Full set once (logdir /tmp/tmp.VkkQVWX8KB; worst exit 0; leftover 0 on every row): npm test 194162 ms, f1 7827 ms, orphan 26431 ms, mode 4880 ms, memory 96222 ms, phase-b 17715 ms, start-refusal 6302 ms, signal 1694 ms, stale-replace 6092 ms, stale-held 7222 ms, stale-unanswering 18570 ms, stale-nosandbox 27711 ms, lifecycle-nosandbox 43523 ms. Not run: stale-foreign (item 10), which waits on gm's kill-scope fix.
  - Longest step of this round: npm test in the full set, 194162 ms.
  - Reproduction: six runs on the fixed tree passed, and the pre-fix code was not rerun. The original failure did not reproduce, so the transient cause of the one failed probe is still unrecorded. What is established is the defect in the witness: one unretried probe decided "browser down" while the gate's state showed the browser and lease intact.

Lifecycle probe reasons (cfbadf1): the open cause, the failed debug-port probe, is not recorded in any earlier run.

- Change: test/lifecycle.cjs has one probe helper, probeOnce, for the debug port and the gate ping. It resolves ok or not ok, and it records the reason in a per-probe count and a last reason: "ok", "timeout after 3000 ms on port N", "connection error CODE on port N" (the error code from Node, or its message when there is none), or "HTTP STATUS". The per-probe report prints on success as "probes:" and on failure as "probes:", followed by "gate status:". The gate status is read before finishTest stops the gate, because finishTest stops it.
- Why: the failed probe's reason was discarded, because the old httpOk returned a bare boolean, so the open cause cannot be recovered from the 19:25:34Z run. Any future probe failure now names its reason in the failure output.
- Phase B on cfbadf1 (52ce466 is docs only; main was pushed at 52ce466):
  - Load: a 12-thread busy-loop generator (one worker per core), started by its own PID under timeout 1500, stopped by SIGTERM to that PID (exit 143, gone afterwards). Five runs of lifecycle alone under it, each through the runner under a 400 s timeout on the runner PID. All five: exit 0, leftover 0, "lifecycle: 12 checks passed".
    - Run 1 (logdir /tmp/tmp.Pkr1pfNGvk), wall 47122 ms. Probes: gate ping ok x26, ECONNREFUSED x3, ECONNRESET x1; debug-port ok x3, ECONNREFUSED x5.
    - Run 2 (/tmp/tmp.IS96C3odRs), wall 48021 ms. Gate ping ok x29, ECONNREFUSED x4; debug-port ok x3, ECONNREFUSED x5.
    - Run 3 (/tmp/tmp.yRVUI6jsT1), wall 47002 ms. Gate ping ok x23, ECONNREFUSED x4; debug-port ok x3, ECONNREFUSED x5.
    - Run 4 (/tmp/tmp.hCxRwltPPP), wall 49230 ms. Gate ping ok x33, ECONNREFUSED x4; debug-port ok x3, ECONNREFUSED x5.
    - Run 5 (/tmp/tmp.HoohcZFPU2), wall 48756 ms. Gate ping ok x33, ECONNREFUSED x4; debug-port ok x3, ECONNREFUSED x5.
  - No probe timed out and no probe returned a non-200 in the five runs. The ECONNREFUSED results are the negative checks while the browser is down, and the ECONNRESET in run 1 is a gate ping. The original condition (one debug-port probe failing its 3 s budget during the held-lease window) did not reproduce.
  - Rerun of lifecycle alone on 52ce466 (logdir /tmp/tmp.eyv8BtxLT6): exit 0, wall 41620 ms, leftover 0, "lifecycle: 12 checks passed", the same probe pattern: debug-port ok x3, ECONNREFUSED x5.
  - Full set once on 52ce466 (logdir /tmp/tmp.WBrXOyDprY; worst exit 0; leftover 0 on every row): npm test 195429 ms, f1 8066 ms, orphan 26856 ms, mode 5165 ms, memory 96485 ms, phase-b 17757 ms, start-refusal 6211 ms, signal 1714 ms, stale-replace 5791 ms, stale-held 6981 ms, stale-unanswering 18556 ms, stale-nosandbox 27754 ms, lifecycle-nosandbox 41371 ms. Not run: stale-foreign (item 10), which waits on gm's kill-scope fix.
  - Longest step of this round: the full-set npm test, 195429 ms.
  - Push: 8df9d81..52ce466 main -> main, exit 0; status "## main...origin/main".
  - The open cause, the one failed probe in the 19:25:34Z run, remains unrecorded: the probe-reason output is now in place, and none of the loaded runs produced a failing probe to record.
- Kept directories checked read-only for the 19:25:34Z probe (nothing deleted or changed; times are UTC):
  - /tmp/pw-test-lG6Lle, created 16:10:10Z. Files: .playwriter/gate.log (1226 bytes, 19 lines, 16:10:11.795Z to 16:10:46.517Z), .playwriter/browser.log (1931 bytes, 14 lines), .playwriter/port and debug-port (5 and 6 bytes), and browser-profile/ (Chrome's profile). The gate log has three gate lifetimes. The first runs the lifecycle's check sequence: browser started 16:10:13.140Z; "stopping browser: closed by the browsers tool" at 16:10:22.532Z; gate exiting "no lease for the grace period" at 16:10:28.976Z. Later lifetimes show "stopping browser: idle" at 16:10:37.213Z and 16:10:46.471Z, and the last gate exit at 16:10:46.517Z. The gate log has no probe failure, timeout, connection error or HTTP status line. browser.log holds only Chrome's own messages (DevTools listening, dbus and registration errors).
  - Verdict for lG6Lle: the held-lease assertion (line 102 at 43e330d, chromeUp() true after IDLE_MS + 4000) passed in that run, because the browsers-close call, which only runs after that check, appears in the gate log at 16:10:22.532Z. The run failed later, at check 11 or during cleanup; the directory has no stderr, so the failing check is not recorded. This is not the same assertion, so it does not settle the cause. Ownership: the directory predates this gm run (started 17:54:18Z), and its files name no run, so it is not treated as ours.
  - /tmp/pw-test-start is a regular file, 11 bytes, containing 1794499805 (16:10:05Z in epoch seconds). It is not a directory and has no gate or browser data, so it is not evidence.
  - Other /tmp/pw-* entries were listed but not opened, because they are not lifecycle directories.
- Conclusion: neither kept directory shows the held-lease assertion failing. The cause of the one failed probe in the 19:25:34Z run stays open.

Lifecycle failure report (977174c, Phase A; Phase B on 12a74ad):

- Change: every failure of test/lifecycle.cjs, on any check or in cleanup, writes failure.txt into the kept directory and prints the same text to stderr. The file holds the failure message, the failing line taken from the stack, the checks passed before the failure, the stack, the probe reasons, the gate status (read before finishTest stops the gate), and the last 20 lines of gate.log and browser.log (read after it). The directory is kept on every failure path, as before.
- Forced failures, selected by PWP_LIFECYCLE_FORCE: check11 fails the assertion before check 11 (the cookie check after the CLI reconnect), and cleanup throws at the start of the cleanup step.
- Witness: test/lifecycle-forced.cjs (npm run lifecycle-forced-check11 and lifecycle-forced-cleanup). Each run must exit 1, name its message on stderr, and leave failure.txt with the message, the failing line equal to the marker line in lifecycle.cjs, the stack, the gate status and the browser log tail. Each witness keeps its directory, so the kept directories can be read.
- Phase B, first pass on 977174c: lifecycle alone exit 0, wall 41655 ms, and the /tmp/pw-test-* list is the same before and after (no failure file). check11 forced exit 0, wall 34612 ms: /tmp/pw-test-ULwlYz/failure.txt holds the message, line 209, checks passed 10, the stack (AssertionError at lifecycle.cjs:209:35), the gate status JSON (browser pid 1196318 running, source gate, leases 0), and the gate.log and browser.log tails. cleanup forced exit 1, wall 41407 ms: the file was written (message, line 223, stack, probes, tails) but its gate status was null. The witness required the JSON status at every point, and at cleanup the gate has already exited (gate.log: gate exiting: no lease for the grace period at 21:50:00.072Z). The witness was wrong for that point, and the file is kept as /tmp/pw-test-Nt98tI.
- Fix in 12a74ad: when the gate does not answer at failure time, the report writes not answering: <the gate ping reason>, taken fresh; the JSON stays when the gate answers. test/lifecycle-forced.cjs requires the JSON at check11 and not answering at cleanup. cleanup rerun alone: exit 0, wall 41388 ms, /tmp/pw-test-Z4Mhrs kept with line 224 and gate status not answering: connection error ECONNREFUSED on port 9409.
- Phase B on 12a74ad: lifecycle alone exit 0, wall 41829 ms. Full set once (logdir /tmp/tmp.UjWGIip6ci; runner worst exit 0, wall 535889 ms; leftover 0 on every row): npm-test 196665 ms, f1 8065 ms, orphan 26603 ms, mode 5002 ms, memory 96532 ms, phase-b 17844 ms, start-refusal 6312 ms, signal 1690 ms, stale-replace 5952 ms, stale-held 7071 ms, stale-unanswering 18579 ms, stale-nosandbox 27646 ms, lifecycle-nosandbox 41469 ms, lifecycle-forced-check11 34382 ms, lifecycle-forced-cleanup 41604 ms. Not run: stale-foreign (item 10).
- Final-tree forced failure files: /tmp/pw-test-5GhfVS (check11) holds failure: forced failure at check 11, line 210, checks passed 10, AssertionError at lifecycle.cjs:210:35, and gate status JSON with browser pid 1307002 running and leases 0. /tmp/pw-test-RpJxaz (cleanup) holds failure: forced failure in cleanup, line 224, checks passed 12, Error at lifecycle.cjs:224:36, and gate status not answering: connection error ECONNREFUSED on port 9500. Both are kept, with /tmp/pw-test-ULwlYz, /tmp/pw-test-Nt98tI and /tmp/pw-test-Z4Mhrs from earlier runs of this stretch. No process references the kept directories after the full set.
- The cause of the one failed debug-port probe in the 19:25:34Z run is still open. Any future lifecycle failure now writes its message, line, stack, probe reasons, gate status and log tails to failure.txt in its kept directory.

## Item 10: stale-foreign after gm be9909f (Phase A, then Phase B)

- gm fix: AnEntrypoint/gm main is at be9909f (lanmower, "browser scope: playwriter kept across run end; check kills by pid and start time"). Read without touching gm: `git ls-remote https://github.com/AnEntrypoint/gm refs/heads/main` returns be9909ff2fff1f822f3b03f0ae9dd5d8b1418962, and `gh api repos/AnEntrypoint/gm/commits/be9909f` gives the message above. be9909f is not an object in this repo, which is expected.
- Pre-run check (before 22:05:31 UTC): no check-lazy-browser, check-browser-first-open or check-browser-scope process, and no stale.cjs, lifecycle or phase-b process. Live gm worker sessions are running (pids 1179658, 1179697, 1179745, 1179773, 1179783, 1199553). They are long-lived session servers, and 1179697 serves this connection, so they do not exit on their own and were not waited on. The one that matters for item 10 is none of them.
- gm gate: pid 1180507 is live with PLAYWRITER_PROJECT_DIR=/workspace/gm. It belongs to gm, and it was not touched.
- Gate 2531: no process with pid 2531, and no TCP listener on port 2531 (state 0A in /proc/net/tcp and tcp6). Foreign pids 9567, 10301 and 10302 are gone.
- Phase A change: none needed. test/stale.cjs foreign spawns its own stub on a free port in its own temp directory (pw-stale-foreign-*) and never uses port 2531. Its cleanup signals only its own stub handle, and projectProcs and ownedRows stop only processes whose command line or env names its temp directory or PWP_TEST_TOKEN (test/support.cjs). The launcher prints the message the witness asserts (bin/playwriter-project:1165, isOwnGate). Witness: node test/stale.cjs foreign, run alone in Phase B.

## Ancestry of the defensive patch 33d11b1..146b3ae (step 5)

- Earlier claim, withdrawn: "33d11b1..146b3ae are not on main." It came from `git log --oneline -30`, which stops before these commits. It was wrong.
- Evidence in this repo: `git merge-base --is-ancestor 33d11b1 origin/main` exits 0; `git merge-base --is-ancestor 146b3ae origin/main` exits 0; `git merge-base --is-ancestor 146b3ae main` exits 0; `git rev-list --count 33d11b1^..146b3ae` is 2 (33d11b1 "patch: playwriter 0.9.0 takes the first page in the default context when the browser lists none", 146b3ae "install: patch-package applies the playwriter patch on install, and test/patch.cjs fails when it is missing"); `git branch -a --contains 146b3ae` lists main, origin/main and origin/HEAD.
- Conclusion: both commits are ancestors of origin/main. The defensive patch is on main, and nothing needs to be reverted or re-pushed for it.

## gm run 2026-11-12-17-54-18-b8bdb4 (step 4)

- The run is not finished, its task is not replaced, and it is not changed further. Its status belongs to the dispatcher. Its task text describes a launcher-leak stretch (commits 33d11b1..146b3ae, now confirmed on main above); the steps below are from the Phase B queue, not that task.
- Steps I ran inside it, UTC, from its job log and event log:
  - 21:47:59 to 21:48:41: pb-life1, lifecycle alone on 977174c (exit 0, 41655 ms).
  - 21:48:51 to 21:50:08: pb-forced2, check11 then cleanup forced witnesses on 977174c (check11 exit 0; cleanup exit 1 because its gate-status expectation was wrong for that point).
  - Edits to test/lifecycle.cjs and test/lifecycle-forced.cjs (actionSeq 2537 to 2548), then 21:51:07 to 21:51:49: pb-cleanup-rerun, cleanup alone on that working tree (exit 0, 41388 ms). The same tree was committed as 12a74ad (actionSeq 2568).
  - 21:52:33 to 22:02:11: pb-final, lifecycle alone on 12a74ad (exit 0, 41829 ms), then the full set (worst exit 0, 535889 ms). A job-stuck event was raised at 21:56:33 with no progress for 198 s; the job finished normally at 22:02:11 with exit 0.
  - Docs commit b8d5c79 and the push of 52ce466..b8d5c79 (actionSeq 2661 to 2667).
  - From actionSeq 2673, before 22:05:31 UTC: read-only checks for item 10 and the ancestry check above, and one next_context call with no task argument to read the pending job events.

- Phase B for item 10: pending, recorded below after the run.

## Item 10 Phase B result: stale-foreign on 4798aa1

- `node test/stale.cjs foreign`, alone, under `timeout 300` on its PID: exit 0, wall 3368 ms. Witness output: `ok: a process on the gate port that is not this project gate is not signalled, and no lease is taken on it` and `stale: all checks passed`.
- Rerun alone: exit 0, wall 3366 ms, the same output.
- Leftover: 0. No pw-stale-* process, no foreign-server process and no /tmp/pw-stale-* directory before or after either run, and the witness finishTest passed.
- Gate 2531: no TCP listener on port 2531 and no process with pid 2531 before the run, after it, and after the full set. It was not present at any point, so nothing survived and nothing was signalled. The witness uses its own stub on a free port and never port 2531.
- gm gate pid 1180507 (/workspace/gm): alive before and after every step. It was not touched.
- Full set once, with stale-foreign now a row (logdir /tmp/tmp.0DJU5NUqzB, tree 4798aa1): runner worst exit 0, wall 541507 ms, leftover 0 on every row. Rows: npm-test 196090 ms, f1 8003, orphan 26788, mode 4964, memory 96469, phase-b 17826, start-refusal 6469, signal 1709, stale-replace 6157, stale-held 7278, stale-unanswering 18602, stale-nosandbox 27557, lifecycle-nosandbox 41442, lifecycle-forced-check11 36611, lifecycle-forced-cleanup 41675, stale-foreign 3364.
- Item 10 is done: stale-foreign is green on origin/main with gm be9909f. Item 3 (sandboxed launch) stays open, for the owner’s host setting.

## gm run b8bdb4: steps after the Phase A record (step 4, continued)

- After 22:05:31 UTC (actionSeq 2716 to 2766): Phase A commit 4798aa1; job pb-foreign1 (stale-foreign alone, 3368 ms, ended 22:06:13 UTC); job pb-foreign-final (foreign rerun alone, 3366 ms; full set, 541507 ms), the last job, ended 22:15:28 UTC; docs commit 5287fd3 and its push. The run is not finished and its task is unchanged.

## Item 4: the cause of gate 2531’s disappearance (read-only evidence)

Status: open. The code shows how a pre-fix check could reach a foreign gate. The logs read here record no kill of pid 2531 and no check run in the window, so the cause is not settled.

Sources. gm’s code was read with `gh api repos/AnEntrypoint/gm/contents/<path>?ref=<sha>`, which returns the same blob as `git show <sha>:<path>`. gm’s checkout was not touched and nothing was run. Paths are under native/components/tool/checks/: 73ccd2c is the pre-fix commit and be9909f the fix.

What the pre-fix code does (73ccd2c):
- lazy_browser.cpp:64-66 takes every `gate pid N` or `browser running pid N` from the reply of the check’s first browser call, with no check of which project owns the gate.
- lazy_browser.cpp:70-73: roots are the session’s descendants, plus those reported pids, plus every process whose command line contains the sandbox path (`processes_mentioning(sandbox.string())`); `tree = process_tree(roots)`.
- lazy_browser.cpp:76: `kill_processes(tree);`
- process_tree.cpp:31-46 (identical at both commits): `process_tree` returns every descendant of the roots, by parent pid. process_tree.cpp:51-52: `kill_processes` sends SIGKILL to each pid, with no start-time check. process_tree.cpp:55-65: `processes_mentioning` matches a substring of /proc/<pid>/cmdline only.
- browser_first_open.cpp:194-196: the gate pid is parsed from the launcher status output and `::kill(static_cast<pid_t>(gate_pid), SIGKILL);` is called, with no identity check.
- browser_first_open.cpp:244-250: sandbox-path roots, `process_tree(live)`, `kill_processes(tree)`.
- browser_scope.cpp:257-263: roots are the session’s descendants plus `processes_mentioning(home.string())`; `tree = process_tree(roots)`; `kill_processes(tree)` at line 263.

What the fix changes (be9909f):
- lazy_browser.cpp:81 takes a snapshot `before` just before the first call. Lines 49-52 (`fresh`) count a pid as fresh if it is absent from that snapshot or its start time changed. Lines 96-99 keep a pid only if it is a session descendant or fresh, and store its start time. Lines 104-107 kill a pid only if its start time still matches. This is an identity check. Its gap: a process started after the snapshot whose command line matches the sandbox path counts as fresh.
- browser_first_open.cpp:84-91 adds `Owned` and `still_ours`, which compare start times. Lines 235-237: the gate pid comes from the status output, and `own()` reads its start time at the moment it is parsed, so the comparison cannot tell a reused pid from the gate that was reported. Lines 285-291: every sandbox-path match gets its start time when scanned, so `still_ours` holds for it by construction, and its tree is still killed.
- browser_scope.cpp is unchanged apart from the message on line 247. Lines 257-263 still kill `processes_mentioning(home)` trees with no identity check. The commit message (“check kills by pid and start time”) does not cover this file.
- reap_identity.cpp (new, 126 lines) is a witness for the ledger reaper. It is not a check.

What the logs show. Read-only search of /workspace/{gm,pw,fx,index,sa,hyperagent}/runs and /tmp, for `2531` as a whole word, for the timestamps 17:56 and 19:56, and for `gate pid N` text.
- Pid 2531 was a playwriter gate: `node /data/cache/npm/_npx/bc63b05df76aa536/node_modules/pw/bin/playwriter-project --gate`. That npx package is the one gm’s live gate pid 1180507 runs (cwd /workspace/gm).
  - /workspace/pw/runs/2026-11-12-17-33-04-e70f7d/log.jsonl line 100 (result at 2026-11-12T17:37:51.763Z), from `ps -eo pid,etime,args`: `   2531    01:28:29 /data/cache/node/node-v24.22.0-linux-x64/bin/node /data/cache/npm/_npx/...`. An elapsed time of 01:28:29 puts its start at about 16:09Z.
  - /workspace/pw/runs/2026-11-12-17-41-34-6daa36/outputs/d0f98db0831d-run_shell.txt line 79, written 17:47:50Z, and 5fa63f70c88b5d01-run_shell.txt line 79, written 17:53:01Z, from `ps -eo pid,args`: `   2531 /data/cache/node/node-v24.22.0-linux-x64/bin/node /data/cache/npm/_npx/bc63b05df76aa536/node_modules/pw/bin/playwriter-project --gate`.
- The record’s disappearance time is 19:56:12 (docs line 97), with no zone. The same paragraph writes “22:08 local”, and line 98 writes “UTC” in full. If 19:56:12 is local (UTC+2), it is 17:56:12Z, three minutes after the last listing. This is an inference.
- No hit: no file contains `check-lazy-browser`, `check-browser-first-open` or `check-browser-scope`; no file contains a 17:56 or 19:56 timestamp; no gm-first-open sandbox exists in /tmp now.
- `gate pid N` text is in 37 gm run logs (dated 2026-11-04 to 2026-11-10 and two older run ids), but none of them names pid 2531.
- Other `2531` hits are not gate evidence: sequence numbers (`"seq":2531`) in gm, fx and sa logs; index compact job outputs (`2531/5777`); fixtures in /tmp (`filler-02531`, minified JavaScript); and quotes of this record in pw run outputs.
- The record cites a watcher that showed a kill wave at 19:56:05.283Z (docs line 96) and says no watcher ran at 2531’s time (line 97). No file under the paths searched holds that watcher output, so the 05.283Z reading is unverified here.
- Launcher text, pw repo at HEAD (the installed pin may differ, not checked): lib/browsers.js:186 prints `gate pid ${browser.gate.pid} for ${browser.project}` for any project’s gate. A browsers list is machine-wide, so a check that reads `gate pid N` from a reply can take another project’s gate pid.

Conclusion for item 4: open.
- The evidence proves: pid 2531 was a live playwriter gate at 17:53:01Z at the latest. The pre-fix check code SIGKILLs every descendant of a process whose command line contains the sandbox path, and of any pid that the first call’s reply names as a gate, so a foreign gate was within its reach. be9909f narrows two of the three paths. browser_scope.cpp still has the unconditional kill.
- The evidence does not prove that any gm check killed pid 2531. No file records a check run, a kill or a gate exit between 17:53:01Z and the absence the record reports. SIGKILL leaves no record in these files. The owner of pid 2531, its project directory, is not in any file read. The zone of 19:56:12 is an inference, and the watcher quoted in line 96 is not in the paths searched.
- The item 10 Phase B result (gate 2531 not present in my runs) says nothing about the earlier disappearance. “Not present at any point” there refers to my runs only.
- What would settle it: a log line naming pid 2531 with a time between 17:53:01Z and the absence, a kill record for that pid, or gm’s worker log for that window. None exists in the paths read. A reproduction of the pre-fix path under a process watcher would show whether it kills a foreign gate, but it is a Phase B step that this stretch does not run.

## Item 1 and the Phase B run on 8bacc58 (code as 4798aa1)

- Phase A: no code change. The reproduction below found no defect, so there is nothing to fix or commit for item 1.
- Reproduction loop: `node test/lifecycle.cjs`, up to 10 runs, each under `timeout 400` on its PID, stopping at the first failure (logdir /tmp/tmp.yf9mO3xS6O). Result: 10 of 10 exit 0, so the loop stopped nowhere and kept no directory. Runs (exit, wall): 1 0 41566 ms; 2 0 41340 ms; 3 0 41608 ms; 4 0 41272 ms; 5 0 41369 ms; 6 0 41791 ms; 7 0 41293 ms; 8 0 41559 ms; 9 0 41445 ms; 10 0 43447 ms.
- Item 1 stays open: not reproduced in 10 further runs, and the earlier loaded runs did not reproduce it either. The cause of the one failed debug-port probe at 19:25:34Z is unknown, because its probe reason was not recorded then. It is not recorded as a flake. The failure path is in place: a failing run writes failure.txt, with its message, line, stack, probe reasons, gate status and log tails, into the kept directory.
- Two /tmp directories that are not from this loop: /tmp/pw-test-pDLZtt, whose failure.txt starts `failure: forced failure at check 11 (PWP_LIFECYCLE_FORCE=check11)` and was written at 22:14:43Z, and /tmp/pw-test-fc2RDZ, whose failure.txt starts `failure: forced failure in cleanup (PWP_LIFECYCLE_FORCE=cleanup)` and was written at 22:15:25Z. Both come from the full set run pb-foreign-final on 4798aa1; the forced witnesses keep their directories by design. Neither was deleted.

Full set once on 8bacc58 (logdir /tmp/tmp.wP2PQghkQt): runner worst exit 0, wall 541082 ms, leftover 0 on every row. Rows: npm-test 195604 ms, f1 7885, orphan 26538, mode 4882, memory 96314, phase-b 17883, start-refusal 6673, signal 1726, stale-replace 6449, stale-held 7864, stale-unanswering 18680, stale-nosandbox 28818, lifecycle-nosandbox 41527, lifecycle-forced-check11 34701, lifecycle-forced-cleanup 41705, stale-foreign 3355 ms, all exit 0.

Item 4: no new evidence. The new logs (/tmp/tmp.yf9mO3xS6O, /tmp/tmp.wP2PQghkQt and the two job outputs) contain no `2531` as a whole word. No process from these runs was alive afterward, gm’s gate pid 1180507 is alive, and nothing listens on port 2531. Item 4 stays as recorded in b0a0d57.

## Item 1, Phase A: the probe timing under load (code read, nothing run)

Read: test/lifecycle.cjs (probeOnce, readPort, chromeUp, gateUp, gateStatus, until, the checks and the failure handler) and the launcher probe path in bin/playwriter-project (httpGet, httpOk, httpJson, the gate tick). Commit f54098c has the code.

Fixed timeouts and waits a loaded host could exceed, before this change:
- test/lifecycle.cjs: PROBE_TIMEOUT_MS 3000, one attempt per probe of /json/version and /__pwp/ping. gateStatus timeout 3000, one attempt; a timeout returns null.
- test/lifecycle.cjs: until default 8000 ms, used for the first positive wait after the first call (`until(chromeUp)`). Now 15000 ms.
- test/lifecycle.cjs: until 10000 ms on the held-lease check, the debug-port checks after the held lease and after the reuse, and the browsers-list check (kept; these retry).
- test/lifecycle.cjs: sleep(1500) before the initial negatives; sleep(IDLE_MS + 4000) before the held check and before the CLI idle check; sleep(IDLE_MS + 8000) before the final check (kept as lower bounds).
- test/lifecycle.cjs: five single-shot negatives after fixed waits or calls: after browsers close, after the agent disconnect, after the CLI idle sleep, and in the final check (two probes). They had no retry. Now bounded: 10000 to 15000 ms.
- test/lifecycle.cjs: mcpClient call timeout 90000 ms; cli spawnSync 120000 ms; until(gateUp, IDLE_MS + 30000) (kept).
- test/support.cjs: finishTest graceMs 15000 ms for owned processes to exit on their own, then stopPids sends SIGTERM, waits 1500 ms, and sends SIGKILL (kept).
- bin/playwriter-project (gate): httpGet default timeout 3000 ms for the browser probe, /json/list and /json/close. GONE_AFTER_PROBES 3 with the tick every IDLE_MS/4 (1 s): three consecutive failed probes, each up to 3 s, mark the browser gone, drop its sockets and set browser to null while Chrome may still run. GRACE_MS 5000. waitFor limits of 5000 ms (gate ping at start), 30000 ms (line 446) and 15000 ms (stop, line 1167). gone waits of 10000 and 5000 ms (lines 469, 471). Status calls with 1000 ms (lines 860, 917, 1161), 2000 ms (lines 866, 1044, 1195, 1205) and 3000 ms (line 868).

Defects fixed in Phase A (commit f54098c):
1. The failure path could lose failure.txt. readPort threw when a port file was missing, gateStatus then rejected, and the failure handler awaited it with no catch (12a74ad had removed the `.catch(() => null)` I had added earlier). Now readPort returns 0, probeOnce reports `no port file for <name>` as its reason, and gateStatus resolves null without a port.
2. Five negative checks read once after a fixed wait, so a loaded host that had not yet stopped the browser or the gate failed with reason `ok`. They now wait with until. The first positive wait after the first call moved from 8 s to 15 s.
3. The gate discarded the reason of its browser probe. httpGet returned null for a refused connection, a timeout and a bad response alike, so `probe failed 1/3` named no cause. httpGet now resolves `{ error }` with the reason, the gate tick logs it, and `browser went away` carries the last reason. httpOk and httpJson return the same values as before.

Not changed, for the owner to decide: the gate treats three consecutive failed probes as the browser having gone, and drops its state and sockets while Chrome may still run. A loaded host where /json/version takes more than 3 s on three probes in a row triggers this. The gate log now names the reason, so the reproduction under load will show whether this path fires. If it does, whether a slow browser should count as gone is a design decision.

No witness was run in Phase A, as instructed. The Phase B reproduction under load follows.

## Item 1 Phase B under load: the loop on f54098c, the full set on 8830f05

- Load: 12 busy loops (`sh -c 'while :; do :; done'`), started by me as gm job `pb-loadloop` (script /tmp/pwb-loadloop.sh, logdir /tmp/tmp.XLBIJXO5Ge, tree 8830f05, 12 cores). Load PIDs 1507020 to 1507031, each under `timeout 1500`. Load average before the loop 4.26 4.04 3.63. The load average printed with each run is the 1, 5 and 15 minute value read right after that run ended.
- Loop: `node test/lifecycle.cjs`, up to 10 runs, each under `timeout 400` on its own PID, stopping at the first failure. Result: 10 of 10 exit 0. The loop stopped nowhere, kept no directory and wrote no failure.txt, so there was nothing to read.
  - Runs (exit, wall, load average after the run): 1 0 49786 ms (13.62 6.59 4.51); 2 0 50680 ms (18.90 9.08 5.47); 3 0 52211 ms (22.02 11.58 6.54); 4 0 51742 ms (21.15 13.10 7.33); 5 0 49220 ms (21.18 14.41 8.08); 6 0 47778 ms (14.40 13.74 8.16); 7 0 47370 ms (8.70 12.35 7.99); 8 0 51493 ms (16.58 13.91 8.75); 9 0 48781 ms (15.63 14.09 9.08); 10 0 46690 ms (15.85 14.33 9.40).
  - Walls: 46690 to 52211 ms under load, against 41293 to 43447 ms for the quiet loop on 8bacc58 (above). The runs were slower under load and none failed.
- Load stopped by PID: the script's exit trap ran `kill` and then `wait` on each of the 12 PIDs. Afterwards none of 1507020 to 1507031 was listed.
- Item 1 stays open: not reproduced in 10 runs under load (load average up to 22.02). The failed debug-port probe at 19:25:34Z is still unexplained and is not recorded as a flake. The gate's gone-after-3-probes policy is unchanged, for the owner.

Full set once on 8830f05 (code f54098c, record 8830f05), job `pb-fullset-p1`, logdir /tmp/tmp.7n3UYOTzaY, `timeout 3300 node scripts/phase-b.cjs --watch <logdir>` over 16 rows. Runner exit 0, runner worst exit 0, wall 548356 ms, leftover 0 on every row.
- Rows (exit, wall ms): npm-test 0 207090; f1 0 7906; orphan 0 26550; mode 0 4853; memory 0 96178; phase-b 0 17733; start-refusal 0 6226; signal 0 1693; stale-replace 0 5686; stale-held 0 6982; stale-unanswering 0 18563; stale-nosandbox 0 27468; lifecycle-nosandbox 0 41253; lifecycle-forced-check11 0 34772; lifecycle-forced-cleanup 0 41596; stale-foreign 0 3370.
- The two forced rows exit 0 because their witnesses expect the forced failure. Their kept directories are by design: /tmp/pw-test-l7cFky (check11, failure.txt starts `failure: forced failure at check 11 (PWP_LIFECYCLE_FORCE=check11)`, written 23:08:16Z) and /tmp/pw-test-t7zXej (cleanup, failure.txt starts `failure: forced failure in cleanup (PWP_LIFECYCLE_FORCE=cleanup)`, written 23:08:57Z). Neither was deleted. /tmp/pw-test-pDLZtt and /tmp/pw-test-fc2RDZ were kept too.
- After the full set: no pw-test-, pw-stale- or foreign-server process left; none of the load PIDs; gm's gate pid 1180507 alive and untouched; nothing listens on port 2531.
- Item 4: no `2531` as a whole word in /tmp/tmp.XLBIJXO5Ge or /tmp/tmp.7n3UYOTzaY. It stays open, as recorded in b0a0d57.
- Longest step: the full-set runner, 548356 ms (9 min 8 s). Its longest row was npm-test, 207090 ms.

## Gate probe policy: GONE_AFTER_PROBES stays 3, decided from the logs

Decision: keep `GONE_AFTER_PROBES = 3`. It is not raised. The logs show no streak of two or more failed probes that recovered, so nothing shows that three is too strict, and the smallest raise the data supports is none.

Evidence, from the gate logs named (times UTC, each line quoted from its file):
- Streaks of two misses followed by a third, which marked the browser gone: 7 in all. Six are from gm's fix-test gates on 2026-11-09 between 00:59 and 01:06 (`/tmp/gmfix-projA-XVq0Zd`, `gmfix-projB-I0BbtT`, `gmfix-other-B92dKz`, `gmfix-projA2-w2gEti`, `gmfix-profile-alpha-CFGsfx`, `gmfix-profile-bravo-p84Cox`). The seventh is gm's live gate, `/workspace/gm/.playwriter/gate.log`: `probe failed 1/3` at 2026-11-10T08:14:23.493Z, `2/3` at 08:14:28.480Z, `browser went away after 3 failed probes` at 08:14:33.493Z. In all seven, the gate logged no browser start, adoption or recovery after the "went away" line. In gm's gate the next browser start, at 2026-11-11T22:05:48Z, was a spawn, not an adoption. Adoption probes the debug port first (`ensureChrome`), so the port was not answering then. No log here records why those browsers stopped answering.
- One single miss followed by answers: `/workspace/pw/.playwriter/gate.log`, `probe failed 1/3` at 2026-11-06T13:59:28Z. The next line is the gate's exit at 15:08:44Z (`browser stopped`, `no leases`). Each failed tick logs a line, and there was no "stopped answering" or "went away" line in between, so the ticks in those 70 minutes answered. One miss is below the threshold.
- Five single misses on a request, under the previous call-path rule: `browser stopped answering; starting it again` at 2026-11-12T16:32:42.531Z, 16:34:28.024Z, 16:36:34.184Z, 16:38:16.428Z and 20:53:47.481Z (the pwfo, pwfo-race, pwfo-ctx-vfoC and tmp.wyO9Mm9ttM logs). Each was followed 0.4 to 0.5 s later by `browser started pid=…`, a spawn, and none has a `start deferred` line. A spawn means no live process held the profile lock, so the browser before each restart was dead. Three of the five came 0.7 to 1.1 s after a tick's `probe failed 1/3`, so those were two misses and then a dead browser.
- Witness-side probes in the ten loaded runs (`/tmp/tmp.XLBIJXO5Ge`) and in `lifecycle-nosandbox.log` of the full set on 8830f05 (`/tmp/tmp.7n3UYOTzaY`) show no probe timeout and no HTTP error. Their only failures are ECONNREFUSED where the witness expects the port to be down. The gate's own logs for those runs are not kept, because a passing `lifecycle.cjs` deletes its project directory, so these rows are witness-side evidence only.

Tally: 7 streaks of two or more misses, none recovered. 1 single miss followed by answers. 5 single misses on a request, each followed by a dead browser.

## Call-path miss: one rule for the tick and for requests (fc2d19a, witness 3d4142e)

- Before: a request through the gate probed once. A failed probe logged `browser stopped answering; starting it again`, dropped every socket the gate held, and restarted the browser. The tick needed three misses for the same outcome, so the two paths disagreed.
- Change, `bin/playwriter-project`: a request's miss counts into the same `missedProbes` as a tick miss. The request retries the probe after `PROBE_RETRY_MS` (1000 ms) and marks the browser gone at the third consecutive miss (drops sockets, logs `browser went away after 3 failed probes`). Concurrent requests share one check. The tick keeps one probe per tick.
- Cost: a request to a browser that is really gone waits about 2 s more before the restart (two 1 s retries; a refused port fails at once). If the port hangs, each probe takes its 3 s timeout, so the worst case is about 11 s before the restart, against 3 s before.
- Witness `test/callprobe.cjs` (`npm run callprobe`, added to `npm test`): starts the browser through a tool call, holds a lease (an open `/__pwp/lease` response), SIGSTOPs the browser's listening process for 3.5 s (a process the test's own gate started; resumed in a `finally`), and sends `GET /json/version` through the gate during the stop. It asserts no `stopped answering`, no `browser started` and no `went away` after the stop; one `probe failed 1/3`; a 200 answer with `webSocketDebuggerUrl`; and the same listener pid afterwards.
- Why a request and not a tool call: a second `exec` reused the executor's open connection and sent nothing to the gate, so no probe ran. The first witness version used `exec` and failed at its logging assertion for that reason (kept `/tmp/pw-callprobe-ds3bWY`).

## Phase B on fc2d19a (launcher) and 3d4142e (witness): green

- `node test/callprobe.cjs` on the fixed launcher: exit 0, wall 14356 ms (logdir /tmp/tmp.OEElWY4IN7). Output: `ok: one missed probe during a request is logged as one miss; the browser is not restarted and the request is answered`, then `callprobe: all checks passed`.
- Red on the previous launcher (`git show HEAD~1:bin/playwriter-project` put in place, the witness run, then `git checkout -- bin/playwriter-project`; the tree was clean afterwards): exit 1, wall 12191 ms, `callprobe: FAILED: one missed probe during a request does not restart the browser`. Kept `/tmp/pw-callprobe-9a9NdW`. Its gate.log: `23:34:02.539Z browser stopped answering; starting it again`, then `23:34:03.049Z adopted running browser pid=1608149` (the same browser), then the gate exit at `23:34:08.301Z`.
- Full set once on 3d4142e (logdir /tmp/tmp.VSD8tgnslA, gm job pb-fullset-p2, `timeout 3300`): runner exit 0, runner worst exit 0, wall 569716 ms (9 min 30 s), leftover 0 on every row. Rows (exit, wall ms): npm-test 210593 (the chain now ends with callprobe); f1 7947; orphan 26766; mode 5044; memory 96366; phase-b 17833; start-refusal 6313; signal 1702; stale-replace 6240; stale-held 7050; stale-unanswering 18556; stale-nosandbox 27644; lifecycle-nosandbox 41615; lifecycle-forced-check11 36473; lifecycle-forced-cleanup 41557; stale-foreign 3355; callprobe 14210. All exit 0.
- The forced witnesses keep their directories by design: `/tmp/pw-test-Gonamr` (check11) and `/tmp/pw-test-yrHRCi` (cleanup).
- After the run: no process of these runs is left (no pw-test-, pw-stale-, pw-callprobe- or foreign-server process). gm's gate pid 1180507 is alive and untouched, and nothing listens on port 2531.
- Kept from this turn, nothing deleted: `/tmp/pw-callprobe-9a9NdW` (the red), `/tmp/pw-callprobe-TQFFQs` (the first red, from the first witness version) and `/tmp/pw-callprobe-ds3bWY` (the first green attempt).

## Item 4: open, with what is ruled out

Status: open. The cause of gate 2531's disappearance is not established.

- Ruled out: no kill event for pid 2531 in pw's logs or gm's logs. gm's search of 17:53:01Z to 17:57Z found none; this is the result reported for this turn, and gm's search was not re-run here. The new logs of this turn (`/tmp/tmp.XLBIJXO5Ge`, `/tmp/tmp.7n3UYOTzaY`) contain no `2531` as a whole word.
- The pre-fix kill paths that could reach a foreign gate, at gm's be9909f (read with `gh api`; no gm code was run):
  - `lazy_browser.cpp`: fixed. A kill needs the pid's start time to match, and fresh pids are counted against a snapshot.
  - `browser_first_open.cpp`: fixed. The gate pid is checked by start time before the kill, and sandbox-path matches are checked when scanned.
  - `browser_scope.cpp`: not fixed. Its kill at lines 257 to 263 (the process trees of `processes_mentioning(home)`, then `kill_processes(tree)` at line 263) is unchanged; the commit changes only the message on line 247.
  So the pre-fix paths are fixed in be9909f for two of the three files, not all three.
- gm's gate pid 1180507 is alive and untouched, and nothing listens on port 2531.
- Clarification: line 96 of this file calls "item 1, the lifecycle failure" settled by gm's check. That is the gate-gone wave of an earlier run, not the 19:25:34Z probe failure. Item 1 stays open.
- What would settle it: a kill record naming pid 2531, or a log line naming it with a time between 17:53:01Z and its absence. None is in the logs read.

## Remaining pw work, ranked

1. Done in this turn: a missed probe on a request restarting the browser (fc2d19a, witness 3d4142e). Green.
2. Item 1, the 19:25:34Z probe: no work until it fails again. The probe reasons and `failure.txt` are in place, and the probe was not reproduced in ten loaded runs.
3. Item 4: the remaining kill path (`browser_scope.cpp`) is in gm's repo, not pw's.

Blocked on the owner, not ranked: item 3, the sandboxed launch (needs the owner's host sandbox setting); the `--no-sandbox` fallback (stays off; item 2, the owner decides); F1 and the upstream send (`docs/UPSTREAM_PLAYWRITER.md` needs the owner's repro, and nothing is sent); deleting `/tmp/pw-test-*` (item 7, needs proof of ownership). Not recoverable: the reason for the revert 001cf63 (item 5) is in no record.

## Load witness for the request-path change (36846ac): 20 runs, no restart after a miss

Setup: 12 busy loops (`sh -c 'while :; do :; done'`), started by me under `timeout 1800`, pids 1645441 to 1645452, each stopped by its own pid in an EXIT trap (kill, then wait). The loop ran `test/callprobe.cjs` then `test/lifecycle.cjs`, ten times each, each node pid under `timeout 400`, stopping at the first failure. No run failed, so no directory was kept. The gate logs were copied before each test deleted its project directory, by a preload hook kept outside the repo (`node -r hook.cjs`, which copies `.playwriter/gate.log` and `browser.log` when `fs.rmSync` is called on a `pw-test-*` or `pw-callprobe-*` directory). logdir /tmp/tmp.BGUVFWobZB, tree 36846ac, gm job pb-loadwitness1. Load average before the loop 4.30 3.73 3.98; nproc 12.

- Exit codes and walls (ms): callprobe 1 to 10 exit 0 each, walls 20636, 20920, 18338, 16097, 21558, 17397, 17697, 16301, 22475, 22388. lifecycle 1 to 10 exit 0 each, walls 54299, 49911, 48913, 53046, 54051, 50077, 50942, 50567, 66695, 61373. Sum of all walls 733681 ms.
- Load level: 1-minute load average after each run ran from 3.28 (the first run, still rising) to 34.74 (callprobe 10). Both loops were on 12 cores under the 12 busy loops.
- Restarts from the gate logs: "went away" 0 and "stopped answering" 0 in all 20 runs. No gate restart followed a missed probe.
- callprobe (10 runs): one `probe failed 1/3: timeout after 3000 ms` per run. That is the request miss the witness injects with SIGSTOP. Each run then answered and kept its browser: one `browser started` per run. Run 7 has a second line, `probe failed 2/3: timeout after 3000 ms`, 0.25 s after the first. The log does not say which path wrote it. The timing fits a tick probe (the tick starts 5 s after gate start, and the second probe began at 26.6 s, the request probe at 26.35 s), so run 7 had one request miss and one tick miss, both below 3 and reset by the next answer.
- lifecycle (10 runs): no `probe failed` line in any run, so no miss happened organically under load. Each run shows three `browser started` and three `gate on` lines. They come from the test's own steps: the browsers tool closes the browser, the gate exits after its grace period, the next CLI session starts a gate, the idle stop, then the reopen. None followed a miss.
- Request-path misses in these runs: 10 injected, one per callprobe run. Each was answered at the next probe, and none led to a restart. No restart after a single miss on a live browser was found.

Conclusion: no defect in 36846ac under this load, so no fix, no Phase A change, and no push. Item 1 and item 4 stay open.

Limits: the lifecycle runs produced no organic miss under this load, so the miss path under load was exercised only by callprobe's injected 3.5 s stop. The gate log writes a request miss and a tick miss with the same text, so attribution is by the witness's own timing.

## Remaining pw work, ranked from the backlog (36846ac, 70eac54)

Ranked: every remaining item that needs neither the owner nor gm's repo, from this file, the README, DESIGN.md and docs/.

1. Phase A d65edca, Phase B in the next section: the foreign-gate witness (`test/stale.cjs foreign`) joins the default stale run, so `npm test` covers it. This file kept it out until gm's kill-scope fix landed. `be9909f` is on origin/main, so that reason no longer applies. The witness only spawns and signals its own stub in its own temp directory, so it checks pw's identity check, not gm's kill path (see item 4 below).
2. Lifecycle negatives: Phase A done (331b04b to efb8979, section below). A negative now needs three failed probes one tick apart (`confirmedGone`), so one timed-out probe on a live gate no longer passes. Phase B is pending.
3. Item 1, the 19:25:34Z probe failure: open. Not reproduced in 10 quiet runs, 10 loaded lifecycle runs on f54098c, and 10 lifecycle plus 10 callprobe runs on 36846ac. The probe reasons and `failure.txt` are in place. This only moves on a recurrence.
4. The shared-gate `execute` reply race from gm's follow-up task (runs/2026-11-11-18-32-18-2ed982): dd77686 added the raw reply when an execute call has no text. No failure has been seen since, and nothing here shows the race still happens, so there is nothing to fix.

Blocked on the host, not reachable here: the Windows browser scan and the browsers tool (README: not covered; the Windows CI passed at 47317fa, before this series). The macOS scan (`ps`) has never been tested. Item 5's page-target wait would reopen only on a counter-measurement from another host.

Excluded, owner or gm: item 3 (sandboxed launch, needs the owner's host sandbox setting); the automatic `--no-sandbox` fallback (item 2, stays off); F1 and the upstream send (`docs/UPSTREAM_PLAYWRITER.md`, needs the owner's repro); deleting `/tmp/pw-test-*` (item 7); item 4's kill path in `browser_scope.cpp` (gm's repo); the consumer pin in `docs/CONSUMERS.md` (243db69, 68 commits behind at 36846ac; gm's `defaults/mcp.json` takes that pin, so the re-pin is gm's and the owner's).

Phase A, d65edca: `test/stale.cjs` `DEFAULT_MODES` gains `foreign`, and the line that said foreign is not run by default is removed. Witness: the default `node test/stale.cjs` runs four modes, and `npm test` runs it.

Phase B on 5424cab (code d65edca; docs 70eac54 and 5424cab; gm job pb-fullset-p3, `timeout 3300` on the runner, logdir /tmp/tmp.i9YJEnJWA9): the full set once, 17 rows. Runner exit 0, runner worst exit 0, wall 573023 ms, leftover 0 on every row.
- Rows (exit, wall ms): npm-test 213058 (its chain runs the default stale mode, now with foreign); f1 7973; orphan 26536; mode 5034; memory 96414; phase-b 17824; start-refusal 6393; signal 1704; stale-replace 6049; stale-held 7400; stale-unanswering 18603; stale-nosandbox 29876 (the default `node test/stale.cjs`, four modes); lifecycle-nosandbox 41472; lifecycle-forced-check11 34728; lifecycle-forced-cleanup 41702; stale-foreign 3501; callprobe 14293. All exit 0.
- The default stale run now prints the foreign check: `ok: a process on the gate port that is not this project gate is not signalled, and no lease is taken on it`, then `stale: all checks passed` (`stale-nosandbox.log`). The npm-test log has the same line.
- Forced witnesses keep their directories by design: `/tmp/pw-test-qkgbEe` (check11) and `/tmp/pw-test-t0xi5Y` (cleanup).
- After the run: no process of these runs is left, gm's gate pid 1180507 is alive and untouched, and nothing listens on port 2531.
- Longest step: the full-set runner, 573023 ms (9 min 33 s). Its longest row was npm-test, 213058 ms.
- The top reachable item, the foreign witness in the default stale run, is done. Items 1 and 4 stay open.

## Lifecycle negatives: three failed probes before a check reads "gone" (Phase A, then Phase B)

Mechanism: a negative check passes only when the thing is confirmed gone by the launcher's own rule, three failed probes in a row one tick apart. `GONE_AFTER_PROBES = 3` is in `bin/playwriter-project`. The tick is `Math.min(5000, Math.max(200, IDLE_MS / 4))`, which is 1000 ms at the test's 4000 ms idle, so `confirmedGone` waits 1000 ms between probes. The pid route is not used: the gate writes no pid file (only `gate.log`, `browser.pid`, `browser.fingerprint` and the state JSON), so its pid is readable only while it answers. The checks here are about the gate port and the debug port, so the probe route is the one that matches them.

Changes, each one a local commit as lanmower with no trailers; nothing pushed:

- 331b04b, `test/lifecycle.cjs`: adds `GONE_AFTER_PROBES`, `PROBE_GAP_MS` (IDLE_MS / 4), `confirmedGone(probe)` and `launcherGoneAfter()`, and a sync assertion before the first check. Witness: `the test counts a gate or browser as gone after the same number of failed probes as the launcher`; it fails if the test's constant and the launcher's differ. The check count is unchanged.
- 17594ae, check 1 `listing tools starts no gate and no browser`: the single `gateUp()` and `chromeUp()` probes become `confirmedGone`. Witness: assertions `listing tools starts no gate` and `listing tools starts no browser`.
- c645f13, check 6 `browsers close stops the project browser when no other lease is held`: `until(!chromeUp())` becomes `until(() => confirmedGone(chromeUp), 10000)`. Witness: `the debug port stops answering after the close`.
- a4d9032, check 7 `gate exits and the browser stays closed once the agent disconnects`: the gate wait and the extra single `gateUp()` assert become `until(() => confirmedGone(gateUp), IDLE_MS + 30000)`, and the browser assert becomes `until(() => confirmedGone(chromeUp), 10000)`. Witness: `the gate exits once the agent disconnects` and `the browser stays closed once the agent disconnects`.
- 0c6f0a7, check 10 `CLI session browser stops after idle`: `until(!chromeUp())` becomes `until(() => confirmedGone(chromeUp), 12000)`. Witness: `the CLI session browser stops after idle`.
- 3d76975, check 12 `everything is stopped at the end`: `!chromeUp() && !gateUp()` becomes a `confirmedGone` for each. Witness: `the browser and the gate are stopped at the end`.
- efb8979, new `test/negative-control.cjs` and `package.json`: the `negative-control` script, and the same command as the last step of the `npm test` chain. The control starts a browser through an MCP session, holds a lease, takes the debug port's listener pid from `ss`, and SIGSTOPs it for 3500 ms (the injection `test/callprobe.cjs` uses). Inside that window it runs the old single probe and `confirmedGone` on the debug port. Witness: exit 0 only when the old probe reads the stopped browser as gone (`single-probe check: FAILED: ... this is the red control`) and `confirmedGone` does not (`confirmed check: ok`). The project directory is removed on success and kept on failure.

Outside this change: `test/orphan.cjs` (`answering` after exit, one `/json/version` fetch with a 2 s timeout) and the answer helpers in `test/leases.cjs`, `test/fallback.cjs`, `test/ready.cjs` and `test/stale.cjs` are single-probe checks, but they are not lifecycle runs, so they are left for a separate pass. The `npm test` chain runs `test/lifecycle.cjs` and the control, so it picks up both changes.

Phase B: see the two sections below. Phase A ran no build, test, gate or witness.

## Probe refusals in the loaded lifecycle runs (efb8979 and 9fbe76a): no refusal on a live gate

The three lifecycle runs under 12 busy loops (logs in /tmp/pwb-neg-ORRLni) each ended with `gate /__pwp/ping` refused 9 times (ok 16, 23 and 14) and `debug-port /json/version` refused 15 times (ok 3). No refusal was on a live gate.

The counts follow from the checks. A `confirmedGone` decision sends three probes one second apart and returns true only when all three are refused. The test makes eight such decisions per run, and 8 × 3 = 24 = 9 + 15:

- Start, before the first call: gate 3, debug 3. The launcher claims `port` and `debug-port` as soon as the MCP wrapper starts (`loadPorts` in `main` and `proxyMcp`, through `claimPort`), so both files exist and point at nothing. No gate had started yet; the first `gate on` line is at 00:19:04.310 in run 1, after the start checks.
- Browsers close: debug 3. The browser stopped at 00:19:16.361 in run 1.
- Disconnect: gate 3, debug 3. The gate logged `gate exiting: no lease for the grace period` at 00:19:21.472 (run 1), 00:20:31.889 (run 2) and 00:21:48.159 (run 3). The browser had already stopped in the close step.
- CLI session idle: debug 3. `browser stopped` at 00:19:34.107 in run 1.
- Final stop: gate 3, debug 3. The gate had been gone since 00:19:47.367 and the browser since 00:19:47.111 in run 1, so the first iteration confirmed both.

Every refusal came after the stop that the test expected, and the logs fix that stop time for each step. Two counts rule out a refusal inside a positive step: the refusals add up to exactly the 24 from the eight decisions, so no `until(chromeUp)` or reuse step saw one before its success. The ok probes come from the disconnect wait (gate, while the gate was still up) and the three positive `until(chromeUp)` steps (debug).

Cause: the probe is not a defect. The refusals are the expected absence in the new negatives, and the count grows with the number of negative steps, not with failures. The gate logs show 0 `probe failed` lines in all three runs, so no gate probe failed in the gate's own tick either.

Limit: the probe report has no timestamps. The one-to-one match between the logged stop times and the refusal counts is the evidence, not a per-probe timestamp.
