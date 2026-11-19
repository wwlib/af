'use strict';

/**
 * Live activity dashboard — read-only by default, optional completion-note capture.
 * Separate from `aflt memory dashboard` (memory-repo DASHBOARD.md).
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { URL } = require('url');
const displayStateLib = require('./display-state');
const herdr = require('./herdr');
const herdrapp = require('./herdrapp');
const memory = require('./memory');
const orchestrate = require('./orchestrate');
const projectLib = require('./project');
const registry = require('./registry');
const taskCompletions = require('./task-completions');
const { registryPath, nowIso, expandUserPath } = require('./util');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DASHBOARD_TZ = 'America/New_York';
const RECENT_MS = 5 * 60 * 1000;
const ACTIVE_PROJECT_MS = 24 * 60 * 60 * 1000;
const SSE_INTERVAL_MS = 3000;
const REGISTRY_POLL_MS = 2000;
const EVENTS_MAX = 40;
const MEMORY_DOCUMENT_BYTES = 32 * 1024;
const MEMORY_STATUS_NOTES = 10;
const ASSET_DIR = path.join(__dirname, '..', 'templates', 'dashboard');

const DISPLAY_STATES = new Set(['running', 'idle', 'done', 'failed']);
const execFileAsync = promisify(execFile);

function sessionNodeLabel(id) {
  const value = String(id);
  return value.length > 18 ? value.slice(0, 9) + '...' + value.slice(-6) : value;
}

async function focusHerdrSession(session, opts = {}) {
  const fetched = (opts.fetchHerdrTerminals || herdr.fetchHerdrTerminals)({ timeoutMs: 3000 });
  if (!fetched.ok) throw new Error(fetched.error || 'Unable to query Herdr terminals.');
  const terminal = herdr.classifySession(session, fetched.terminals);
  if (!['running', 'shell'].includes(terminal.runtime) || !terminal.address) {
    throw new Error('No unique live Herdr terminal is available for this session. Resume it in Herdr first.');
  }
  const app = herdrapp.resolveHerdrAppBin();
  const runApp = opts.runApp || ((args) => execFileAsync(app, args, { timeout: 5000, maxBuffer: 64 * 1024 }));
  try {
    const result = await runApp(['do', 'agent.focus', '--terminal', terminal.address]);
    const reply = JSON.parse(result.stdout);
    if (!reply || reply.ok !== true) throw new Error(String(reply?.error || 'Herdr did not confirm the focus action.'));
  } catch (err) {
    throw new Error(`Unable to focus the Herdr terminal. Check that the Herdr app is open. ${String(err.stderr || err.message).trim()}`);
  }
  const raiseApp = opts.raiseApp || (() => new Promise((resolve, reject) => {
    const child = spawn(app, [], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  }));
  try {
    await raiseApp();
  } catch (err) {
    throw new Error(`The terminal was selected, but the Herdr window could not be opened: ${err.message}`);
  }
  return { sessionId: session.id, address: terminal.address };
}

/**
 * Format a timestamp for the snapshot header in America/New_York (ET).
 * Host TZ independent. Returns "" if the input is not a valid date.
 * Example: 2026-11-16T00:52:17.000Z → "2026-11-15 19:52:17 ET"
 * @param {string|number|Date} input
 * @param {string} [timeZone]
 * @returns {string}
 */
function formatSnapshotStamp(input, timeZone = DASHBOARD_TZ) {
  const d = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (type) => {
    const part = parts.find((p) => p.type === type);
    return part ? part.value : '';
  };
  const pad = (value) => String(value).padStart(2, '0');
  return `${get('year')}-${pad(get('month'))}-${pad(get('day'))} ${pad(get('hour'))}:${pad(get('minute'))}:${pad(get('second'))} ET`;
}

function parseTimeMs(iso) {
  if (iso == null || iso === '') return null;
  const t = Date.parse(String(iso));
  return Number.isFinite(t) ? t : null;
}

const deriveDisplayState = displayStateLib.deriveDisplayState;
const enrichmentForSession = displayStateLib.enrichmentForSession;

function sessionInputState(session, enrichment, previous = {}, now = Date.now()) {
  const checkpoint = {
    lastSendAt: session.lastSendAt || null,
    runStartedAt: session.runStartedAt || null,
  };
  const reset = { seenWorking: false, idleTicks: 0, working: false, completed: false };
  if (session.status === 'done' || session.status === 'paused') {
    return { ...checkpoint, ...reset, awaitingInput: false };
  }
  const runtime = enrichment && enrichment.runtime;
  if (runtime === 'running') {
    const sameRun = previous.lastSendAt === checkpoint.lastSendAt &&
      previous.runStartedAt === checkpoint.runStartedAt;
    const agentState = orchestrate.agentStateFromHerdr(enrichment);
    const transition = orchestrate.detectWaitingTransition({
      ...(sameRun ? previous : reset),
      agentState,
      lastSendAt: checkpoint.lastSendAt,
      sendGraceMs: orchestrate.resolveSendGraceMs(),
      now,
    });
    const completed = transition.hint === 'waiting' &&
      (agentState === 'done' || (agentState === 'idle' && sameRun && previous.completed === true));
    return {
      ...checkpoint, ...transition,
      working: agentState === 'working', completed,
      awaitingInput: !completed && transition.hint === 'waiting',
    };
  }
  return {
    ...checkpoint, ...reset,
    awaitingInput: !['shell', 'exited', 'missing'].includes(runtime) && session.workerStatus === 'waiting',
  };
}

/**
 * Preserve force-sim positions across SSE state updates.
 * Pure: merges mutable fields onto existing nodes; marks whether the node-id set changed
 * (caller should reheat / rebuild layout only when `nodeSetChanged` is true).
 *
 * @param {{ nodes?: object[], links?: object[], w?: number, h?: number, cx?: number, cy?: number, alpha?: number }|null} prevSim
 * @param {{ nodes: object[], links: object[], w: number, h: number, cx: number, cy: number }} nextBuilt
 * @param {{ reheatAlpha?: number, preserveAlpha?: boolean }} [opts]
 * @returns {{ nodes: object[], links: object[], w: number, h: number, cx: number, cy: number, alpha: number, nodeSetChanged: boolean }}
 */
