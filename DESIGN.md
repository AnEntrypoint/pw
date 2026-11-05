# Design notes

## Browser scan on Windows is verified in CI

`.github/workflows/windows-scan.yml` runs on windows-latest: `test/lifecycle.cjs` (12 of 12), then `status --json` with a headless Chrome that the job starts and later stops by its PID. The check passes only if the scan reports `supported: true` and lists that PID. Passing run: 42044467037 (commit 47317fa on AnEntrypoint/pw main).

Windows fixes that the run required: the MCP check runs the wrapper through node; the project folder is removed with retries; the test stops only the CDP relay it started, because the relay inherits the project folder as its working directory and holds it on Windows.
