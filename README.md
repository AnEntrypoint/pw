# pw

playwriter with one Chrome profile per project. The browser starts on first use and stops after 5 minutes with no traffic.

pw installs playwriter 0.9.0 and gives each project its own Chrome profile, kept at `.playwriter/browser-profile`.

Requirements: git, Node 22 or later, and a Chrome or Chromium. If no browser is found on first use, playwriter downloads Chrome for Testing.

Install, once. It needs only add-mcp, run through npx:

    npx -y add-mcp "npx -y github:AnEntrypoint/pw" -n playwriter --all -g -y

`-g` is user level. `--all` writes every agent add-mcp supports. Use `-a claude-code` for one agent.

Each agent gets an MCP entry named `playwriter`. The first tool call starts a gate for the project. The gate listens on 127.0.0.1, starts Chrome when a request arrives, and closes it when idle.

The project is the first of these that applies: `PLAYWRITER_PROJECT_DIR`; the nearest folder that holds `.playwriter`, searched upwards from the current directory; the nearest folder that holds `.git`; the current directory. A command run from a subdirectory therefore uses the same gate and profile as one run from the root. A gate that answers for another project is refused, and never adopted.

Each MCP tool result ends with a status block. Its first line is this project's gate. Then comes one line for every Chromium browser open on the machine, and the pages of this project's browser sit under its line. `playwriter-project status` prints the same block, and `status --json` prints JSON with a `browsers` list. Status does not start the browser and does not count as traffic for the idle timer.

The gate records the pid of each browser it starts in `.playwriter/browser.pid`. A browser that answers on the project's debug port but has another pid is reported as `adopted: true` with a warning, and the gate logs the same warning. The gate does not stop an adopted browser. The pid check runs on Linux and macOS only.

In a Linux container, add `--env PLAYWRITER_NO_SANDBOX=1` to the install command. Tabs close on an idle stop, and session cookies do not survive it.

Add `.playwriter/` to each project's `.gitignore`.

The manual is `docs/index.html`. It covers the install options, the modes, the files, the environment, the limits and the troubleshooting messages.

## Browsers on this machine

A process counts as a browser when its program is Chromium or Chrome and it has no `--type=` argument. That leaves out renderer, GPU and helper processes. Linux reads `/proc`; macOS runs `ps`. Each browser line gives:

- the pid and the owner: this project's gate, another project's gate with its project path, or none when no pw profile is in use;
- the profile directory, or `default` when the browser has no `--user-data-dir`;
- the debug port, when `--remote-debugging-port` is in its arguments;
- the page count from `/json/list`, when that port answers;
- the window count from `xdotool search --pid`, when `DISPLAY` is set and xdotool is installed. Without xdotool the line has no window count. A busy X server can make a count read 0.

The scan is cached for 2 seconds in each MCP process. Each probe waits at most 700 ms and the probes run in parallel, so a tool call waits about one second at most for the block.

## The browsers tool

Each MCP session lists a `browsers` tool next to `execute` and `reset`. It takes `action`, `target` and `force`.

- `action: "list"` returns every browser as JSON.
- `action: "close"` with `target: "project"` closes this project's browser through its gate, the same way the idle stop does. It is refused while another lease is held, unless `force` is true. The refusal lists the lease pids. The calling session's own lease does not count. An adopted browser is refused.
- `action: "close"` with `target: "pid:<n>"` closes a browser only when its pid is the one this project's gate started, the pid in `.playwriter/browser.pid`. Any other pid is refused, and the refusal names its owner: another project's gate with its path, a default or other browser, or an adopted browser. The lease rule applies here too.

The reply is JSON: the action, the target, what was closed, what was refused and why, and the browser list after the close. The status block after the reply shows the same new state. The tool never closes a page. Closing a browser ends its tabs.

A gate that runs code from before the browsers tool does not report `closeVerb` in its status, so `browsers close` is refused on it until it goes idle and exits.

Limits: Windows is not covered by the browser scan or the browsers tool. The block says so, and close is refused. macOS is scanned with ps and is not tested. The default browser is listed with owner none and is never closed by the tool.
