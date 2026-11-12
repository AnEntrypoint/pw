# Upstream change for playwriter

Status: not sent. The change is a defensive patch, `patches/playwriter+0.9.0.patch`, applied to node_modules on install by `patch-package --error-on-fail` (postinstall). The evidence below does not show the change is needed. Do not send it until the owner reproduces the loss. When a playwriter release carries the change, remove the patch, the postinstall, the `patch-package` dependency and `test/patch.cjs`.

## The change

Repo: remorses/playwriter, version 0.9.0. Files: `src/executor.ts` (`PlaywrightExecutor.connectToBrowser`, direct branch near line 973, extension branch near line 1010) and `dist/executor.js` (lines 737 and 764). The headless branch is unchanged.

Adds `defaultBrowserContext(browser)`. When `browser.contexts()` is empty, it opens one `about:blank` page in the default context with `Target.createTarget` (no `browserContextId`) on a browser-level CDP session, waits up to 5 s for `browser.contexts()` to list a context, and returns `contexts[0]`. It falls back to `browser.newContext()` only if the list is still empty.

Intent: a page in the default context is not tied to the executor connection. A page in a `browser.newContext()` context might be.

## Evidence (playwriter 0.9.0, Chrome 155, this repo)

- Unpatched F1 repro: a page opened through the launcher is still listed after the gate SIGKILL and restart, in the default context (`firstPageSurvivedGateKill: true`, `executorIsDefault=true`, `contexts=1`).
- Patched F1 repro after a clean install: the same result.
- Chrome started with `--no-startup-window` (zero page targets): `browser.contexts()` already lists one context (`contextsBefore: 1`), so the `browser.newContext()` fallback is never reached. Unpatched and patched both put the page in the default context (same `browserContextId` as a reference page created without one). The page is still listed 5 s after the executor process exits, in both cases.
- A warm browser with a page, and a cold start with the launcher flags (6 of 6 trials): `browser.contexts()` lists the default context immediately after connect.

Conclusion: the fresh-context loss the owner described was not reproduced in any state tested. The patch does not change observed behaviour.

## Needed from the owner

The repro that lost the page: the browser start, the first call, the gate kill and the restart, the Chrome version, and whether extension mode was used. The launcher always sets PLAYWRITER_DIRECT, so extension mode (`dist/executor.js` line 764) is not on the launcher path.

If the loss is reproduced, the upstream test should start Chrome in the owner's conditions, open a page through the executor, disconnect the executor, and check the page is still listed. The zero-window probe above passes unpatched, so it cannot be that test.

## Gate signals (decision, launcher, no build change)

SIGINT, SIGTERM and SIGHUP exit the gate even while a lease is held. The handler is the `for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])` loop in `bin/playwriter-project` that calls `exitGate(..., { force: true })`.

Reason: a signal is an explicit kill, so holding the gate open would refuse the request to stop. The launcher reopens the gate on the next call, the same restart path the SIGKILL checks in `test/firstpage.cjs` and `test/orphan.cjs` measure. Every other exit path keeps the rule that the gate never exits with a lease held, and every exit stops the browser the gate started.

## First-open call site (decision, measured in Phase B)

Candidates on the first-open path that create or pick a browser context:

1. gm's own `browser.newContext()` in `kOpenRunContext` (`native/components/host/browser_scope.cpp` in the gm repo). This is the call site that lost the page on the pin (gm witness `contexts=[1,1,0] executorIndex=2`). Playwright creates such a context with `disposeOnDetach`, so Chrome disposes it when the gate's connection closes. The defensive patch does not cover it, because it never reaches `defaultBrowserContext`. gm commit 23a88df removed the call: the first open takes `browser.contexts()[0]`, and gm HEAD has no `newContext` in `browser_scope.cpp`. This is fixed on the gm side.
2. `dist/executor.js:727` (and the matching line in `src/executor.ts`): the fallback `browser.newContext()` inside `defaultBrowserContext`. It runs only when Playwright still lists no context after the about:blank target and the 5 s wait. The patch keeps this fallback as it was. It is the one call on the launcher's direct path that the patch does not cover.
3. `dist/executor.js:797` (`connectHeadlessBrowser`): headless mode only. The launcher sets PLAYWRITER_DIRECT and does not use this branch for the gate's browser, so it is off the first-open path.
4. `dist/executor.js:1435` (`resetPlaywright`, through `resetInternal`): calls `connectToBrowser`, so the patched helper covers it.

Rule: if the page is lost at candidate 2, the default-context fix is extended there. If the page survives, the measured reason is recorded here and no code changes. Verdict (measured in Phase B, `npm run f1`, exit 0, 8444 ms): the page is not lost, and no code changes. After the gate SIGKILL and the restart, the marker page is listed in the default context (`defaultHas=true`), and the restarted executor's context is that context (`executorIsDefault=true`, `contexts=1`). A context made by `browser.newContext()` is created with disposeOnDetach, so a page placed through candidate 2 would be gone after the kill and f1 would print `defaultHas=false`. The measured reason: the first-open page lives in the default context and is still listed after the executor's gate is killed and restarted.

Not measured: candidate 2 running under a connect that lists no context at all. The launcher cannot force that state here. A cold start listed the default context at connect in 6 of 6 trials, and b6b8939 (the launcher wait for a page target) was reverted by 001cf63, so candidate 2 is covered by the patch's wait and no row exercises its fallback.