function mergeSimPreserve(prevSim, nextBuilt, opts = {}) {
  const nextNodes = Array.isArray(nextBuilt && nextBuilt.nodes) ? nextBuilt.nodes : [];
  const nextLinks = Array.isArray(nextBuilt && nextBuilt.links) ? nextBuilt.links : [];
  const prevNodes = prevSim && Array.isArray(prevSim.nodes) ? prevSim.nodes : [];
  const prevById = new Map();
  for (const n of prevNodes) {
    if (n && n.id != null) prevById.set(n.id, n);
  }
  const prevIds = new Set(prevById.keys());
  const nextIds = new Set(nextNodes.map((n) => n && n.id).filter((id) => id != null));
  let nodeSetChanged = prevIds.size !== nextIds.size;
  if (!nodeSetChanged) {
    for (const id of nextIds) {
      if (!prevIds.has(id)) {
        nodeSetChanged = true;
        break;
      }
    }
  }

  const nodes = nextNodes.map((n) => {
    const prev = prevById.get(n.id);
    if (!prev) return n;
    return {
      ...n,
      x: prev.x,
      y: prev.y,
      vx: prev.vx != null ? prev.vx : 0,
      vy: prev.vy != null ? prev.vy : 0,
      fixed: prev.fixed != null ? prev.fixed : n.fixed,
    };
  });

  const byId = new Map();
  for (const n of nodes) byId.set(n.id, n);
  const links = nextLinks
    .map((l) => {
      const source = typeof l.source === 'object' && l.source ? l.source : byId.get(l.source);
      const target = typeof l.target === 'object' && l.target ? l.target : byId.get(l.target);
      // Prefer merged node objects when link already holds object refs from a rebuild
      const src = source && source.id != null && byId.has(source.id) ? byId.get(source.id) : source;
      const tgt = target && target.id != null && byId.has(target.id) ? byId.get(target.id) : target;
      if (!src || !tgt) return null;
      return {
        source: src,
        target: tgt,
        kind: l.kind,
        recent: l.recent,
      };
    })
    .filter(Boolean);

  let alpha;
  if (opts.preserveAlpha && prevSim && typeof prevSim.alpha === 'number' && !nodeSetChanged) {
    alpha = prevSim.alpha;
  } else if (nodeSetChanged || !prevSim) {
    alpha = opts.reheatAlpha != null ? opts.reheatAlpha : 1;
  } else {
    alpha = typeof prevSim.alpha === 'number' ? prevSim.alpha : 1;
  }

  return {
    nodes,
    links,
    w: nextBuilt.w,
    h: nextBuilt.h,
    cx: nextBuilt.cx,
    cy: nextBuilt.cy,
    alpha,
    nodeSetChanged,
  };
}

function sessionActivityMs(session) {
  const times = [
    parseTimeMs(session && session.lastUsed),
    parseTimeMs(session && session.lastRunAt),
    parseTimeMs(session && session.created),
  ].filter((t) => t != null);
  return times.length ? Math.max(...times) : null;
}

function memoryRecordActivityMs(rec) {
  const times = [
    parseTimeMs(rec && rec.lastUsed),
    parseTimeMs(rec && rec.end),
    parseTimeMs(rec && rec.start),
  ].filter((t) => t != null);
  return times.length ? Math.max(...times) : null;
}

function bucketIndex(ms, startMs, bucketMs, count) {
  if (ms == null || !Number.isFinite(ms)) return -1;
  const i = Math.floor((ms - startMs) / bucketMs);
  if (i < 0 || i >= count) return -1;
  return i;
}

function buildSparkline(timestamps, nowMs, windowMs, buckets) {
  const series = new Array(buckets).fill(0);
  const startMs = nowMs - windowMs;
  const bucketMs = windowMs / buckets;
  for (const ms of timestamps) {
    const i = bucketIndex(ms, startMs, bucketMs, buckets);
    if (i >= 0) series[i] += 1;
  }
  return series;
}

function pushEvent(events, ev) {
  if (!ev || !ev.at) return;
  events.push(ev);
}

/**
 * Pure aggregation. Does not read HOME / registry / Herdr.
 *
 * @param {{
 *   sessions?: object[],
 *   memoryRecords?: object[],
 *   memoryProjects?: object[],
 *   memoryErrors?: string[],
 *   memoryConfigured?: boolean,
 *   enrichmentById?: Record<string, object>,
 *   sessionActivityById?: Record<string, object>,
 *   completionsById?: Record<string, object>,
 *   completionErrors?: string[],
 *   captureCompletions?: boolean,
 *   now?: string|number|Date,
 *   isAlive?: (pid: number) => boolean,
 *   projectCache?: object,
 * }} input
 */
