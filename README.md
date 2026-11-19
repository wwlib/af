<p align="center">
  <img src="assets/logo.png" alt="aflt / AgentFleet" width="112" height="112"/>
</p>

<p align="center"><strong>aflt</strong> / AgentFleet — track, resume, and orchestrate Cursor &amp; Copilot CLI agents</p>

<p align="center">
  <img alt="Node 18+" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js&logoColor=white"/>
  <img alt="version 1.2.0" src="https://img.shields.io/badge/version-1.2.0-blue"/>
  <img alt="396 tests passing, 1 skipped" src="https://img.shields.io/badge/tests-396%20passing%20%7C%201%20skipped-success"/>
  <img alt="macOS | Linux untested" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20untested-lightgrey"/>
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-yellow"/>
</p>

`aflt` is the main command; `af` and `agentfleet` are aliases that run the same CLI.

**For AI agents:** [AGENTS.md](AGENTS.md) — install, commands, engines, and how to delegate or orchestrate work from Cursor or Copilot CLI.

Zero npm runtime dependencies beyond **Node ≥18**. Install once (`npm i -g .`) to get `aflt` plus the aliases `af` and `agentfleet`. Engine × mode behavior (liveness, completion, handoffs, `aflt wait`): [docs/CAPABILITIES.md](docs/CAPABILITIES.md). Setup deep-dive: [docs/SETUP.md](docs/SETUP.md).

## Why AgentFleet

CLI coding agents are powerful but ephemeral: chat IDs live in engine-local stores, terminals die on reboot, and a controller (script, bot, master agent) cannot babysit a TUI. **AgentFleet** (`aflt`) keeps a small local registry under `~/.agentfleet`, resumes the right engine argv into Herdr/tmux/iTerm/WezTerm (or plain), runs headless one-shots that capture output, and can orchestrate a **master → workers** fleet with wait/result/send/stop, optional task messaging, and an optional documentarian pass.

## Features at a glance

| Area | What you get |
|------|----------------|
| **Registry** | Atomic `sessions.json`; runs/, results/, plans/, messages/, docs/ under `$AGENTFLEET_HOME` |
| **Engines** | Cursor CLI (`cursor-agent` / `agent`) and GitHub Copilot CLI; precedence `--engine` → `AGENTFLEET_ENGINE` → `config.json` → `cursor` |
| **Modes** | Interactive TUI (Herdr by default when `hc` is on PATH) vs headless `aflt run` / spawn |
| **Herdr** | `hc` terminals + desktop app spaces/tabs + bundled `af-sessions` panel; shell-only reboot recovery via in-tab relaunch |
| **Orchestration** | `aflt master`, `aflt spawn [--detach]`, `children`, `wait`, `result [--require-fresh]`, `tail`, `send`, `stop`, `rm --children` |
| **Projects** | Optional `session.project` + `aflt ls --project` / `aflt timeline` (read-only session tree + commits) |
| **Live dashboard** | `aflt dashboard --serve` / `--snapshot` — local read-only activity graph (not `aflt memory dashboard`) |
| **Memory** | Opt-in `aflt memory` repo: sync per-project timelines + root `DASHBOARD.md` into a local git working tree; optional `--commit`/`--push` for generated `_aflt/` + root `DASHBOARD.md` |
| **Messaging** | Opt-in `aflt msg` / `inbox` / `thread` + stdio MCP (`aflt mcp`) for Copilot & Cursor |
| **Documentarian** | Opt-in `aflt docs`; auto once after headless master / `aflt wait --docs` |
| **Ops** | `aflt import`, `aflt doctor`, `--json` / `--dry-run` on mutating paths |

## Architecture

<p align="center">
  <img src="assets/architecture.png" alt="aflt architecture: controller → aflt CLI → registry, engines, Herdr, orchestration, opt-in messaging and docs" width="900"/>
</p>

### Master → workers flow

<p align="center">
  <img src="assets/orchestration.png" alt="aflt master to workers orchestration: spawn, wait, result, optional messaging and docs" width="900"/>
</p>

## Install

```bash
# Node 18+
cd aflt   # this repo
npm install -g .
# Primary binary: aflt  (also installs aliases af + agentfleet)
# or without global install:
#   npm link
#   ln -s "$(pwd)/bin/af.js" ~/.local/bin/aflt
# Optional aliases:
#   ln -s ~/.local/bin/aflt ~/.local/bin/af
#   alias aflt='node /path/to/aflt/bin/af.js'

# Cursor CLI (required for --engine cursor)
curl https://cursor.com/install -fsS | bash   # agent / cursor-agent on PATH

# Optional: Copilot CLI, Herdr (hc + herdr-app), bash completion
# npm install -g @github/copilot
source /path/to/aflt/completions/af.bash   # completes aflt, af, and agentfleet
```

