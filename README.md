# pw

playwriter with one Chrome profile per project. The browser starts on first use and stops after 5 minutes with no traffic.

pw installs playwriter 0.9.0 and gives each project its own Chrome profile, kept at `.playwriter/browser-profile`.

Requirements: git, Node 22 or later, and a Chrome or Chromium. If no browser is found on first use, playwriter downloads Chrome for Testing.

Install, once. It needs only add-mcp, run through npx:

    npx -y add-mcp "npx -y github:AnEntrypoint/pw" -n playwriter --all -g -y

`-g` is user level. `--all` writes every agent add-mcp supports. Use `-a claude-code` for one agent.

Each agent gets an MCP entry named `playwriter`. The first tool call starts a gate for the project. The gate listens on 127.0.0.1, starts Chrome when a request arrives, and closes it when idle.

In a Linux container, add `--env PLAYWRITER_NO_SANDBOX=1` to the install command. Tabs close on an idle stop, and session cookies do not survive it.

Add `.playwriter/` to each project's `.gitignore`.

The manual is `docs/index.html`. It covers the install options, the modes, the files, the environment, the limits and the troubleshooting messages.

Limits: Windows and macOS are not tested.