function aggregateDashboard(input = {}) {
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const memoryRecords = Array.isArray(input.memoryRecords) ? input.memoryRecords : [];
  const memoryProjects = Array.isArray(input.memoryProjects) ? input.memoryProjects : [];
  const enrichmentById = input.enrichmentById && typeof input.enrichmentById === 'object'
    ? input.enrichmentById
    : {};
  const isAlive = input.isAlive;
  const cache = input.projectCache || projectLib.createLookupCache();
  const nowDate =
    input.now instanceof Date
      ? input.now
      : input.now != null
        ? new Date(input.now)
        : new Date();
  const nowMs = nowDate.getTime();
  const generatedAt =
    typeof input.now === 'string' && Number.isFinite(Date.parse(input.now))
      ? String(input.now)
      : nowDate.toISOString();

  const byId = new Map();
  const childrenByParent = new Map();
  for (const s of sessions) {
    if (!s || !s.id) continue;
    byId.set(s.id, s);
    if (s.parent) {
      if (!childrenByParent.has(s.parent)) childrenByParent.set(s.parent, []);
      childrenByParent.get(s.parent).push(s.id);
    }
  }

  const projectMap = new Map(); // name → { name, sessions: [], displayStates, lastActivity }
  const sessionViews = [];
  const links = [];
  const activityTimes = [];
  const events = [];

  function ensureProject(name) {
    const key = name || projectLib.ADHOC_NAME;
    if (!projectMap.has(key)) {
      projectMap.set(key, {
        name: key,
        sessionIds: [],
        displayStates: [],
        lastActivity: null,
        fromMemoryOnly: true,
      });
    }
    return projectMap.get(key);
  }

  for (const s of sessions) {
    if (!s || !s.id) continue;
    const project = projectLib.resolveProjectName(s, { cache }) || projectLib.ADHOC_NAME;
    const enrichment = enrichmentForSession(s, enrichmentById);
    const displayState = deriveDisplayState(s, enrichment, { isAlive });
    const activity = input.sessionActivityById?.[s.id] || sessionInputState(s, enrichment, {}, nowMs);
    let activityState = displayState;
    if (displayState === 'done') activityState = 'completed';
    else if (displayState !== 'failed' && s.status !== 'paused') {
      if (activity.working) activityState = 'working';
      else if (activity.completed) activityState = 'completed';
      else if (activity.awaitingInput) activityState = 'waiting';
      else if (s.workerStatus === 'running' && displayStateLib.isPidAlive(s.runPid, isAlive)) {
        activityState = 'working';
      } else if (s.workerStatus === 'done' && displayState !== 'running') {
        activityState = 'completed';
      }
    }
    const awaitingInput = activityState === 'waiting';
    const activityMs = sessionActivityMs(s);
    const recent = activityMs != null && nowMs - activityMs <= RECENT_MS;
    const children = childrenByParent.get(s.id) || [];
    const completion = input.completionsById?.[s.id] || null;

    if (activityMs != null) activityTimes.push(activityMs);

    const proj = ensureProject(project);
    proj.fromMemoryOnly = false;
    proj.sessionIds.push(s.id);
    proj.displayStates.push(displayState);
    if (completion && (!proj.completion || completion.at >= proj.completion.at)) {
      proj.completion = completion;
    }
    if (activityMs != null && (proj.lastActivity == null || activityMs > proj.lastActivity)) {
      proj.lastActivity = activityMs;
    }

    sessionViews.push({
      id: s.id,
      nodeLabel: sessionNodeLabel(s.id),
      title: s.title || s.id,
      project,
      engine: s.engine || 'cursor',
      status: s.status || 'done',
      displayState,
      activityState,
      completion,
      awaitingInput,
      cwd: s.cwd || null,
      model: s.model || null,
      notes: s.notes || null,
      role: s.role || null,
      parent: s.parent || null,
      workerStatus: s.workerStatus || null,
      created: s.created || null,
      lastUsed: s.lastUsed || null,
      lastRunAt: s.lastRunAt || null,
      lastExit: s.lastExit != null ? s.lastExit : null,
      lastError: s.lastError || null,
      runPid: s.runPid != null ? s.runPid : null,
      runStartedAt: s.runStartedAt || null,
      herdr: enrichment
        ? {
            runtime: herdr.displayRuntime(enrichment.runtime),
            address: enrichment.address || null,
            name: enrichment.name || null,
            exitCode: enrichment.exitCode != null ? enrichment.exitCode : null,
            checkedAt: enrichment.checkedAt || null,
          }
        : s.herdr && typeof s.herdr === 'object'
          ? {
              runtime: herdr.displayRuntime(s.herdr.runtime),
              address: s.herdr.address || null,
              name: s.herdr.name || null,
              exitCode: s.herdr.exitCode != null ? s.herdr.exitCode : null,
              checkedAt: s.herdr.checkedAt || null,
            }
          : null,
      children,
      recent,
    });

    if (completion) {
      pushEvent(events, {
        at: completion.at, type: 'task-complete', sessionId: s.id,
        title: s.title || s.id, project, text: `Task Complete · ${s.title || s.id}`,
      });
    }
    if (s.parent && s.parent !== s.id && byId.has(s.parent)) {
      links.push({ from: s.parent, to: s.id, kind: 'parent' });
    } else {
      links.push({ from: `project:${project}`, to: s.id, kind: 'project' });
    }

    if (s.created) {
      pushEvent(events, {
        at: s.created,
        type: 'created',
        sessionId: s.id,
        title: s.title || s.id,
        project,
        text: `created · ${s.title || s.id}`,
      });
    }
    if (s.lastRunAt) {
      pushEvent(events, {
        at: s.lastRunAt,
        type: 'run',
        sessionId: s.id,
        title: s.title || s.id,
        project,
        text: `run · ${s.title || s.id}`,
      });
    }
    if (s.lastUsed && s.lastUsed !== s.created && s.lastUsed !== s.lastRunAt) {
      pushEvent(events, {
        at: s.lastUsed,
        type: 'used',
        sessionId: s.id,
        title: s.title || s.id,
        project,
        text: `active · ${s.title || s.id}`,
      });
    }
    if (displayState === 'failed' && (s.lastError || s.lastExit != null)) {
      const when = s.lastUsed || s.lastRunAt || s.created || generatedAt;
      pushEvent(events, {
        at: when,
        type: 'failed',
        sessionId: s.id,
        title: s.title || s.id,
        project,
        text:
          'failed · ' +
          (s.title || s.id) +
          (s.lastExit != null ? ' (exit ' + s.lastExit + ')' : ''),
      });
    } else if (s.status === 'done' && (s.lastUsed || s.lastRunAt)) {
      pushEvent(events, {
        at: s.lastUsed || s.lastRunAt,
        type: 'done',
        sessionId: s.id,
        title: s.title || s.id,
        project,
        text: `done · ${s.title || s.id}`,
      });
    }
  }

  for (const rec of memoryRecords) {
    if (!rec) continue;
    const project =
      projectLib.canonicalProjectName(
        (rec.project && String(rec.project).trim()) || projectLib.ADHOC_NAME
      ) || projectLib.ADHOC_NAME;
    const proj = ensureProject(project);
    const ms = memoryRecordActivityMs(rec);
    if (ms != null) {
      activityTimes.push(ms);
      if (proj.lastActivity == null || ms > proj.lastActivity) {
        proj.lastActivity = ms;
      }
    }
    if (rec.id && !byId.has(rec.id) && rec.start) {
      pushEvent(events, {
        at: rec.start,
        type: 'memory',
        sessionId: rec.id,
        title: rec.title || rec.id,
        project,
        text: `history · ${rec.title || rec.id}`,
      });
    }
  }

  for (const context of memoryProjects) {
    const project = [...projectMap.values()].find(
      (p) => memory.sanitizeFolderName(p.name) === context.folder
    ) || ensureProject(context.project);
    project.memory = context;
  }

  function projectDisplayState(states) {
    if (!states || states.length === 0) return 'done';
    if (states.includes('running')) return 'running';
    if (states.includes('failed')) return 'failed';
    if (states.includes('idle')) return 'idle';
    return 'done';
  }

  const projects = [...projectMap.values()]
    .map((p) => {
      const displayState = projectDisplayState(p.displayStates);
      const runningCount = p.displayStates.filter((d) => d === 'running').length;
      const recentlyActive =
        runningCount > 0 ||
        (p.lastActivity != null && nowMs - p.lastActivity <= ACTIVE_PROJECT_MS);
      return {
        id: `project:${p.name}`,
        name: p.name,
        displayState,
        sessionCount: p.sessionIds.length,
        runningCount,
        lastActivity: p.lastActivity != null ? new Date(p.lastActivity).toISOString() : null,
        active: recentlyActive,
        fromMemoryOnly: Boolean(p.fromMemoryOnly),
        memory: p.memory || null,
        completion: p.completion || null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const engines = { cursor: 0, copilot: 0 };
  let runningSessions = 0;
  let open = 0;
  let idle = 0;
  let done = 0;
  let failed = 0;
  for (const s of sessionViews) {
    const eng = s.engine === 'copilot' ? 'copilot' : 'cursor';
    engines[eng] += 1;
    // open = live/running only (exclude idle / Herdr-exited)
    if (s.displayState === 'running') {
      runningSessions += 1;
      open += 1;
    } else if (s.displayState === 'idle') {
      idle += 1;
    } else if (s.displayState === 'failed') {
      failed += 1;
    } else if (s.displayState === 'done') {
      done += 1;
    }
  }

  const activeProjects = projects.filter((p) => p.active).length;

  events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const trimmedEvents = events.slice(0, EVENTS_MAX);

  return {
    generatedAt,
    stats: {
      activeProjects,
      runningSessions,
      engines,
      open,
      idle,
      done,
      failed,
      sessions: sessionViews.length,
      projects: projects.length,
    },
    projects,
    sessions: sessionViews,
    links,
    sparkline24h: buildSparkline(activityTimes, nowMs, 24 * 60 * 60 * 1000, 24),
    sparkline7d: buildSparkline(activityTimes, nowMs, 7 * 24 * 60 * 60 * 1000, 7),
    events: trimmedEvents,
    completions: {
      captureEnabled: Boolean(input.captureCompletions),
      errors: input.completionErrors || [],
    },
    memory: {
      present: memoryRecords.length > 0 || memoryProjects.length > 0,
      recordCount: memoryRecords.length,
      configured: Boolean(input.memoryConfigured),
      errors: input.memoryErrors || [],
    },
  };
}

/**
 * Read optional memory per-project `_aflt/sessions.jsonl` records. Never throws.
 */
function loadMemoryRecords(memoryRepo) {
  const out = [];
  if (!memoryRepo) return out;
  let folders;
  try {
    folders = memory.listRepoProjectFolders(memoryRepo);
  } catch (_) {
    return out;
  }
  for (const folder of folders) {
    const file = path.join(memoryRepo, folder, memory.GENERATED_DIR, 'sessions.jsonl');
    let raw;
    try {
      if (!fs.existsSync(file)) continue;
      raw = fs.readFileSync(file, 'utf8');
    } catch (_) {
      continue;
    }
    for (const line of raw.split(/\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (obj && typeof obj === 'object') {
          if (!obj.project) obj.project = folder;
          out.push(obj);
        }
      } catch (_) {
        /* skip bad line */
      }
    }
  }
  return out;
}

/**
 * Read only known Markdown documents, bounded and contained within the memory repo.
 * Markdown is displayed as text, never interpreted as HTML or executable links.
 */
function loadMemoryProjects(memoryRepo) {
  const result = { projects: [], errors: [] };
  if (!memoryRepo) return result;
  let root;
  let folders;
  try {
    root = fs.realpathSync(memoryRepo);
    folders = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()))
      .map((entry) => entry.name).sort();
  } catch (err) {
    result.errors.push(`Cannot read memory repo (${err.code || err.message})`);
    return result;
  }

  function contained(relative) {
    const real = fs.realpathSync(path.join(root, relative));
    const fromRoot = path.relative(root, real);
    if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
      throw new Error('path resolves outside memory repo');
    }
    return real;
  }

  function readDocument(relative, kind, errors, limit = MEMORY_DOCUMENT_BYTES) {
    let fd;
    try {
      const real = contained(relative);
      if (!fs.statSync(real).isFile()) throw new Error('not a regular file');
      fd = fs.openSync(real, 'r');
      const buffer = Buffer.alloc(limit + 1);
      const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const content = memory.redactSensitive(buffer.subarray(0, Math.min(size, limit)).toString('utf8'));
      const heading = content.match(/^#\s+(.+?)\s*$/m);
      return {
        kind,
        path: relative.split(path.sep).join('/'),
        title: heading ? heading[1] : path.basename(relative),
        content,
        truncated: size > limit,
      };
    } catch (err) {
      if (err.code !== 'ENOENT') errors.push(`${relative}: ${err.code || err.message}`);
      return null;
    } finally {
      if (fd != null) fs.closeSync(fd);
    }
  }

  const dashboard = readDocument(memory.DASHBOARD_REL, 'summary', result.errors, 128 * 1024);
  const summaries = new Map();
  if (dashboard) {
    if (dashboard.truncated) result.errors.push('Doc Bot summary source exceeds 128 KiB; some summaries may be unavailable');
    const block = memory.extractDocBotSummaryInner(dashboard.content) || '';
    for (const line of block.split('\n')) {
      if (!line.trim().startsWith('|')) continue;
      const cells = line.trim().slice(1).replace(/\|$/, '').split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replace(/\\\|/g, '|'));
      if (cells.length !== 3 || /^:?-+:?$/.test(cells[0])) continue;
      const name = cells[0].replace(/^\[([^\]]+)\]\([^)]+\)$/, '$1').replace(/^`|`$/g, '');
      summaries.set(projectLib.canonicalProjectName(name), { moved: cells[1], blocked: cells[2] });
    }
  }

  for (const folder of folders) {
    const project = projectLib.canonicalProjectName(folder);
    if (project !== folder && folders.includes(project)) continue;
    const errors = [];
    try {
      if (!fs.statSync(contained(folder)).isDirectory()) continue;
    } catch (err) {
      result.errors.push(`${folder}: ${err.code || err.message}`);
      continue;
    }
    const documents = [];
    for (const [file, kind] of [['README.md', 'readme'], ['dashboard.md', 'dashboard']]) {
      const document = readDocument(path.join(folder, file), kind, errors);
      if (document) documents.push(document);
    }
    try {
      const notes = contained(path.join(folder, 'status-notes'));
      const names = fs.readdirSync(notes, { withFileTypes: true })
        .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) &&
          /^\d{4}-\d{2}-\d{2}.*\.md$/i.test(entry.name))
        .map((entry) => entry.name).sort().reverse();
      for (const name of names.slice(0, MEMORY_STATUS_NOTES)) {
        const document = readDocument(path.join(folder, 'status-notes', name), 'status', errors);
        if (document) documents.push({ ...document, date: name.slice(0, 10) });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') errors.push(`${folder}/status-notes: ${err.code || err.message}`);
    }
    result.projects.push({
      project,
      folder: memory.sanitizeFolderName(project),
      summary: summaries.get(project) || null,
      documents,
      errors,
    });
  }
  return result;
}

