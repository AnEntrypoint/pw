# Consumers: moving to the direct pw entry

This note is for gm (defaults/mcp.json) and for each project's .mcp.json. It replaces the npx chain with one node process per session.

## Pin

- Pinned commit: 243db69 (AnEntrypoint/pw, main). Install form: github:AnEntrypoint/pw#243db69.
- Commits after 243db69 may change the static tool list; re-pin only after the tools test passes in that checkout.

## Direct entry (no npm exec, no shim)

Check out pw at 243db69, run `npm ci` once in that folder (the bin requires its node_modules, including playwriter 0.9.0), then register:

    {"command": "node", "args": ["<install>/pw/bin/playwriter-project"]}

Replace <install> with the absolute path of the checkout. Nothing in the bin runs npm or npx at run time.

## Old entry, for the transition

    {"command": "npx", "args": ["-y", "-p", "github:AnEntrypoint/pw#243db69", "playwriter-project"]}

This still works but runs npm exec, a shim and node: three processes before the launcher.

## Relay

Sessions on this pin run in direct mode (the launcher always sets PLAYWRITER_DIRECT), and the playwriter child starts no CDP relay in direct mode. Nothing in this repo needs a relay change; a relay left by a client that does not use direct mode is outside pw.

## Final pin for this round

Pin: 243db69 (launcher with busy-tracked leases, idle child and gate retirement, trimmed renderers). Use github:AnEntrypoint/pw#243db69 or the direct checkout at 243db69.

## What changes for consumers

- gm: set the playwriter entry in defaults/mcp.json to the direct entry above, keep lazy: true, and make defaults/mcp-tools/playwriter.json equal lib/mcp-tools.json at the pin. The launcher now answers initialize and tools/list itself, so that file only feeds gm.verbs().
- Projects: an idle session is one launcher process; the gate and browser start on the first browser call and stop when the last session releases its lease (5 s grace).
- `playwriter-project start` opens the browser, checks it answers, and stops it when no session holds a lease.
- `browsers close` and status keep their behaviour.
