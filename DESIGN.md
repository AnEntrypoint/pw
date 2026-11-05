# Design notes

## Browser scan on Windows is unverified

`lib/browsers.js` lists Windows processes with PowerShell `Get-CimInstance Win32_Process`, and the command-line tokenizer `windowsArgv` is covered only by an isolated check. The PowerShell path has never run on a Windows host.

Decision: accept Linux-only verification for this change, recorded here by the pw owner. Linux checks: `test/lifecycle.cjs` passes 12 of 12 and `status` lists browsers on Linux.

To close the gap, run `node bin/playwriter-project status` on Windows with a running browser, and confirm the browser, its owner and its profile are listed. If the scan fails there, the result reports `supported: false` with the error.