/**
 * Collect live dashboard state. Never mutates registry; note capture is opt-in.
 */
function collectState(opts = {}) {
  const cache = opts.projectCache || projectLib.createLookupCache();
  const sessions =
    opts.sessions != null
      ? opts.sessions
      : registry.list({ includeDone: true });

  const resolved =
    opts.memoryRepo != null
      ? { path: opts.memoryRepo }
      : memory.resolveMemoryRepo(opts.env || process.env);
  const memoryRepo = resolved && resolved.path;
  const completions = taskCompletions.collectTaskCompletions(sessions, {
    cache: opts.completionCache,
    memoryRepo,
    capture: Boolean(opts.captureCompletions),
    env: opts.env || process.env,
    projectCache: cache,
  });
  const memoryRecords = opts.memoryRecords != null
    ? opts.memoryRecords : loadMemoryRecords(memoryRepo);
  const context = opts.memoryProjects != null
    ? { projects: opts.memoryProjects, errors: [] } : loadMemoryProjects(memoryRepo);

  let enrichmentById = opts.enrichmentById;
  if (enrichmentById == null) {
    enrichmentById = {};
    let fetchResult = opts.herdrFetch;
    if (fetchResult == null) {
      try {
        fetchResult = herdr.fetchHerdrTerminals(opts.herdrOpts || {});
      } catch (_) {
        fetchResult = { ok: false, error: 'herdr fetch failed', terminals: [], checkedAt: nowIso() };
      }
    }
    if (fetchResult && fetchResult.ok) {
      const enriched = herdr.enrichSessions(sessions, fetchResult);
      for (const e of enriched) {
        if (e && e.session && e.session.id) {
          enrichmentById[e.session.id] = e;
        }
      }
    }
  }

  const sessionActivityById = {};
  const nowMs = opts.now != null ? new Date(opts.now).getTime() : Date.now();
  for (const session of sessions) {
    if (!session || !session.id) continue;
    const next = sessionInputState(session, enrichmentForSession(session, enrichmentById),
      opts.waitingState?.get(session.id), nowMs);
    sessionActivityById[session.id] = next;
    if (opts.waitingState) opts.waitingState.set(session.id, next);
  }
  if (opts.waitingState) {
    for (const id of opts.waitingState.keys()) {
      if (!Object.hasOwn(sessionActivityById, id)) opts.waitingState.delete(id);
    }
  }

  return aggregateDashboard({
    sessions,
    memoryRecords,
    memoryProjects: context.projects,
    memoryErrors: context.errors,
    memoryConfigured: Boolean(memoryRepo),
    enrichmentById,
    sessionActivityById,
    completionsById: completions.bySessionId,
    completionErrors: completions.errors,
    captureCompletions: opts.captureCompletions,
    now: opts.now,
    isAlive: opts.isAlive,
    projectCache: cache,
  });
}

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stateColor(displayState) {
  switch (displayState) {
    case 'working':
      return '#4ade80';
    case 'running':
      return '#2dd4bf';
    case 'waiting':
    case 'idle':
      return '#fbbf24';
    case 'completed':
      return '#4da6ff';
    case 'failed':
      return '#f87171';
    case 'done':
    default:
      return '#64748b';
  }
}

