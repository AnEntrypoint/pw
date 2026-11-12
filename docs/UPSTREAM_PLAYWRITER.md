# Upstream change for playwriter

Status: temporary. The fix lives in `patches/playwriter+0.9.0.patch`, applied to node_modules on install by `patch-package --error-on-fail` (postinstall). Remove the patch, the postinstall, the `patch-package` dependency and `test/patch.cjs` once a playwriter release carries the change.

## Change to send

Repo: remorses/playwriter, version 0.9.0. Files: `src/executor.ts` (`PlaywrightExecutor.connectToBrowser`, direct CDP branch near line 973 and extension branch near line 1010) and the matching `dist/executor.js` lines (737 and 764).

Add `defaultBrowserContext(browser)`. When `browser.contexts()` is empty, it opens one `about:blank` page in the default context with `Target.createTarget` (no `browserContextId`) on a browser-level CDP session, waits up to 5 s for `browser.contexts()` to list a context, and returns `contexts[0]`. Only if the list is still empty does it fall back to `browser.newContext()`. Both connect branches call it. The headless branch is unchanged.

Why: `browser.newContext()` creates a context that Chrome disposes when the connection that created it closes, so a page opened in it does not outlive the executor. A page in the default context does.

Conflict to decide: the `connectToBrowser` doc comment says "Never opens a tab". The change breaks that rule, so the maintainer decides it.

## Evidence from this repo (playwriter 0.9.0, Chrome 155)

- Unpatched F1 repro (`npm run f1`): a page opened through the launcher, the gate SIGKILLed by its pid, then restarted. The page is still listed in the default context (`F1 defaultHas=true executorIsDefault=true contexts=1`). The loss in the owner report did not reproduce.
- A browser that already has a page: `connectOverCDP` lists the default context at once (`immediate: 1`).
- A cold start with the launcher flags: 6 of 6 trials listed the default context immediately after connect.
- Closing the last page makes Chrome exit (`/json/version` refused), so the zero-page state that the fallback needs does not persist with this Chrome.

So the fallback branch is not reached under the conditions observed here. The patch is defensive until a reproduction of the loss exists.

## Witness for the upstream PR

A playwriter test that starts Chrome with `--no-startup-window` (zero page targets), runs the executor connect, opens a page, disconnects the executor, and checks that a new connection still lists the page. Without the change the page is lost; with it the page stays.

Open question for the owner: the repro that lost the page. Send it, with the browser start and the gate kill steps, so the loss can be reproduced.
