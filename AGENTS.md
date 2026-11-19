# AGENTS.md — using AgentFleet (`aflt`) from an AI coding agent

This guide is for **AI coding agents** (GitHub Copilot CLI, Cursor CLI / `cursor-agent`, and orchestrators that shell out to them). It is the practical companion to the human-oriented [README](README.md). Flag lists and exit codes come from `aflt help` (`bin/af.js` `USAGE`) and the implementation; do not invent flags.

`aflt` is the **primary command**. `af` and `agentfleet` are aliases for the same CLI (`bin/af.js`). The product name is **AgentFleet**. Internal names are unchanged: `~/.agentfleet`, `AGENTFLEET_*`, `.agentfleet.json`, npm package `agentfleet`, MCP server name `af`, Herdr mod `af-sessions`.

Prefer **`aflt help`** (or `aflt` with no args) for the full usage text. **`aflt <command> --help` is not a dedicated help path** — some commands print a short usage error, and others (`ls`, `sync`, `import`, `doctor`, `version`) may **run the command**.

---

## What AgentFleet is

AgentFleet tracks, resumes, and orchestrates **Cursor CLI** and **GitHub Copilot CLI** sessions. Chat IDs live in engine-local stores and terminals die on reboot; `aflt` keeps a small local registry under `~/.agentfleet`, launches or resumes the right engine argv into Herdr/tmux/iTerm/WezTerm (or this terminal), runs **headless one-shots** that capture output, and can run a **master → workers** fleet (`spawn`, `wait`, `result`, `send`, `stop`) with optional task messaging and an optional documentarian pass.

It does **not** replace the engines. You (the agent) call `aflt` to create sessions, delegate work, poll status, and collect handoffs.

---

## Install and linking

Requires **Node ≥ 18**. Zero npm runtime dependencies.