function layoutGraph(state, width, height) {
  const cx = width * 0.42;
  const cy = height * 0.5;
  const projects = state.projects || [];
  const sessions = state.sessions || [];
  const nodes = [];
  const edges = [];

  const n = Math.max(projects.length, 1);
  const hubR = Math.min(width, height) * 0.28;
  const projectPos = new Map();

  projects.forEach((p, i) => {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(angle) * hubR;
    const y = cy + Math.sin(angle) * hubR;
    projectPos.set(p.name, { x, y, angle });
    nodes.push({
      id: p.id,
      kind: 'project',
      label: p.name,
      displayState: p.displayState,
      x,
      y,
      r: 22,
    });
  });

  const byProject = new Map();
  for (const s of sessions) {
    const key = s.project || projectLib.ADHOC_NAME;
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(s);
  }

  for (const [pname, list] of byProject) {
    const hub = projectPos.get(pname) || { x: cx, y: cy, angle: 0 };
    const m = list.length;
    const orbit = 58 + Math.min(m, 8) * 4;
    list.forEach((s, i) => {
      const base = hub.angle != null ? hub.angle : 0;
      const a = base + ((i - (m - 1) / 2) * (Math.PI / Math.max(m + 1, 4)));
      const x = hub.x + Math.cos(a) * orbit;
      const y = hub.y + Math.sin(a) * orbit;
      nodes.push({
        id: s.id,
        kind: 'session',
        label: s.nodeLabel || sessionNodeLabel(s.id),
        displayState: s.displayState,
        activityState: s.activityState,
        completion: s.completion,
        awaitingInput: s.awaitingInput,
        recent: Boolean(s.recent),
        x,
        y,
        r: 9,
      });
    });
  }

  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  for (const link of state.links || []) {
    edges.push({ ...link, recent: Boolean(sessionById.get(link.to)?.recent) });
  }

  return { nodes, edges, cx, cy };
}