```bash
aflt doctor          # read-only: node, home, hc, engines, MCP hints
aflt doctor --json
```

## Quick start

```bash
# Interactive tracked session (create-chat / mint UUID → register → launch)
aflt new "auth-refactor" --cwd ~/src/app-wt-auth --prompt "Refactor auth to JWT"

# Default engine for NEW sessions
aflt engine                 # print + source (flag/env/config/builtin)
aflt cursor                 # or: aflt copilot / aflt engine copilot

# Headless one-shot (create or resume; capture to ~/.agentfleet/runs/)
aflt run "auth-refactor" --prompt "Summarize the current branch" --mode ask --cwd ~/src/app-wt-auth
aflt log auth-refactor

# List / resume
aflt ls
aflt resume auth-refactor          # Herdr when hc on PATH; Attach: hc attach <name>
aflt resume                        # or aflt pick — TTY multi-select
aflt resume --all --via herdr      # fleet reopen after reboot

# Master + detached workers
aflt master --goal "Split auth into helpers + tests" --cwd ~/src/app --headless --force
aflt spawn --parent <master> --prompt "…" --detach
aflt wait --parent <master>
aflt result <worker-id>
```

---

## Sessions & registry

Home directory: **`$AGENTFLEET_HOME`** (default `~/.agentfleet`). Override registry file with **`AGENTFLEET_REGISTRY`**.

| Path | Role |
|------|------|
| `sessions.json` | Atomic registry (temp + rename; cross-process `.lock` for RMW) |
| `config.json` | Fleet defaults (`defaultEngine`, optional `memoryRepo`, `project`) |
| `runs/<id>/` | Captured headless stdout |
| `results/` | Worker/master handoffs (`$AGENTFLEET_RESULT`) |
| `plans/` | Master plans (`$AGENTFLEET_PLAN`) |
| `messages/<masterId>.jsonl` | Team message log |
| `docs/<hash>.json` | Documentarian since-tracking |

Each session stores identity (`id`, `title`, `chatId`, `cwd`, `branch`, `model`, `engine`), optional `project`, lifecycle `status` (`active`\|`paused`\|`done`), `tags` / `notes` / `prompt`, optional `herdr` evidence from `aflt sync`, and orchestration fields (`parent`, `role`, `task`, `result`, `workerStatus`, run pid metadata, `messaging`, …).

**Project name:** projects need **no git**. New sessions store: `--project` → parent → `AFLT_PROJECT` → `.agentfleet.json` `"project"` → `config.json` `"project"` → git basename → cwd basename (`adhoc` for `$HOME`/`tmpdir`/`/tmp`). Existing rows without `project`: derive at read with cwd rules only (never env/global; never rewrite the registry). Workers inherit the master's project. Legacy alias: stored project `af` groups/displays/syncs as `aflt` (registry value unchanged).

**STATUS vs HERDR on `aflt ls`:** STATUS is saved lifecycle (a process exit does **not** mark the task done — use `aflt done`). HERDR is live runtime from `hc ls --all --json`: `running` \| `shell` \| `exited` \| `missing` \| `unknown` \| `-`. `aflt ls --json` includes effective `project` + `parent`. `aflt ls` never writes the registry; `aflt sync` persists `herdr` evidence without changing `status` / `lastUsed`. `aflt timeline` is read-only (no registry/Herdr writes).

## Session lifecycle commands

| Command | Purpose |
|---------|---------|
| `aflt new` | Create engine session → register → interactive launch |
| `aflt add` | Register an existing chat / Copilot UUID |
| `aflt ls` / `aflt sync` | List (optional `--project`); persist Herdr evidence |
| `aflt timeline` | Read-only project session tree (+ best-effort commits) |
| `aflt dashboard` | Live local activity UI (`--serve`) or SVG/HTML snapshot (`--snapshot`); read-only; not `aflt memory dashboard` |
| `aflt memory` | Opt-in project-memory git repo (`init` / `sync --commit --push` / `dashboard` / `doc` / `status` / `where`) |
| `aflt run` / `aflt log` | Headless create-or-resume; print last capture |
| `aflt resume` / `aflt pick` | Resume one, interactive pick, or `--all` |
| `aflt rename` / `aflt note` / `aflt done` | Metadata |
| `aflt cwd` / `aflt set-cwd` | Show or change folder (refreshes branch; live tab not moved) |
| `aflt rm` | Drop registry row(s) + af-owned files under `$AGENTFLEET_HOME` (exact id/title; TTY fuzzy pick; multi-arg) |
| `aflt export` / `aflt import-file` | Backup / merge registry JSON |

