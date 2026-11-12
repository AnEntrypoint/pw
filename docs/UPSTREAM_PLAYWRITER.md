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