From a clone of [wwlib/aflt](https://github.com/wwlib/aflt):

```bash
cd ~/github/wwlib/aflt    # or wherever you cloned
npm install -g .          # installs aflt plus aliases af and agentfleet
# or without a global install:
#   npm link
#   ln -sfn "$(pwd)/bin/af.js" ~/.local/bin/aflt
#   ln -sfn "$(pwd)/bin/af.js" ~/.local/bin/af          # optional alias
#   ln -sfn "$(pwd)/bin/af.js" ~/.local/bin/agentfleet  # optional alias
```

Ensure `~/.local/bin` is on `PATH`. Then:

```bash
aflt --version            # e.g. "aflt 1.2.0"
aflt --version --json     # {"version":"1.2.0"}
aflt doctor               # read-only: node, home, hc, engines, MCP hints
aflt doctor --json
```

Also install the engine(s) you will use:

- Cursor CLI: `curl https://cursor.com/install -fsS | bash` (`cursor-agent` / `agent` on PATH). Override with `AGENTFLEET_CURSOR_BIN`.
- Copilot CLI (optional): `npm install -g @github/copilot`. Override with `AGENTFLEET_COPILOT_BIN`.
- Herdr (`hc` + optional `herdr-app`) is recommended for interactive sessions but is not required for headless `aflt run` / `spawn`.

Optional bash completion: `source /path/to/aflt/completions/af.bash` (completes `aflt`, `af`, and `agentfleet`).

---

## Recommended workflows

Use `--json` when you will parse output. Use `--dry-run` to print the plan without mutating the registry or launching anything. Bound long runs with `--timeout SEC`.

### 1. Delegate a headless task and collect the result

```bash
# Read-only probe (Cursor --mode ask). Omit --force.
aflt run "pong-check" --prompt "Reply with the single word pong and nothing else." \
  --mode ask --cwd "$PWD" --timeout 180 --json

# Editing task — only when you intend file/tool changes. Include --force.
# In the prompt: do not switch to plan mode; do not commit/push/stash/reset/delete
# unless the user explicitly authorized that.
aflt run "fix-tests" --prompt "Fix the failing unit tests in … Acceptance: npm test passes. Do not switch to plan mode. Do not commit." \
  --force --cwd "$PWD" --timeout 600 --json

aflt log fix-tests              # last captured stdout
aflt log fix-tests --path       # path under ~/.agentfleet/runs/<id>/
```

Stdout is the engine's print-mode response. Stderr has progress plus `output: <path>`. Resume the same title later with another `aflt run <title> --prompt "…"`.

### 2. Check status

```bash
aflt ls --json                  # STATUS = lifecycle; HERDR = live runtime; includes project + parent
aflt ls --status active
aflt ls --project my-app --json # filter by stored or derived project name
aflt timeline                   # read-only session tree for cwd's project
aflt timeline --all --json      # every project, grouped
aflt dashboard --serve          # live local activity UI (default http://127.0.0.1:8787/)
aflt dashboard --snapshot /tmp/aflt.svg  # read-only SVG/HTML snapshot (≠ memory dashboard)
aflt memory sync                # opt-in: write cwd project timeline + root DASHBOARD.md
aflt memory dashboard           # regenerate root DASHBOARD.md only
aflt memory doc [--engine cursor|copilot]  # Doc Bot session (DOC-AGENT.md)
aflt memory sync --all --commit --push  # nightly: sync + commit generated + push
aflt children --json            # workers of this master, or a summary of masters
```

`STATUS` is saved lifecycle (`active` | `paused` | `done`). A process exit does **not** mark the task done — use `aflt done`. `HERDR` is live runtime from `hc ls`: `running` | `shell` | `exited` | `missing` | `unknown` | `-`. `aflt ls --json` also includes derived `workerStatus` (same rules as `aflt children --json`) plus effective `project` and `parent`. `aflt ls` never writes the registry. `aflt timeline` is strictly read-only (no registry/Herdr writes). `aflt dashboard` is read-only by default (local UI / snapshot; not `aflt memory dashboard`); `--capture-completions` explicitly writes completion notes and receipts. Live graph positions persist across SSE updates and settle; **open** counts are live/running only (Herdr-exited/`missing` registry-active sessions are **idle**, not open — registry `status` unchanged). Legacy project `af` aliases to `aflt` for dashboard hubs and memory sync/dashboard folders.

### 3. Orchestrate workers from a master

```bash
aflt master --goal "Split auth into helpers + tests" --cwd "$PWD" --headless --force --json
# or interactive (default): drops into Herdr with templates/orchestrator.md

aflt spawn --parent <master> --engine copilot --task "helpers" --prompt "…" --force --detach --json
aflt spawn --parent <master> --engine cursor  --task "tests"   --prompt "…" --force --detach --json

aflt wait --parent <master> --timeout 900 --json
# exit 0=all done, 1=failed/stopped, 2=timeout, 3=waiting (needs input)

aflt children <master> --json
aflt result <worker-id> --json
aflt result <worker-id> --require-fresh   # exit 1 if handoff is stale
aflt tail <worker-id> -n 80
aflt send <worker-id> "Please also cover edge case X"
aflt stop <worker-id>                     # or: aflt stop --all-children <master>
```

`aflt spawn` **blocks** until a headless worker finishes unless you pass **`--detach`**. Prefer `--detach` over shell `&` (backgrounded wrappers can die while the engine keeps running). Prompts must be **self-contained**: exact paths, acceptance criteria, and what not to touch. Workers do not share the master's context.

If you *are* the master (launched via `aflt master`), your env already has `AGENTFLEET_ID`, `AGENTFLEET_PLAN`, `AGENTFLEET_RESULT`, `AGENTFLEET_ROLE=master`. Re-read `$AGENTFLEET_PLAN` and run `aflt children --json` on restart. Write the plan only at `$AGENTFLEET_PLAN` and the final summary at `$AGENTFLEET_RESULT`. Do not edit project files yourself.

---

## Gotchas and safety rules

- **Do not switch to / prompt for plan mode** unless the user asked for a plan. For Cursor headless read-only work use `--mode ask`. Omit `--mode` (and pass `--force` only when edits are intended) for implementation work. Never add “enter plan mode” to a worker prompt.
- **Parse `--json`**, not table text. Confirm flags with `aflt help` or `--dry-run`.
- **`--force` is an explicit tool/write grant**, not “skip the prompt.” Cursor: `--force` auto-approves tools/shell. Copilot: `--force` maps to `--allow-all-tools`. Interactive Cursor `new`/`resume` does **not** change Cursor `--force` behavior. Omit `--force` for text-only / read-only prompts.
- **`--trust` is not `--force`.** `aflt run` / `aflt resume` pass Cursor `--trust` by default (skips the workspace-trust dialog). Use `--no-trust` to keep the dialog.
- **Do not commit, push, stash, reset, switch branches, or delete files** unless the user explicitly authorized that exact action. `aflt rm` removes registry rows and af-owned files under `$AGENTFLEET_HOME` only — never the project, `~/.cursor`, or `~/.copilot`. Prefer `aflt rm --dry-run` first. If a session is running, `aflt stop` first; `--force` on `rm` does **not** stop the process. **`aflt rm` and `aflt stop` prefer an exact id or title.** On a human TTY, a fuzzy-only query may prompt to confirm/pick; **agents and scripts never get prompts** (non-TTY / `--json` stay exact-only with a did-you-mean hint) — always pass exact ids/titles. Pass multiple `rm` targets as separate args.
- **Never print secrets** (tokens, `CURSOR_API_KEY`, MCP auth, `.env`).
- **Keep tests hermetic** if you work in this repo: use a temp `AGENTFLEET_HOME`. Never point tests at the real `~/.agentfleet` or the live Herdr.
- **Resume with the same cwd/workspace** the chat was created in. `aflt cwd` updates the registry folder/branch but does **not** move a live Herdr tab — `aflt resume` (and optionally `aflt adopt`) after.
- **Cursor interactive `aflt wait` cannot see turn-complete** (no OSC 7501). Wait will stay `running` until timeout (exit 2) or the terminal exits. Use `aflt tail` / `aflt result`, or Copilot interactive if you need `waiting`.
- **Copilot folder-trust prompt:** answer with `aflt send <id> "1"`.
- **Do not send `aflt run` through Herdr.** Headless print-mode only.
- **`--mode plan`** is a Cursor headless flag (read-only plan). Do not use it as a substitute for implementation, and do not tell an interactive Cursor agent to enter plan mode.
- After `aflt send` to an interactive worker, `aflt wait` ignores stale Herdr `done`/`idle` for `--send-grace` seconds (default 15, or `AGENTFLEET_SEND_GRACE`).
- Exit **75** = critical registry write failed after a run (result may still be printed; `--json` includes `registryWriteError`).

---

## Commands and flags

Global exit codes: `0` ok · `1` error · `2` wait timeout · `3` waiting · `75` critical registry write after a run.

Supporting commands accept **`--json`** and/or **`--dry-run`** as noted. `--dry-run` must not mutate registry or state.

### Version and help

```bash
aflt --version | -v | version [--json]
aflt help
```

### Create, register, list

```bash
aflt new "<title>" [--cwd DIR] [--prompt "..."] [--model X] [--engine cursor|copilot]
                   [--project NAME] [--force] [--messaging|--no-messaging] [--tag T]... [--dry-run]
# create-chat / mint UUID → register → interactive launch

aflt add "<title>" --chat <id> [--cwd DIR] [--model X] [--engine cursor|copilot]
                   [--project NAME] [--tag T]... [--prompt "..."]
# For --engine copilot, --chat is the Copilot session UUID

aflt import [--engine cursor|copilot] [cursor|copilot]
# List local chats to register. Default engine follows AGENTFLEET_ENGINE/config (builtin: cursor).
# Cursor: scan ~/.cursor/chats. Copilot: list ~/.copilot/session-state (or import by id).

aflt import --engine copilot [<id|prefix>...] [--title T] [--tag T]...
            [--cwd DIR] [--limit N] [--json] [--all] [--dry-run]
            [--allow-missing] [-i|--pick]
# --title only with a single id. -i requires a TTY.

aflt ls [--status S] [--tag T] [--project NAME] [--all] [--json]
# --json includes effective project + parent on every row

aflt timeline [<project>] [--all] [--json] [--since <date>]
# Read-only project session tree (no registry/Herdr writes). Default project =
# AFLT_PROJECT, else cwd project. Chronological roots + indented children; best-effort
# git commits in each session window. --since ISO or YYYY-MM-DD. Exit 0 when empty.

aflt dashboard --serve [--port 8787] [--host 127.0.0.1] [--json] [--capture-completions]
# Live local activity dashboard (read-only by default). Default bind 127.0.0.1:8787.
# Blocks until SIGINT/SIGTERM. Not the same as aflt memory dashboard.
# --capture-completions opts into redacted Task Complete status notes in memory.

aflt dashboard --snapshot <file.svg|html>
# Standalone SVG or self-contained HTML snapshot of the activity graph (no server).

aflt memory | aflt memory where [--json]
# Resolved memory repo path + source (env|config), or hint to run init (exit 1).

aflt memory init <path> [--force] [--json]
# Create/register a local project-memory git repo (never remote, never commit).
# Writes README/.gitignore/.aflt-memory.json/DOC-AGENT.md when missing; sets config memoryRepo.

aflt memory sync [<project>...] [--all] [--include-adhoc] [--dry-run] [--json] [--no-redact]
 [--active-days N] [--commit] [--push]
# Write <repo>/<project>/_aflt/timeline.md + sessions.jsonl (registry read-only), then
# regenerate root DASHBOARD.md (complete Active/Dormant table for all memory-repo +
# registry projects — a one-project sync does not wipe other rows). Sessions
# (open/idle/total): open=running only; Herdr-exited active → idle. Legacy af→aflt.
# Default: cwd / AFLT_PROJECT. --all skips adhoc unless --include-adhoc or named.
# Human README/dashboard.md/status-notes created only if missing; never overwritten.
# Redaction ON for generated files. --active-days N (ET calendar days; default 14;
# else config.json memoryActiveDays; flag > config > 14). Doc-bot summary block in
# DASHBOARD.md is preserved verbatim when markers exist.
# --commit: stage DASHBOARD.md + */_aflt/** and commit ("memory: sync YYYY-MM-DD");
# refuses if the index already has staged changes; never stages human README /
# per-project dashboard.md / status-notes. --commit --dry-run is an error. --push
# requires --commit; pushes to @{u} when a commit was made or the branch is ahead
# (never force / never add remotes). Nightly: aflt memory sync --all --commit --push.

aflt memory dashboard [--dry-run] [--json] [--no-redact] [--active-days N]
# Regenerate root DASHBOARD.md only (no per-project _aflt/ writes). Same dry-run /
# json / redact / active-days semantics as sync.

aflt memory doc [--engine cursor|copilot] [--dry-run] [--json] [--force]
# Launch a portable Doc Bot `aflt run` session (title doc-bot) in the memory
# repo using DOC-AGENT.md as the prompt. Works with Cursor CLI or Copilot CLI.
# --dry-run does not create a session or start an engine.

aflt memory status [--json]
# Read-only: repo + git dirty count + per-project folder/lastSync/sessions/stale.

aflt sync [--dry-run] [--json]
# Persist last-known Herdr runtime evidence (does not change status/lastUsed)
```

`aflt timeline` is read-only. Default project: `<project>` arg → `AFLT_PROJECT` → cwd's derived project. Text shows local times (JSON keeps ISO UTC). Commits come from each session's own cwd (`commitsReason`: `not-git` / `missing-cwd`); an open-ended row that is not a live run is bounded at `lastUsed` (`open-ended` when it never ran).

`aflt dashboard` is a separate top-level command from `aflt memory dashboard`. It serves a local activity UI (`--serve`, default `127.0.0.1:8787`) or writes an SVG/HTML snapshot (`--snapshot`). Background refreshes never mutate the registry or Herdr; memory writes require `--capture-completions`. Explicitly double-clicking an agent node in the live local UI focuses its uniquely live labeled terminal in the open Herdr app and raises the window. It never resumes or launches agents; errors appear in the sidebar. Snapshots cannot focus Herdr. The graph keeps node positions across SSE ticks and cools the force layout until it settles (reheat on node add/remove or resize). Stats `open` / `idle` / `done` / `failed` follow display-state (running vs idle), not bare registry `active`.

Session activity is separate from lifecycle: green spinning ring = working,
blue = completed, amber dashed ring / `?` = awaiting input. Herdr `done`
indicates a completed turn, not an input request. Completion survives a following
idle signal but clears on new work or a new send; send grace suppresses stale
completion. Headless workers use live pid / worker state. Spinners respect
reduced motion. Counts and registry lifecycle are unchanged.

Long session-node labels use the first nine and last six ID characters
(e.g. `pla-funne...29c501`); the full ID remains in popups and actions. Session popups contain
only activity state, session ID, engine, saved lifecycle status, and Herdr
runtime status. Project popups show only the Doc Bot summary. A 450 ms rollout
grace period lets the pointer enter a popup to select/copy text; hovered popup
content and position stay stable across live updates. Empty graph clicks and
Escape immediately dismiss popups, including focused or pending hints.

Native Copilot `session.task_complete` summaries appear in session/project
details. `aflt dashboard --serve --capture-completions` opts
into writing each successful event to a dated project `status-notes/` file in
the configured memory repo. Existing events are backfilled, then new events are
captured on refresh. `_aflt/task-completions/` holds generated receipts: never
hand-edit them. They prevent duplicates, including after a note is archived.
Capture redacts sensitive values, never overwrites human notes, never changes
registry/Herdr state, and never commits, pushes or automatically runs Doc Bot.
Failures are visible in the dashboard. Default serving and all snapshots stay
read-only; do not use `--capture-completions` with `--snapshot`. Messages require
actual successful native events, not just an idle or completed runtime signal.

`aflt memory doc` creates a `doc-bot` session in project `aflt-memory`.
It also recognizes legacy `memory-doc` sessions to avoid duplicates; use
`aflt rename memory-doc doc-bot` to rename an existing session without changing
its ID or chat history. If both names exist, `doc-bot` takes precedence.

`aflt memory` is opt-in and never auto-syncs. Resolution: `AFLT_MEMORY_REPO` → `config.json` `memoryRepo`. Optional `--commit` / `--push` on `sync` stages root `DASHBOARD.md` and `*/_aflt/**` (human files stay unstaged). Layout: root `DASHBOARD.md` is generated (Active/Dormant; default 14-day ET window via `--active-days` / `memoryActiveDays`; doc-bot summary markers preserved verbatim); `<repo>/<project>/_aflt/` is generated (never hand-edit); `<project>/README.md`, `dashboard.md`, `status-notes/` are human/Doc Bot files that aflt creates only if missing and never commits (never write `DASHBOARD.md` inside a project folder — that name is root-only). Redaction (default on) covers generated files only: home → `~`, private IPs, `*.local`, emails, token-like strings, long hex/base64 (not the preserved doc-bot block). `adhoc` (home/tmp one-offs) is excluded from `--all` unless `--include-adhoc`. Nightly flow on the Mini: `aflt memory sync --all --commit --push` (commits `memory: sync YYYY-MM-DD` only when something changed; exits non-zero if push fails or there is no upstream), then optionally `aflt memory doc` to update the Doc Bot summary in `DASHBOARD.md` (separate commit, only when instructed). `DOC-AGENT.md` in the memory repo is the portable documentarian prompt; `aflt memory init` writes it when missing. `aflt memory doc --engine copilot` is the same role on a work laptop that has Copilot CLI instead of Cursor.

With a configured memory repo, the live dashboard's **Project status & docs**
selector shows each project's Doc Bot progress/blockers and opens its README,
project dashboard, and ten latest dated live status notes as read-only Markdown
(redacted, max 32 KiB per document). The reader renders Markdown locally with a
source-view toggle; raw HTML is escaped, images are not loaded, and relative
links can open only included documents. Selecting a graph/session node selects its
project's context. Changes appear on the existing live refresh; it does not run
sync or Doc Bot. HTML snapshots embed this reader for offline use; SVG project
tooltips include the summary and document titles. Memory-only projects are
included, and document read errors are surfaced without hiding session activity.

### Headless run and logs

```bash
aflt run "<title>" --prompt "..." [--cwd DIR] [--model X] [--engine cursor|copilot]
                   [--project NAME] [--mode ask|plan] [--force]
                   [--output-format text|json] [--timeout SEC]
                   [--messaging|--no-messaging] [--no-docs]
                   [--dry-run] [--json]
# Create or resume, capture output, exit. --mode is Cursor-only.
# If the session is role=master and exits 0, may trigger aflt docs (skip with --no-docs).

aflt log <title|id> [--path]
```

Timeout on a headless run exits **124**.

### Master / worker orchestration

```bash
aflt master --goal TEXT [--engine cursor|copilot] [--cwd DIR] [--title T] [--model X]
            [--project NAME] [--worker-engine copilot|cursor] [--headless] [--timeout SEC]
            [--force] [--messaging|--no-messaging] [--no-docs]
            [--dry-run] [--json]
# Initial prompt is templates/orchestrator.md. Default: interactive via Herdr.
# --headless uses aflt run machinery (workerStatus tracked).
# Successful headless exit may run aflt docs if the project has {"docs": true}.

aflt spawn --parent <id|title> --prompt TEXT [--engine cursor|copilot] [--cwd DIR]
           [--project NAME] [--title T] [--task TEXT] [--model X] [--timeout SEC]
           [--force] [--interactive] [--detach]
           [--messaging|--no-messaging] [--dry-run] [--json]
# Headless by default. --interactive launches via Herdr.
# --detach (headless only): return immediately; a supervisor records exit/handoff.
# Messaging-enabled masters pass messaging:true to workers unless --no-messaging.
# Workers inherit the master's project unless --project is set.

aflt children [<id|title>] [--json] [--all]
# No arg: resolve master from AGENTFLEET_ID / AGENTFLEET_PARENT, or summarize all masters.
# --all includes lifecycle-done masters in the summary.

aflt wait [<id|title>...] [--parent <master>] [--any] [--timeout SEC] [--interval SEC]
          [--send-grace SEC] [--docs] [--json]
# Block until listed workers reach done|failed|stopped|waiting.
# Explicit ids/titles win over --parent. No ids: --parent children, else
# children of AGENTFLEET_ID (master) or AGENTFLEET_PARENT.
# --docs: after exit 0, run aflt docs once for the master's project (errors if no master).

aflt result <id|title> [--path] [--json] [--require-fresh]
# Print the worker handoff file. If missing: stderr note + last ~40 lines of the run log; exit 1.
# --require-fresh exits 1 if the file is stale (mtime not after runStartedAt / resultMtimeAtStart).

aflt tail <id|title> [-n N] [-f]
# Last N lines of the run log (or hc read for live Herdr). -f follows until the worker leaves running.

aflt send <id|title> "text" [--timeout SEC] [--force] [--json]
# Interactive: hc send (records lastSendAt; workerStatus=running).
# Headless (not running): continue the same chat with a short handoff reminder.
# Refuses if a headless runPid is still live.

aflt stop <id|title> | aflt stop --all-children <master> [--json]
# SIGTERM process group / hc interrupt+kill.
# Exact id/title preferred. TTY + fuzzy candidates → confirm/pick; agents use exact ids.
```

`workerStatus`: `queued` | `running` | `waiting` | `done` | `failed` | `stopped`.

`aflt wait` exit precedence: timeout → failed/stopped → waiting → ok.

HANDOFF column on listings: `yes` / `af` (af-fallback from stdout) / `stale` / `no`.

### Resume, adopt, cwd

```bash
aflt resume <title|id> [--via herdr|plain] [--here] [--open|--no-open]
                       [--prompt "..."] [--force] [--dry-run] [--no-herdr-app]
# Default: Herdr when hc is on PATH (prints Attach: hc attach <name>).
# Shell-only live tab (agent stopped after reboot/--keep): relaunches into that tab
# via hc send (no new terminal). --here / --via plain: this terminal.
# --open: new iTerm2 tab running hc attach (default in an iTerm TTY; --no-open disables).
# --force: Copilot --allow-all-tools only (Cursor unchanged).
# --no-herdr-app: skip herdr.space / herdr.tab labels.

aflt resume | aflt resume -i | aflt pick     # TTY multi-select; resume via Herdr

aflt resume --all [--tag T] [--via tmux|iterm2|wezterm|herdr|plain]
                  [--open|--no-open] [--force] [--dry-run] [--no-herdr-app]

aflt adopt <title|id ...> | aflt adopt --all [--dry-run] [--json]
# Move live af Herdr panes into session-group spaces (park→label→keep when needed),
# then rename space (group title) and tab (session title). App must be open to move panes.

aflt cwd <title|id> [path] [--dry-run] [--json]
aflt set-cwd <title|id> [path] [--dry-run] [--json]   # alias
# Show or change a session's folder. Path must exist; refreshes branch.
```

### Remove and metadata

```bash
aflt rm <title|id> [<title|id>...] [--keep-files] [--force] [--dry-run]
# Exact id/title preferred; TTY may confirm/pick fuzzy matches (agents: use exact ids).
# Multiple ids: resolve all first; cancel/fail before removing any. Removes the session
# and af-owned files under $AGENTFLEET_HOME (results/, runs/<id>/, plans/).
# --keep-files: registry row only (keeps handoffs/logs).
# Refuses if running unless --force (does not stop the process).

aflt rm --children <master> [--with-master] [--keep-files] [--force] [--dry-run]
# Master resolution matches rm/stop (TTY picker when no exact match). --with-master
# also removes the master.

aflt rename <title|id> "<new title>"
aflt note <title|id> "<text>"
aflt done <title|id>                  # set lifecycle status to done
aflt export [file]                    # registry JSON (default: stdout)
aflt import-file <file>               # merge sessions from a backup
```

### Engine default

New-session precedence: **`--engine` → `AGENTFLEET_ENGINE` → `~/.agentfleet/config.json` `defaultEngine` → builtin `cursor`**. Existing sessions always keep their recorded `engine`.

```bash
aflt engine                 # print default + source
aflt engine cursor|copilot  # persist defaultEngine
aflt cursor | aflt copilot  # aliases
```

### Messaging (opt-in)

Off by default. Enable with `aflt msg enable <session>`, `--messaging` on `new`/`run`/`master`/`spawn`, or project `.agentfleet.json` `{"messaging": true}` (ancestor walk to the git root). Session `messaging: false` overrides the project. Messaging-enabled masters pass `messaging: true` to workers unless `--no-messaging`. Team = master; workers use `parent`. No role/parent → no team.

```bash
aflt msg <to> <text...> [--type T] [--reply <msgId>] [--from S] [--json] [--dry-run]
# With --reply and no <to>, defaults to= the reply sender.
# Types: question | answer | note (default) | blocked
# Special destinations include a master id and all-siblings (from a worker).

aflt msg enable|disable <session> [--json] [--dry-run]

aflt inbox [<session>] [--unread] [--mark-read] [--json]
# Default session: AGENTFLEET_SESSION / AGENTFLEET_ID; or pass a master id.

aflt thread <msgId|master> [--json]
```

Limits: `AGENTFLEET_MSG_MAX_THREAD` (default 6), `AGENTFLEET_MSG_RATE` (default 10 per 60s).

From a non-af shell you must pass `--from <session>`. Inside an af-launched session, identity comes from `AGENTFLEET_SESSION` / `AGENTFLEET_ID`.

### MCP server

```bash
aflt mcp
# Stdio MCP server. Tools (post_message, read_inbox, list_team) are advertised
# only when messaging is enabled for the inherited identity. Server name: af.

aflt mcp install --engine copilot|cursor [--write] [--project] [--cwd DIR]
                 [--dry-run] [--json]
# Print or merge MCP config (backs up first).
# Copilot + --write → ~/.copilot/mcp-config.json
# Cursor + --write → ~/.cursor/mcp.json (user)
# Cursor + --project → <cwd>/.cursor/mcp.json  (preferred)
```

Typical agent/project setup:

```bash
aflt mcp install --engine copilot                 # preview
aflt mcp install --engine copilot --write         # merge user Copilot config
aflt mcp install --engine cursor --project --cwd "$PWD"
```

Cursor install writes `"${env:AGENTFLEET_SESSION}"` (and related) so `cursor-agent` forwards identity into the MCP child (Cursor does not inherit process env into MCP servers). Messaging-enabled Copilot runs get `--additional-mcp-config` + `--allow-tool=af` per launch (no `~/.copilot` write on launch). Cursor launches get `--approve-mcps` when an `af` server is present in project/user `mcp.json`. If an older Cursor `af` entry lacks the `${env:…}` mapping, re-run install (`aflt doctor` flags `mcp_cursor`).

### Documentarian (opt-in)

Off by default. Enable with `.agentfleet.json` `{"docs": true}`.

```bash
aflt docs [<project dir>] [--since <commit>] [--engine cursor|copilot] [--model X]
          [--force|--no-force] [--anyway] [--dry-run] [--json]
aflt docs --status [--json] [--all] [<dir>...]
```

- One headless worker (`role=docs`, title `docs-<folder>`, reused). Template: `templates/documentarian.md`.
- Force/write is **on by default** (Cursor `--force` / Copilot `--allow-all-tools`); opt out with `--no-force` or `{"docsForce": false}`.
- `--anyway` runs once without enabling docs in config.
- Updates **only** configured docs paths. Warns on non-doc edits (including a new `CHANGELOG.md` when not allowed); does not revert.
- Optional `.agentfleet.json` `docsInstructions`: file path(s) (string or array; `~` / repo-relative / absolute) injected into the prompt as project-specific instructions; edit restriction still applies. Missing/unreadable files warn + skip; size caps apply. Dry-run/`--json` report used and skipped files.
- Prompt may include a compact **Session timeline since last docs run** (same builder as `aflt timeline`, cap ~8KB with `[truncated]` marker). Dry-run/`--json` report `timelineBytes` (0 when skipped).
- **`aflt docs --status`:** read-only status (no engine, no registry/state writes). Default cwd; `--all` adds distinct registry project dirs. Reports `needsDocs` (`docsEnabled && (no lastRun || commitsSince>0 || unknown lastCommit)`); also `skip` / `skipReason` / `skipFiles` and `ready`. **Doc Bot rule:** skip repos with uncommitted docs edits — any dirty `docsPaths` file (`.DS_Store` ignored) sets `skip: true`, `skipReason: "dirty-docs"`; `needsDocs` is unchanged. Only run `aflt docs` on projects where `ready` (`needsDocs && !skip`) is true. `aflt docs` itself does not check this. Exit 0 even when `needsDocs` is true.
- Auto-runs once after a successful headless master (`aflt master --headless` or `aflt run` on `role=master`) when docs are enabled; skip with `--no-docs`. Docs failure → WARNING + JSON `docs:{ok:false}` but the master exit stays 0. `aflt wait --docs` is the same after wait exit 0, and **errors** if no master can be resolved. Guard: `docsTriggeredRunId` (once per master run).

### Doctor and Herdr helpers

```bash
aflt doctor [--json]                 # read-only environment checks
aflt which-backend                   # auto-detected resume --all backend
aflt herdr-templates [--force] [--dry-run]
# Install only Cursor/Copilot/OpenCode Herdr templates into ~/.config/herdr-core/templates
# (DOC-AGENT.md, documentarian.md, orchestrator.md stay in the package for aflt)

aflt herdr-app install [--copy] [--force] [--dry-run]
# Symlink (default) or copy the af-sessions panel + af layout into
# ~/.config/herdr-app (or $HERDR_APP_HOME)

aflt herdr-app status
```

---

## Engines, permissions, and handoffs

| | Cursor | Copilot |
|---|--------|---------|
| Binary | `cursor-agent` / `agent` (`AGENTFLEET_CURSOR_BIN`) | `copilot` (`AGENTFLEET_COPILOT_BIN`) |
| Session id | `create-chat` UUID; resume `--resume` | Local UUID; `--session-id=` (create-or-resume; do **not** use `--resume=` for a fresh id) |
| Workspace | `--workspace` / `--trust` (default on; `--no-trust` keeps the dialog) | `-C <cwd>` |
| Headless | `-p`, `--output-format`, `--mode ask\|plan`, `--force` | `-p`, `--output-format`; `--force` → `--allow-all-tools` |
| Interactive `--force` | Unchanged for Cursor on `new`/`resume` | `--allow-all-tools` |
| Import | Scan `~/.cursor/chats/` | `~/.copilot/session-state/` (`AGENTFLEET_COPILOT_HOME` / `COPILOT_HOME`) |
| Completion signal (interactive) | No OSC 7501 — `aflt wait` cannot detect turn-complete while the engine is live | OSC 7501 via Herdr (`idle` / `working` / `done` / `blocked` / `error`) |

OpenCode is a **Herdr template only** (`aflt herdr-templates`); it is not wrapped by `aflt run`.

**Handoffs:** workers should write `$AGENTFLEET_RESULT` (default `$AGENTFLEET_HOME/results/<id>.md`) with Summary, Files changed, and Open questions. After a successful **headless** run, if the file is missing or stale, `aflt` may write an **af-fallback** from stdout. There is no automatic fallback for interactive runs. Freshness: the file is fresh iff it exists and `mtime` is after `runStartedAt` or `resultMtimeAtStart`. `aflt result --require-fresh` exits 1 if stale.

**Copilot write grant without `--force`:** `aflt` passes `--add-dir` for results/plans and pre-approves the handoff/plan via `--allow-tool=write(…)`. New folders may still show a trust prompt — `aflt send <id> "1"`.

**Cursor `--force`:** allows tool/command approval. Workspace trust is `--trust` (passed by default). Without `--force`, Cursor may not write the handoff; `aflt` will fall back from final stdout on headless success.

Cost hint from the orchestrator template: Copilot for routine/mechanical work; Cursor for hard or multi-file reasoning. Max 2 retries per task on failure, with a better prompt.

Engine × mode details (liveness, `aflt wait` outcomes, shell-only tabs): [docs/CAPABILITIES.md](docs/CAPABILITIES.md).

---

## Registry and configuration

Home: **`$AGENTFLEET_HOME`** (default `~/.agentfleet`). Override the registry file with **`AGENTFLEET_REGISTRY`**.

| Path | Role |
|------|------|
| `sessions.json` | Atomic registry (temp + rename; cross-process `.lock` for RMW). Mode `0600`. |
| `config.json` | Fleet defaults (`defaultEngine`, optional `memoryRepo`, `project`) |
| `runs/<id>/` | Captured headless stdout |
| `results/` | Worker/master handoffs (`$AGENTFLEET_RESULT`) |
| `plans/` | Master plans (`$AGENTFLEET_PLAN`) |
| `messages/<masterId>.jsonl` | Team message log |
| `docs/<hash>.json` | Documentarian since-tracking (`lastCommit`) |

Each session stores identity (`id`, `title`, `chatId`, `cwd`, `branch`, `model`, `engine`), optional `project`, lifecycle `status` (`active` | `paused` | `done`), `tags` / `notes` / `prompt`, optional `herdr` evidence from `aflt sync`, and orchestration fields (`parent`, `role`, `task`, `result`, `workerStatus`, run pid metadata, `messaging`, …).

**Project name (`session.project`):** optional string for grouping. **Projects never require git** — one-off agents in `/tmp` or `$HOME` can share a name. Legacy alias map (`lib/project.js` `PROJECT_ALIASES` / `canonicalProjectName`): `af` → `aflt` for grouping, live dashboard hubs, and memory sync/dashboard folders (registry `project` is not rewritten; existing `af/` memory folders are left alone).

**New sessions** store the resolved name (`--project` on `new`/`add`/`run`/`master`/`spawn`/import). Precedence: `--project` → parent/master project → `AFLT_PROJECT` → `.agentfleet.json` `"project"` → `$AGENTFLEET_HOME/config.json` `"project"` → git-root basename → cwd basename, except `$HOME` / `os.tmpdir()` (+ realpath) / `/tmp` / `/private/tmp` → `"adhoc"`. Workers inherit the master's project (unless `--project` overrides); docs sessions inherit when triggered from a master (and set `parent` when that path runs).

**Existing rows** without `project`: derive at read time with cwd-based rules only (`.agentfleet.json` → git basename → cwd basename/`adhoc`) — never env/global config, and never rewrite the registry to backfill. Helper: `lib/project.js` (git-root lookups cached per command; missing cwd must not throw).

### Project: `.agentfleet.json`

Resolved by walking cwd → ancestors until the git root (or filesystem root).

```json
{
  "project": "my-app",
  "messaging": true,
  "docs": true,
  "docsPaths": ["README.md", "docs/"],
  "docsInstructions": ["docs/DOCS_STYLE.md"],
  "docsEngine": "cursor",
  "docsForce": false
}
```

| Key | Meaning |
|-----|---------|
| `project` | optional display/group name for sessions in this repo (stored on new rows when `--project` is omitted) |
| `messaging` | `true` to opt in for sessions in this project (session `messaging: false` wins) |
| `docs` | `true` to enable the documentarian |
| `docsPaths` | default `README.md` + `docs/` (+ `CHANGELOG.md` only if it already exists) |
| `docsInstructions` | optional file path(s) injected into the documentarian prompt (`~` / repo-relative / absolute; still only edit `docsPaths`) |
| `docsEngine` | `cursor` \| `copilot` |
| `docsForce` | `false` to opt out of the default write grant |

### Fleet: `~/.agentfleet/config.json`

```json
{ "defaultEngine": "cursor", "project": "ops", "memoryRepo": "/path/to/aflt-memory", "memoryActiveDays": 14 }
```

Optional `"project"` is a create-time default when `--project` / `AFLT_PROJECT` / `.agentfleet.json` are unset (useful for non-repo agent groups). Optional `"memoryRepo"` comes from `aflt memory init` (override with `AFLT_MEMORY_REPO`). Optional `"memoryActiveDays"` sets the Active/Dormant threshold for root `DASHBOARD.md` (positive integer; overridden by `--active-days`; default 14).

---

## Herdr integration

Requires **herdr-core** (`hc` on PATH or `AGENTFLEET_HC_BIN`) and optionally the **Herdr desktop app**.

- Interactive launches (`aflt new`, `aflt resume`, `aflt master`, `aflt spawn --interactive`) default to Herdr when `hc` is on PATH.
- Labels: `af_id=<id>`, `title=…`, and (by default) `--keep` + `herdr.space` / `herdr.tab` so the app shows one **space per session group** (workers join the master) and one **tab per session**. Renames set Agents list titles. Opt out of labels: `--no-herdr-app` or `AGENTFLEET_HERDR_APP=0`. Skip renames only: `AGENTFLEET_HERDR_NAMES=0`.
- **`aflt adopt`** moves already-live panes into the right space. The app should be open to move panes.
- After reboot, `--keep` terminals come back as a login shell (`HERDR=shell`). `aflt resume` relaunches the engine **into the existing tab**. Prefer herdr-core ≥ 0.1.20 (`aflt doctor` warns when older). Shell-only (live tab, agent stopped) is `workerStatus=stopped` for `aflt wait` (exit 1) — fix with `aflt resume <id>`.
- Panel: `aflt herdr-app install` then `herdr-app do layout.switch --name af`. Panel clicks focus / adopt / resume.
- `resume --all` backends: `tmux` | `iterm2` (macOS) | `wezterm` | `herdr` | `plain`. Auto-detect: `AGENTFLEET_VIA` → inside Herdr → tmux → `TERM_PROGRAM` → … → plain. `aflt which-backend` prints the choice.

---

## Environment variables

Set by the caller or the environment:

| Variable | Purpose |
|----------|---------|
| `AGENTFLEET_HOME` | Registry dir (default `~/.agentfleet`) |
| `AGENTFLEET_REGISTRY` | Override `sessions.json` path |
| `AGENTFLEET_ENGINE` | Default engine for **new** sessions |
| `AFLT_PROJECT` | Default project name for **new** sessions (after `--project` / parent; before `.agentfleet.json` / config.json / basename). Projects need no git. |
| `AFLT_MEMORY_REPO` | Override project-memory repo path (else `config.json` `memoryRepo` from `aflt memory init`) |
| `AGENTFLEET_CURSOR_BIN` | Override `cursor-agent` |
| `AGENTFLEET_COPILOT_BIN` | Override `copilot` |
| `AGENTFLEET_COPILOT_HOME` | Copilot home for import (else `COPILOT_HOME` / `~/.copilot`) |
| `AGENTFLEET_VIA` | Default `--via` / single-resume herdr vs plain |
| `AGENTFLEET_TMUX_SESSION` | tmux session name (default `agentfleet`) |
| `AGENTFLEET_HERDR_APP` | `0/false/off/no` → skip space/tab labels |
| `AGENTFLEET_HERDR_APP_BIN` | Override `herdr-app` |
| `AGENTFLEET_HC_BIN` | Override `hc` (default: `hc` on PATH / `~/.local/bin/hc`) |
| `AGENTFLEET_HERDR_APP_WAIT_MS` | Max ms wait for space/rename (default 5000) |
| `AGENTFLEET_HERDR_NAMES` | `0/false/off/no` → skip rename (labels still applied) |
| `HERDR_APP_HOME` | Herdr app config dir (default `~/.config/herdr-app`) |
| `AGENTFLEET_SEND_GRACE` | `aflt wait` grace after send (default 15s) |
| `AGENTFLEET_MSG_MAX_THREAD` / `AGENTFLEET_MSG_RATE` | Messaging limits (defaults 6 / 10 per 60s) |

Injected on launch (do not overwrite casually inside a session):

| Variable | Purpose |
|----------|---------|
| `AGENTFLEET_ID` | This session's af id (also used by `aflt children`) |
| `AGENTFLEET_SESSION` | Same as `AGENTFLEET_ID` (messaging / MCP identity) |
| `AGENTFLEET_MASTER` | Team master id when known |
| `AGENTFLEET_PARENT` | Set on spawned workers (master af id) |
| `AGENTFLEET_RESULT` | Handoff or summary path |
| `AGENTFLEET_PLAN` | Master plan under `$AGENTFLEET_HOME/plans/` |
| `AGENTFLEET_ROLE` | `master` or `docs` when launched via those commands |

`CURSOR_API_KEY` is a headless Cursor auth alternative to `agent login`. Never print it.

---

## Further reading

- [README.md](README.md) — product overview and command summary
- [docs/CAPABILITIES.md](docs/CAPABILITIES.md) — engine × mode matrix and `aflt wait` outcomes
- [docs/SETUP.md](docs/SETUP.md) — environment setup, Herdr, work-computer install, troubleshooting
- `aflt help` — authoritative flag list
- `templates/orchestrator.md` / `templates/documentarian.md` — prompts injected for master and docs workers