<details>
<summary><code>aflt new</code> / <code>aflt add</code> / <code>aflt resume</code> / <code>aflt run</code> options</summary>

- **`aflt new "<title>"`** — `--cwd` `--prompt` `--model` `--engine cursor|copilot` `--project` `--force` `--messaging|--no-messaging` `--tag` `--dry-run` (plus Cursor `--no-trust` where applicable)
- **`aflt add "<title>" --chat <id>`** — `--cwd` `--model` `--engine` `--project` `--tag` `--prompt`
- **`aflt run`** — `--prompt` (required) `--cwd` `--model` `--engine` `--project` `--mode ask|plan` (Cursor) `--force` `--output-format text|json` `--timeout` `--messaging|--no-messaging` `--no-docs` `--dry-run` `--json`
- **`aflt timeline [<project>]`** — `--all` `--json` `--since <date>` (ISO or YYYY-MM-DD); read-only. Default project: `<project>` arg → `AFLT_PROJECT` → cwd's derived project. Text shows local times (JSON keeps ISO UTC). Commits come from each session's own cwd (`commitsReason`: `not-git` / `missing-cwd`); an open-ended row that is not a live run is bounded at `lastUsed` (`open-ended` when it never ran).
- **`aflt dashboard`** — local live activity dashboard (read-only by default; completion capture is opt-in). `aflt dashboard --serve [--port 8787] [--host 127.0.0.1] [--json]` binds only the requested host (default `127.0.0.1:8787`) and serves a graph UI with SSE updates; Ctrl-C to stop. Graph node positions persist across SSE refreshes and the force layout settles (reheats only when nodes are added/removed or on resize). Stats: **open** = live/running only (Herdr `running`/`shell` or live `runPid`); registry-`active` sessions that are Herdr-`exited`/`missing` count as **idle**, not open — registry `status` is unchanged. Legacy project name `af` groups under `aflt`. `aflt dashboard --snapshot <file.svg|html>` writes a standalone SVG or self-contained HTML snapshot (no server). Separate from **`aflt memory dashboard`**, which regenerates the memory repo's root `DASHBOARD.md`.
- **`aflt memory`** — opt-in project memory (local git repo). `init <path>` registers `memoryRepo` in config (or override with `AFLT_MEMORY_REPO`). `sync [<project>…]` writes `<repo>/<project>/_aflt/timeline.md` + `sessions.jsonl`, then regenerates root `DASHBOARD.md` (complete Active/Dormant table for all memory-repo + registry projects; default 14-day ET window via `--active-days` / config `memoryActiveDays`). `Sessions (open/idle/total)` uses the same open/idle rules as the live dashboard (Herdr-exited → idle). Legacy project `af` aliases to `aflt` for folder selection and rows (registry `project` left as `af`; existing `af/` human folders are not deleted). `aflt memory dashboard` regenerates `DASHBOARD.md` only. Default sync target: cwd/`AFLT_PROJECT`; `--all` skips `adhoc` unless `--include-adhoc`. Redaction ON by default for generated files (home → `~`; private IPs, `*.local` hosts, emails, token-like strings, long hex/base64 → `[redacted]`; `--no-redact` to disable; doc-bot summary block in `DASHBOARD.md` is preserved verbatim and not redacted). Output is deterministic and only rewritten on change, so a repeat sync changes nothing. Human files (`<project>/README.md`, `dashboard.md`, `status-notes/`) are created only if missing and never overwritten or committed by aflt (never write `DASHBOARD.md` inside a project folder); to map a repo to a differently named memory folder, set `"project"` in its `.agentfleet.json`. Optional `--commit` stages root `DASHBOARD.md` + `*/_aflt/**` (refuses dirty index; no `--dry-run`); `--push` requires `--commit` and pushes to `@{u}` when a commit was made or the branch is ahead. Nightly: `aflt memory sync --all --commit --push`, then (optionally) `aflt memory doc` to fill the Doc Bot summary (separate commit, only when instructed). `aflt memory doc [--engine cursor|copilot]` launches an `aflt run` session titled `doc-bot` in the memory repo with `DOC-AGENT.md` as the prompt, so the same role works on a Cursor CLI machine or a Copilot CLI laptop. `status` / `where` are read-only.
- **`aflt resume <title|id>`** — `--via herdr|plain` `--here` `--open|--no-open` `--prompt` `--force` `--dry-run` `--no-herdr-app`
- **`aflt resume --all`** — `--tag` `--via tmux|iterm2|wezterm|herdr|plain` `--open|--no-open` `--force` `--dry-run` `--no-herdr-app`
- **`aflt rm`** — exact id/title preferred (multi-arg); TTY confirms/picks fuzzy matches (agents: exact only); `--keep-files` `--force` `--dry-run`; or `--children <master> [--with-master]`