function sparklinePath(series, x, y, w, h) {
  const vals = Array.isArray(series) ? series : [];
  if (vals.length === 0) return '';
  const max = Math.max(1, ...vals);
  const step = w / Math.max(vals.length - 1, 1);
  const pts = vals.map((v, i) => {
    const px = x + i * step;
    const py = y + h - (v / max) * h;
    return `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`;
  });
  return pts.join(' ');
}

/**
 * Standalone SVG snapshot of graph + stats + short timeline.
 */
function renderSvg(state, opts = {}) {
  const width = opts.width || 1200;
  const height = opts.height || 720;
  const panelW = 320;
  const graphW = width - panelW;
  const layout = layoutGraph(state, graphW, height);
  const nodeById = new Map(layout.nodes.map((n) => [n.id, n]));
  const stats = state.stats || {};
  const engines = stats.engines || {};

  const edgeEls = layout.edges
    .map((e) => {
      const a = nodeById.get(e.from);
      const b = nodeById.get(e.to);
      if (!a || !b) return '';
      const stroke = e.recent ? 'rgba(45,212,191,0.55)' : 'rgba(100,116,139,0.35)';
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${stroke}" stroke-width="1.4"/>`;
    })
    .join('\n');

  const sessionById = new Map((state.sessions || []).map((s) => [s.id, s]));
  const nodeEls = layout.nodes
    .map((n) => {
      const fill = stateColor(n.activityState || (n.awaitingInput ? 'waiting' : n.displayState));
      if (n.kind === 'project') {
        const context = (state.projects || []).find((p) => p.id === n.id);
        const info = context && context.memory;
        const description = 'Doc Bot summary\n' +
          (info?.summary ? info.summary.moved : 'No Doc Bot summary recorded for this project.');
        return `<g>
  <title>${escapeXml(description)}</title>
  <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r}" fill="rgba(15,23,42,0.9)" stroke="${fill}" stroke-width="2"/>
  <text x="${n.x.toFixed(1)}" y="${(n.y + n.r + 14).toFixed(1)}" text-anchor="middle" fill="#e2e8f0" font-size="11" font-family="ui-sans-serif, system-ui, sans-serif" letter-spacing="0.04em">${escapeXml(n.label)}</text>
</g>`;
      }
      const session = sessionById.get(n.id);
      const description = [
        `State: ${n.activityState || (n.awaitingInput ? 'waiting' : n.displayState) || 'unknown'}`,
        `Session ID: ${n.id}`,
        `Engine: ${session?.engine || 'unknown'}`,
        `Status: ${session?.status || 'unknown'}`,
        `Herdr status: ${session?.herdr?.runtime || 'unknown'}`,
      ].join('\n');
      const label = `<text x="${n.x.toFixed(1)}" y="${(n.y + n.r + 14).toFixed(1)}" text-anchor="middle" fill="#94a3b8" font-size="10" font-family="Consolas, 'Courier New', Courier, monospace">${escapeXml(n.label)}</text>`;
      const title = `<title>${escapeXml(description)}</title>`;
      if (n.awaitingInput) {
        return `<g>${title}
  <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r}" fill="${fill}"/>
  <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r + 4}" fill="none" stroke="${fill}" stroke-dasharray="3 3"/>
  <text x="${(n.x + n.r + 6).toFixed(1)}" y="${(n.y - n.r + 2).toFixed(1)}" fill="${fill}" font-size="13" font-weight="bold">?</text>${label}</g>`;
      }
      if (n.activityState === 'working') {
        return `<g>${title}
  <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r}" fill="${fill}"/>
  <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r + 4}" fill="none" stroke="${fill}" stroke-width="2" pathLength="100" stroke-dasharray="25 75"/>${label}</g>`;
      }
      if (n.activityState === 'completed') {
        return `<g>${title}
  <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r}" fill="${fill}"/>${label}</g>`;
      }
      const circle = `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r}" fill="${fill}" opacity="0.9"/>`;
      return `<g>${title}${circle}${label}</g>`;
    })
    .join('\n');

  const spark24 = sparklinePath(state.sparkline24h, width - panelW + 24, 210, panelW - 48, 36);
  const spark7 = sparklinePath(state.sparkline7d, width - panelW + 24, 280, panelW - 48, 36);

  const eventLines = (state.events || [])
    .slice(0, 10)
    .map((ev, i) => {
      const yy = 360 + i * 22;
      return `<text x="${width - panelW + 24}" y="${yy}" fill="#94a3b8" font-size="10" font-family="ui-sans-serif, system-ui, sans-serif">${escapeXml((ev.text || '').slice(0, 42))}</text>`;
    })
    .join('\n');

  const stars = [];
  for (let i = 0; i < 60; i++) {
    const sx = (i * 97) % graphW;
    const sy = (i * 53) % height;
    const o = 0.15 + (i % 5) * 0.05;
    stars.push(`<circle cx="${sx}" cy="${sy}" r="1" fill="#94a3b8" opacity="${o}"/>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <radialGradient id="bg" cx="40%" cy="45%" r="65%">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#020617"/>
    </radialGradient>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M32 0H0V32" fill="none" stroke="rgba(148,163,184,0.06)" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect width="${graphW}" height="${height}" fill="url(#grid)"/>
  ${stars.join('\n')}
  <g>${edgeEls}</g>
  <g>${nodeEls}</g>
  <rect x="${graphW}" y="0" width="${panelW}" height="${height}" fill="rgba(2,6,23,0.82)" stroke="rgba(45,212,191,0.15)"/>
  <text x="${graphW + 24}" y="42" fill="#f8fafc" font-size="22" font-family="ui-sans-serif, system-ui, sans-serif" font-weight="600" letter-spacing="0.12em">aflt live</text>
  <text x="${graphW + 24}" y="64" fill="#64748b" font-size="11" font-family="ui-sans-serif, system-ui, sans-serif">local · snapshot ${escapeXml(formatSnapshotStamp(state.generatedAt))}</text>
  <text x="${graphW + 24}" y="110" fill="#94a3b8" font-size="10" letter-spacing="0.08em" font-family="ui-sans-serif, system-ui, sans-serif">ACTIVE PROJECTS</text>
  <text x="${graphW + 24}" y="132" fill="#f8fafc" font-size="28" font-variant-numeric="tabular-nums" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${stats.activeProjects || 0}</text>
  <text x="${graphW + 140}" y="110" fill="#94a3b8" font-size="10" letter-spacing="0.08em" font-family="ui-sans-serif, system-ui, sans-serif">RUNNING</text>
  <text x="${graphW + 140}" y="132" fill="#2dd4bf" font-size="28" font-variant-numeric="tabular-nums" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${stats.runningSessions || 0}</text>
  <text x="${graphW + 24}" y="168" fill="#94a3b8" font-size="10" font-family="ui-sans-serif, system-ui, sans-serif">cursor ${engines.cursor || 0} · copilot ${engines.copilot || 0} · open ${stats.open || 0} · idle ${stats.idle || 0} · done ${stats.done || 0} · failed ${stats.failed || 0}</text>
  <text x="${graphW + 24}" y="200" fill="#94a3b8" font-size="10" letter-spacing="0.08em" font-family="ui-sans-serif, system-ui, sans-serif">LAST 24H</text>
  <path d="${spark24}" fill="none" stroke="#2dd4bf" stroke-width="1.5"/>
  <text x="${graphW + 24}" y="270" fill="#94a3b8" font-size="10" letter-spacing="0.08em" font-family="ui-sans-serif, system-ui, sans-serif">LAST 7D</text>
  <path d="${spark7}" fill="none" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="${graphW + 24}" y="340" fill="#94a3b8" font-size="10" letter-spacing="0.08em" font-family="ui-sans-serif, system-ui, sans-serif">RECENT</text>
  ${eventLines}
</svg>
`;
}

function renderHtmlDocument(state) {
  const css = readAsset('dashboard.css');
  const dataJson = JSON.stringify(state).replace(/</g, '\\u003c');
  return readAsset('index.html')
    .replace('<link rel="stylesheet" href="/dashboard.css"/>', () => `<style>${css}</style>`)
    .replace('<script src="/marked.min.js"></script>', () =>
      `<script>${readAsset('marked.min.js')}</script>`)
    .replace('<script src="/dashboard.js"></script>', () =>
      `<script type="application/json" id="aflt-dashboard-data">${dataJson}</script>\n` +
      `<script>${readAsset('dashboard.js')}</script>`);
}

function readAsset(name) {
  return fs.readFileSync(path.join(ASSET_DIR, name), 'utf8');
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function writeSnapshot(filePath, state) {
  const abs = path.resolve(expandUserPath(filePath));
  const ext = path.extname(abs).toLowerCase();
  let body;
  if (ext === '.svg') {
    body = renderSvg(state);
  } else if (ext === '.html' || ext === '.htm') {
    body = renderHtmlDocument(state);
  } else {
    const err = new Error(
      `unsupported snapshot extension "${ext || '(none)'}"; use .svg or .html`
    );
    err.code = 'DASHBOARD_SNAPSHOT_EXT';
    throw err;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return abs;
}

/**
 * Create the HTTP server (does not listen yet).
 * @returns {{ server: http.Server, close: () => Promise<void>, getState: () => object }}
 */
function createDashboardServer(opts = {}) {
  const herdrFocusToken = crypto.randomBytes(32).toString('hex');
  let focusingHerdr = false;
  const waitingState = new Map();
  const completionCache = new Map();
  const collect = typeof opts.collect === 'function' ? opts.collect : () => collectState({ ...opts, waitingState, completionCache });
  const sseClients = new Set();
  let lastPayload = null;
  let lastRegistryMtime = null;
  let closed = false;
  let watchHandle = null;
  let pollTimer = null;
  let sseTimer = null;

  function registryMtime() {
    try {
      return fs.statSync(registryPath()).mtimeMs;
    } catch (_) {
      return null;
    }
  }

  function refresh(reason) {
    if (closed) return lastPayload;
    try {
      lastPayload = { ...collect(), actions: { herdrFocusToken } };
    } catch (err) {
      lastPayload = {
        generatedAt: nowIso(),
        error: String(err && err.message ? err.message : err),
        stats: {
          activeProjects: 0,
          runningSessions: 0,
          engines: { cursor: 0, copilot: 0 },
          open: 0,
          idle: 0,
          done: 0,
          failed: 0,
          sessions: 0,
          projects: 0,
        },
        projects: [],
        sessions: [],
        links: [],
        sparkline24h: new Array(24).fill(0),
        sparkline7d: new Array(7).fill(0),
        events: [],
        memory: { present: false, recordCount: 0 },
      };
    }
    const data = `data: ${JSON.stringify(lastPayload)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(data);
      } catch (_) {
        sseClients.delete(res);
      }
    }
    return lastPayload;
  }

  function checkRegistryChange() {
    const mt = registryMtime();
    if (mt != null && mt !== lastRegistryMtime) {
      lastRegistryMtime = mt;
      refresh('registry');
    }
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = u.pathname;

    if (pathname.startsWith('/api/herdr/focus/')) {
      const reply = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        reply(405, { error: 'Use POST to focus a Herdr terminal.' });
        return;
      }
      const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
      const hostname = u.hostname.replace(/^\[|\]$/g, '');
      if (!loopback.has(req.socket.remoteAddress) ||
          !['localhost', '127.0.0.1', '::1'].includes(hostname) ||
          (req.headers.origin && req.headers.origin !== u.origin) ||
          req.headers['x-aflt-action-token'] !== herdrFocusToken) {
        reply(403, { error: 'Herdr focus requires a request from the local dashboard. Refresh the page and try again.' });
        return;
      }
      let session;
      try {
        const id = decodeURIComponent(pathname.slice('/api/herdr/focus/'.length));
        session = registry.findExact(id);
        if (session && session.id !== id) session = null;
      } catch (err) {
        reply(400, { error: `Invalid session: ${err.message}` });
        return;
      }
      if (!session) {
        reply(404, { error: 'This session is no longer registered.' });
        return;
      }
      if (focusingHerdr) {
        reply(409, { error: 'Another Herdr terminal is being opened. Try again shortly.' });
        return;
      }
      focusingHerdr = true;
      try {
        const result = await (opts.focusHerdrSession || focusHerdrSession)(session);
        reply(200, { ok: true, ...result });
      } catch (err) {
        reply(502, { error: String(err.message || err) });
      } finally {
        focusingHerdr = false;
      }
      return;
    }

    if (pathname === '/api/state' || pathname === '/api/dashboard') {
      const state = lastPayload || refresh('api');
      const body = JSON.stringify(state);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      const state = lastPayload || refresh('sse');
      res.write(`data: ${JSON.stringify(state)}\n\n`);
      sseClients.add(res);
      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      try {
        const html = readAsset('index.html');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(String(err.message || err));
      }
      return;
    }

    if (pathname === '/dashboard.css' || pathname === '/dashboard.js' || pathname === '/marked.min.js') {
      const file = path.join(ASSET_DIR, path.basename(pathname));
      try {
        const body = fs.readFileSync(file);
        res.writeHead(200, {
          'Content-Type': contentTypeFor(file),
          'Cache-Control': 'no-store',
        });
        res.end(body);
      } catch (_) {
        res.writeHead(404).end('not found');
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  });

  function startWatchers() {
    lastRegistryMtime = registryMtime();
    refresh('start');
    try {
      const rp = registryPath();
      const dir = path.dirname(rp);
      if (fs.existsSync(dir)) {
        watchHandle = fs.watch(dir, { persistent: true }, (_evt, filename) => {
          if (!filename || String(filename).includes('sessions')) {
            checkRegistryChange();
          }
        });
        if (typeof watchHandle.unref === 'function') watchHandle.unref();
      }
    } catch (_) {
      /* poll fallback only */
    }
    pollTimer = setInterval(checkRegistryChange, opts.registryPollMs || REGISTRY_POLL_MS);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
    sseTimer = setInterval(() => refresh('tick'), opts.sseIntervalMs || SSE_INTERVAL_MS);
    if (typeof sseTimer.unref === 'function') sseTimer.unref();
  }

  function close() {
    return new Promise((resolve) => {
      if (closed) {
        resolve();
        return;
      }
      closed = true;
      if (watchHandle) {
        try {
          watchHandle.close();
        } catch (_) {
          /* ignore */
        }
        watchHandle = null;
      }
      if (pollTimer) clearInterval(pollTimer);
      if (sseTimer) clearInterval(sseTimer);
      for (const res of sseClients) {
        try {
          res.end();
        } catch (_) {
          /* ignore */
        }
      }
      sseClients.clear();
      server.close(() => resolve());
    });
  }

  server.on('listening', startWatchers);

  return {
    server,
    close,
    getState: () => lastPayload || refresh('get'),
    refresh,
  };
}

/**
 * Listen until SIGINT/SIGTERM. Resolves when closed.
 */
function serveDashboard(opts = {}) {
  const host = opts.host != null ? String(opts.host) : DEFAULT_HOST;
  const port = opts.port != null ? Number(opts.port) : DEFAULT_PORT;
  const asJson = Boolean(opts.json);
  const handle = createDashboardServer(opts);
  const { server, close } = handle;

  return new Promise((resolve, reject) => {
    const onSignal = () => {
      close().then(() => resolve({ ok: true, stopped: true }));
    };

    server.once('error', (err) => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      reject(err);
    });

    server.listen(port, host, () => {
      const addr = server.address();
      const boundPort = addr && typeof addr === 'object' ? addr.port : port;
      const url = `http://${host}:${boundPort}/`;
      if (asJson) {
        process.stdout.write(
          JSON.stringify({ ok: true, url, host, port: boundPort, captureCompletions: Boolean(opts.captureCompletions) }, null, 2) + '\n'
        );
      } else {
        process.stdout.write(`${url}\n`);
        if (opts.captureCompletions) process.stdout.write('Task Complete capture enabled (project status notes; no commits).\n');
      }
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
    });
  });
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DASHBOARD_TZ,
  RECENT_MS,
  DISPLAY_STATES,
  ASSET_DIR,
  formatSnapshotStamp,
  deriveDisplayState,
  enrichmentForSession,
  mergeSimPreserve,
  aggregateDashboard,
  loadMemoryRecords,
  loadMemoryProjects,
  collectState,
  createDashboardServer,
  serveDashboard,
  writeSnapshot,
  renderSvg,
  renderHtmlDocument,
  layoutGraph,
  stateColor,
  focusHerdrSession,
};