</details>

### Project status and docs in the live dashboard

When a memory repo is configured, **Project status & docs** lets you select a
project (or click its graph/session node) to see Doc Bot's recorded progress
and blockers from the root `DASHBOARD.md` summary table. Open the project's
`README.md`, `dashboard.md`, or ten latest dated `status-notes/*.md` in the
read-only rendered Markdown reader, with a **View source** toggle. Headings,
lists, tables, links, and fenced code blocks render locally using bundled
[Marked](https://marked.js.org/) (MIT); no CDN or npm runtime dependency is
required. Raw HTML is escaped and images are shown as text without loading
external content. Relative links open only documents already included in the
preview; web links open separately. Archived notes are excluded. Documents refresh with
live state updates; no sync or Doc Bot run is triggered. Previews redact
sensitive values, are limited to 32 KiB each, and never follow filesystem links outside
the memory repo. Missing summaries and read errors are shown explicitly.
HTML snapshots include the offline reader and embedded documents; SVG
snapshots include Doc Bot summaries in project tooltips.
The HTML dashboard supports light/dark system themes (`?scoutTheme=light` or
`?scoutTheme=dark` to override).
Solid graph links show the session hierarchy: projects connect to root sessions,
and parents connect directly to their workers, without duplicate project links.
Sessions whose parent is absent connect to their project instead.
Long session-node labels use the first nine and last six ID characters
(for example, `pla-funne...29c501`); popups retain the full ID. Their popups show only the activity
state, session ID, engine, saved lifecycle status, and Herdr runtime status;
project popups show only the Doc Bot summary. Popups remain visible briefly
after leaving a node so you can move into them to select and copy text. They stay
steady while hovered, then dismiss after rollout. Click empty graph space or
press Escape to dismiss any popup immediately.
Double-click any agent node (any color) in the live local dashboard to select its
existing terminal in Herdr and raise the app. Single-click still shows details.
Herdr must already be open, with one live terminal labeled for that session;
unavailable or ambiguous terminals produce a visible sidebar error. This never
resumes, launches, or sends input to an agent. Offline snapshots cannot focus Herdr.
Working sessions show a green spinning ring; completed work turns blue.
Sessions awaiting input show an amber circle, dashed ring, and `?` badge.
Hover/details identify each state. Herdr's explicit turn-complete signal means
completed, not an input request; completion remains visible through idle until
new work or a new prompt. Live headless workers also show working/completed states.
Detection uses confirmed runtime signals and aflt's worker state, not ordinary
inactivity; engines without those signals cannot reliably expose input prompts.
Spinners respect reduced-motion preferences. Existing open/session counts and
lifecycle status are unchanged.

The latest native Copilot **Task Complete** message is rendered as Markdown in
session/project details. Earlier completions
remain historical messages when new work starts; they do not mark the new work
complete. HTML snapshots include these messages without writing notes.

To automatically save completion messages for the Doc Bot while the live
dashboard runs:

```bash
aflt dashboard --serve --capture-completions
```

This opt-in mode requires a configured memory repo. It backfills successful
`session.task_complete` events from registered Copilot sessions, then captures
new events on the live refresh. Each message becomes a redacted
`<project>/status-notes/YYYY-MM-DDTHHMMSS-task-complete-<id>.md` note.
Generated receipts under `<project>/_aflt/task-completions/` prevent duplicates
across restarts and preserve decisions to archive older notes. Human files are
never overwritten; capture errors appear in the dashboard. The Doc Bot reads
these notes on its next pass; capture does not launch it, commit, push, or
change session lifecycle. Other engines, or turns without a native Task Complete
event, do not get an invented completion message. Without this flag the
dashboard remains read-only.

## Engines (Cursor + Copilot)

**New-session precedence:** `--engine` → `AGENTFLEET_ENGINE` → `$AGENTFLEET_HOME/config.json` `defaultEngine` → builtin **`cursor`**. Existing sessions always keep their recorded `engine`.

```bash
aflt engine                  # print current default + source
aflt engine copilot          # persist defaultEngine
aflt cursor / aflt copilot     # aliases
```

| | Cursor | Copilot |
|---|--------|---------|
| Binary | `cursor-agent` / `agent` (`AGENTFLEET_CURSOR_BIN`) | `copilot` (`AGENTFLEET_COPILOT_BIN`) |
| Session id | `create-chat` UUID; resume `--resume` | Local UUID; `--session-id=` (create-or-resume; do not use `--resume=` for a fresh id) |
| Workspace | `--workspace` / `--trust` (default on; `--no-trust` to keep dialog) | `-C <cwd>` |
| Headless | `-p`, `--output-format`, `--mode ask|plan`, `--force` | `-p`, `--output-format`; `--force` → `--allow-all-tools` |
| Interactive `--force` | Unchanged for Cursor on `new`/`resume` | `--allow-all-tools` |
| Import | Scan `~/.cursor/chats/` | `~/.copilot/session-state/` (`AGENTFLEET_COPILOT_HOME` / `COPILOT_HOME`) |

OpenCode is a **Herdr template only** (`aflt herdr-templates`); not wrapped by `aflt run`.

## Headless vs interactive

- **Interactive** — `aflt new`, `aflt resume`, `aflt master` (default), `aflt spawn --interactive`: TUI in Herdr (default when `hc` on PATH) or this terminal (`--here` / `--via plain`).
- **Headless** — `aflt run`, `aflt spawn` (default), `aflt master --headless`, `aflt docs`: print-mode, capture to `runs/`, exit with engine code (124 on `--timeout`). Do **not** send `aflt run` through Herdr.

Stdout = agent output; stderr = progress + `output: <path>`. Exit **75** = critical registry write failed after a run (result still printed; `--json` includes `registryWriteError`).

## Herdr integration

Requires **herdr-core** (`hc` on PATH or `AGENTFLEET_HC_BIN`) and optionally the **Herdr desktop app**.

- **Labels:** launches add `af_id=<id>`, `title=…`, and (by default) `--keep` + `herdr.space` / `herdr.tab` so the app shows one **space per session group** (workers join the master) and one **tab per session**. Renames set Agents list titles (`space.rename` / `tab.rename`). Opt out: `--no-herdr-app` or `AGENTFLEET_HERDR_APP=0`; skip renames only: `AGENTFLEET_HERDR_NAMES=0`.
- **`aflt adopt`** — move already-live panes into the right space (park → label → keep when needed), then rename. App should be open to move panes.
- **`aflt cwd`** — updates registry folder/branch; does not move a live tab — resume (and optionally adopt) after.
- **Shell status / reboot:** `--keep` terminals restore as a login shell (`HERDR=shell`). `aflt resume` relaunches the engine **into the existing tab** via `hc send` (`cd '<cwd>' && env … <engine>`), without a new terminal. Prefer herdr-core ≥ 0.1.20 (`aflt doctor` warns when older).
- **Panel:** `aflt herdr-app install` symlinks (or `--copy`) `herdr/mods/af-sessions` + `herdr/layouts/af.json` into `~/.config/herdr-app` (`HERDR_APP_HOME`). Switch layout: `herdr-app do layout.switch --name af`. Panel clicks focus / adopt / resume.
- **Templates:** `aflt herdr-templates` installs only the Cursor, Copilot, and OpenCode Herdr templates into `~/.config/herdr-core/templates`. Package files `DOC-AGENT.md`, `documentarian.md`, and `orchestrator.md` stay in `templates/` for aflt itself and are not installed.
- **Backends for `resume --all`:** `tmux` | `iterm2` (macOS) | `wezterm` | `herdr` | `plain`. Auto-detect: `AGENTFLEET_VIA` → inside Herdr → tmux → `TERM_PROGRAM` → … → plain. `aflt which-backend` prints the choice.

## Master / worker orchestration

```bash
aflt master --goal "…" [--engine …] [--worker-engine …] [--headless] [--messaging] [--no-docs] …
aflt spawn --parent <master> --prompt "…" [--detach] [--interactive] [--engine …] …
aflt children [<master>] [--json] [--all]
aflt wait [<workers>…] [--parent <master>] [--any] [--timeout] [--interval] [--send-grace] [--docs] [--json]
aflt result <worker> [--path] [--json] [--require-fresh]
aflt tail <worker> [-n N] [-f]
aflt send <id> "text" [--timeout] [--force] [--json]
aflt stop <id> | aflt stop --all-children <master>
aflt rm --children <master> [--with-master] …
```

- **`workerStatus`:** `queued` \| `running` \| `waiting` \| `done` \| `failed` \| `stopped`
- **`aflt wait` exits:** `0` all done · `1` failed/stopped · `2` timeout · `3` waiting (needs input). Precedence: timeout → failed/stopped → waiting → ok. See [CAPABILITIES.md](docs/CAPABILITIES.md) for Cursor (no OSC 7501) vs Copilot interactive waiting.
- **`--detach`:** headless only; returns immediately; supervisor records exit/handoff. Prefer over shell `&`.
- **Handoffs:** workers write `$AGENTFLEET_RESULT` (default `$AGENTFLEET_HOME/results/<id>.md`). Headless success with missing/stale file → **af-fallback** from stdout. Freshness uses `runStartedAt` / `resultMtimeAtStart`; `aflt result --require-fresh` exits 1 if stale. HANDOFF column: `yes` / `af` / `stale` / `no`.
- **Env on launch:** `AGENTFLEET_ID` always; workers `AGENTFLEET_PARENT` / `AGENTFLEET_RESULT`; masters `AGENTFLEET_ROLE=master` / `AGENTFLEET_PLAN` / `AGENTFLEET_RESULT`. Messaging also sets `AGENTFLEET_SESSION` (= id) and `AGENTFLEET_MASTER` when known.

## Messaging

**Off by default.** Enable with `aflt msg enable <session>`, `--messaging` on `new`/`run`/`master`/`spawn`, or project `.agentfleet.json` `{"messaging": true}` (ancestor walk to git root). Session `messaging: false` overrides project. Messaging-enabled masters pass `messaging: true` to workers unless `--no-messaging`. Team = master; workers use `parent`. No role/parent → no team.

```bash
aflt msg enable auth-master
aflt msg master "blocked on schema" --type blocked --from auth-w1
aflt msg all-siblings "FYI" --from auth-w1
aflt msg --reply <msgId> "ack" --from auth-master
aflt inbox [--unread] [--mark-read] [--json]
aflt thread <msgId|master> [--json]
```

- **Types:** `question` \| `answer` \| `note` (default) \| `blocked`
- **Limits:** `AGENTFLEET_MSG_MAX_THREAD` (default 6), `AGENTFLEET_MSG_RATE` (default 10 / 60s)
- **MCP:** `aflt mcp` exposes `post_message`, `read_inbox`, `list_team` when messaging is enabled for the inherited identity.
  - **Copilot:** per-run `--additional-mcp-config` + `--allow-tool=af` (no `~/.copilot` write on launch)
  - **Cursor:** install into project/user `mcp.json`; launches get `--approve-mcps` when an `af` server is present; install writes `${env:AGENTFLEET_SESSION}` etc. for identity forwarding

```bash
aflt mcp install --engine copilot [--write]
aflt mcp install --engine cursor --project   # <cwd>/.cursor/mcp.json
aflt mcp install --engine cursor --write     # ~/.cursor/mcp.json
```

## Documentarian

**Off by default.** Opt in: `.agentfleet.json` `{"docs": true}`.

| Key | Meaning |
|-----|---------|
| `docs` | `true` to enable |
| `docsPaths` | default `README.md` + `docs/` (+ `CHANGELOG.md` only if it already exists) |
| `docsInstructions` | optional file path(s) (string or array; `~` / repo-relative / absolute) whose contents are injected into the documentarian prompt; still only edit `docsPaths` |
| `docsEngine` | `cursor` \| `copilot` |
| `docsForce` | `false` to opt out of default write grant |

```bash
aflt docs [<project dir>] [--since <commit>] [--engine …] [--model …]
        [--force|--no-force] [--anyway] [--dry-run] [--json]
aflt docs --status [--json] [--all] [<dir>...]
```

- One headless worker (`role=docs`, title `docs-<folder>`, reused). Template: `templates/documentarian.md`.
- Force/write **ON by default** (Cursor `--force` / Copilot `--allow-all-tools`); opt out `--no-force` or `docsForce: false`.
- Snapshots the tree; **warns** on non-doc edits (including disallowed new `CHANGELOG.md`); does not revert.
- State: `$AGENTFLEET_HOME/docs/<hash>.json` (`lastCommit`).
- **`docsInstructions`:** readable files are injected as a “Project-specific documentation instructions” section (per-file / total size caps; missing files warn + skip). Dry-run / `--json` list used and skipped paths.
- **Session timeline:** prompt may include a compact “Session timeline since last docs run” (same as `aflt timeline`, ~8KB cap). Dry-run / `--json` report `timelineBytes` (0 when skipped).
- **`--status`:** read-only (no engine, no writes). Per project: `docsEnabled`, `docsPaths`, `docsInstructions`, `lastRun`, `commitsSince`, `dirtyDocs`, `needsDocs`, `skip` / `skipReason` / `skipFiles`, `ready`. **Doc Bot rule:** skip any repo with uncommitted docs edits — if a `docsPaths` file is dirty (`.DS_Store` ignored), status sets `skip: true`, `skipReason: "dirty-docs"`, and lists the files. `needsDocs` is unchanged; act only on `ready` (`needsDocs && !skip`). `aflt docs` itself does not enforce this. Exit 0 even when `needsDocs` is true. `--all` adds distinct registry project dirs.
- **Auto-trigger:** after successful headless master (`aflt master --headless` or `aflt run` on `role=master`) when docs enabled; skip `--no-docs`. Docs failure → WARNING + JSON `docs:{ok:false}` but master exit 0. `aflt wait --docs` same after wait exit 0; **errors** if no master. Guard: `docsTriggeredRunId` (once per master run). `--anyway` runs once without enabling in config.

## Import

```bash
aflt import                          # default engine path (cursor → ~/.cursor/chats)
aflt import cursor                   # always Cursor store
aflt import copilot                  # list ~/.copilot/session-state
aflt import copilot <uuid|prefix>…   # register; --title (single id), --tag, --cwd, --limit,
                                   # --json, --all, --dry-run, --allow-missing, -i|--pick
```

## Doctor, JSON, dry-run

- **`aflt doctor [--json]`** — read-only checks: node, home, registry, default engine, `hc`, engines, MCP wiring hints.
- **`--json`** — machine-readable stdout on supporting commands (single JSON object where applicable).
- **`--dry-run`** — plan only; no registry/state mutation (new, run, spawn, master, docs, msg enable, adopt, cwd, rm, sync, herdr-*, mcp install, …).

## Configuration

### Project: `.agentfleet.json`

```json
{
  "project": "my-app",
  "messaging": true,
  "docs": true,
  "docsPaths": ["README.md", "docs/"],
  "docsInstructions": ["docs/DOCS_STYLE.md", "~/notes/af-docs.md"],
  "docsEngine": "cursor",
  "docsForce": false
}
```

Resolved by walking cwd → ancestors until the git root (or filesystem root). Optional `"project"` names the group for `aflt ls --project` / `aflt timeline` when `--project` / `AFLT_PROJECT` are omitted on create.

### Fleet: `~/.agentfleet/config.json`

```json
{ "defaultEngine": "cursor", "project": "ops", "memoryRepo": "/path/to/aflt-memory", "memoryActiveDays": 14 }
```

Optional `"project"` is a create-time default for non-repo agent groups (after `AFLT_PROJECT`, before basename/`adhoc`). Optional `"memoryRepo"` is set by `aflt memory init` (override with `AFLT_MEMORY_REPO`). Optional `"memoryActiveDays"` sets the Active/Dormant threshold for root `DASHBOARD.md` (overridden by `--active-days`; default 14).

### Environment

| Variable | Purpose |
|----------|---------|
| `AGENTFLEET_HOME` | Registry dir (default `~/.agentfleet`) |
| `AGENTFLEET_REGISTRY` | Override `sessions.json` path |
| `AGENTFLEET_ENGINE` | Default engine for **new** sessions |
| `AFLT_PROJECT` | Default project for **new** sessions (after `--project` / parent; before `.agentfleet.json` / config / basename). No git required. |
| `AFLT_MEMORY_REPO` | Override project-memory repo path (else `config.json` `memoryRepo`) |
| `AGENTFLEET_CURSOR_BIN` | Override `cursor-agent` |
| `AGENTFLEET_COPILOT_BIN` | Override `copilot` |
| `AGENTFLEET_COPILOT_HOME` | Copilot home for import (else `COPILOT_HOME` / `~/.copilot`) |
| `AGENTFLEET_VIA` | Default `--via` / single-resume herdr vs plain |
| `AGENTFLEET_TMUX_SESSION` | tmux session name (default `agentfleet`) |
| `AGENTFLEET_HERDR_APP` | `0/false/off/no` → skip space/tab labels |
| `AGENTFLEET_HERDR_APP_BIN` | Override `herdr-app` |
| `AGENTFLEET_HC_BIN` | Override `hc` |
| `AGENTFLEET_HERDR_APP_WAIT_MS` | Max ms wait for space/rename (default 5000) |
| `AGENTFLEET_HERDR_NAMES` | `0/false/off/no` → skip rename (labels still applied) |
| `HERDR_APP_HOME` | Herdr app config dir (default `~/.config/herdr-app`) |
| `AGENTFLEET_ID` / `SESSION` / `MASTER` / `PARENT` | Set on launched sessions |
| `AGENTFLEET_RESULT` / `PLAN` / `ROLE` | Handoff / plan / role on workers & masters |
| `AGENTFLEET_SEND_GRACE` | `aflt wait` grace after send (default 15s) |
| `AGENTFLEET_MSG_MAX_THREAD` / `MSG_RATE` | Messaging limits (defaults 6 / 10 per 60s) |

---

## Command reference

<details>
<summary>All commands (purpose)</summary>

| Command | Purpose |
|---------|---------|
| `aflt new` | Create + register + interactive launch |
| `aflt add` | Register existing chat / Copilot UUID |
| `aflt import` / `aflt import-file` | Discover local sessions / merge backup |
| `aflt ls` / `aflt sync` | List sessions / persist Herdr evidence |
| `aflt timeline` | Read-only project session tree |
| `aflt dashboard` | Live local activity UI (`--serve`) or SVG/HTML snapshot (read-only; ≠ memory dashboard) |
| `aflt memory` | Opt-in project-memory repo (init / sync / dashboard / doc / status; sync `--commit`/`--push`) |
| `aflt run` / `aflt log` | Headless prompt / last capture |
| `aflt spawn` / `aflt master` | Worker under master / bootstrap orchestrator |
| `aflt children` | List workers or summarize masters |
| `aflt wait` | Block until workers terminal |
| `aflt result` / `aflt tail` | Handoff file / run log follow |
| `aflt send` / `aflt stop` | Continue chat or stop workers |
| `aflt docs` | Documentarian worker |
| `aflt msg` / `inbox` / `thread` | Task-scoped messaging |
| `aflt mcp` / `aflt mcp install` | Stdio MCP server / merge engine MCP config |
| `aflt resume` / `aflt pick` | Resume one, pick, or `--all` |
| `aflt adopt` | Label/move live Herdr panes into session spaces |
| `aflt cwd` / `aflt set-cwd` | Show or change session folder |
| `aflt cursor` / `aflt copilot` / `aflt engine` | Default engine get/set |
| `aflt rename` / `aflt done` / `aflt note` | Metadata |
| `aflt rm` | Remove session(s) by exact id/title or TTY fuzzy pick (+ af-owned files) |
| `aflt export` | Write registry JSON |
| `aflt which-backend` | Show auto-detected `resume --all` backend |
| `aflt herdr-templates` | Install Cursor/Copilot/OpenCode hc templates only |
| `aflt herdr-app install` / `status` | Install/report af-sessions panel + layout |
| `aflt doctor` | Read-only environment checks |
| `aflt help` | This usage text |

Exit codes (global): `0` ok · `1` error · `2` wait timeout · `3` waiting · `75` critical registry write after run.

</details>

<details>
<summary>Full <code>af --help</code> usage sketch</summary>

See `af --help` / `aflt help` for the authoritative flag list. Long-form help covers every command above including messaging MCP install paths, wait grace, docs force defaults, and the full `AGENTFLEET_*` environment block.

</details>

## More docs

- [AGENTS.md](AGENTS.md) — guide for AI coding agents (Copilot CLI, Cursor, orchestrators)
- [docs/CAPABILITIES.md](docs/CAPABILITIES.md) — engine × mode capability matrix and `aflt wait` outcomes
- [docs/SETUP.md](docs/SETUP.md) — environment setup, Herdr, troubleshooting
- [completions/af.bash](completions/af.bash) — bash completion
- [herdr/mods/af-sessions](herdr/mods/af-sessions) — Herdr desktop panel mod (`RECIPE.md`)
- [herdr/layouts/af.json](herdr/layouts/af.json) — layout that includes the panel

## Tests

```bash
npm test
```

412 tests (Node test runner): all passing in the hermetic suite (a live `create-chat` smoke test only runs with a real `cursor-agent`). Coverage includes registry, engines, Herdr backends, orchestration, messaging, MCP, docs, project/timeline, project memory, live dashboard, dry-run purity, interactive rm/stop pickers, and hermetic `AGENTFLEET_HOME` fixtures.

## License

[MIT](LICENSE) © 2026 Andrew Rapo.

## Caveats

- `cursor-agent ls` is interactive-only; Cursor import scans `~/.cursor/chats/`.
- Empty chats from `create-chat` may not appear on disk until a prompt is sent.
- Resume with the **same cwd/workspace** the chat was created in.
- Primary development target is **macOS**. Linux is untested here; `tmux` / `plain` resume backends are portable, while iTerm2 / WezTerm / Herdr desktop are macOS-oriented.
- No first-class Zellij backend beyond `--via plain`.
- Cursor does not emit OSC 7501 — interactive `aflt wait` cannot detect turn-complete for Cursor (timeout or terminal exit).
