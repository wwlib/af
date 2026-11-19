'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const vm = require('vm');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

function af(args, env, opts = {}) {
  return spawnSync(process.execPath, [afJs, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd || env.HOME,
    env: { ...process.env, ...env },
  });
}

function clearDashboardModules() {
  const mods = [
    '../lib/util',
    '../lib/config',
    '../lib/project',
    '../lib/display-state',
    '../lib/registry',
    '../lib/memory',
    '../lib/herdr',
    '../lib/orchestrate',
    '../lib/task-completions',
    '../lib/dashboard',
  ];
  for (const m of mods) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

function loadDashboard(home) {
  clearDashboardModules();
  process.env.AGENTFLEET_HOME = home;
  process.env.HOME = home;
  delete process.env.AFLT_MEMORY_REPO;
  return require('../lib/dashboard');
}

function loadRegistry(home) {
  clearDashboardModules();
  process.env.AGENTFLEET_HOME = home;
  process.env.HOME = home;
  return require('../lib/registry');
}

function seedSession(home, partial) {
  const registry = loadRegistry(home);
  return registry.add({
    title: partial.title || 'Seed',
    chatId:
      partial.chatId ||
      `aaaaaaaa-bbbb-cccc-dddd-${String(Math.random()).slice(2, 14).padEnd(12, '0')}`,
    cwd: partial.cwd || path.join(home, 'proj'),
    engine: partial.engine || 'cursor',
    status: partial.status || 'done',
    created: partial.created || '2024-06-01T00:00:00.000Z',
    lastUsed: partial.lastUsed || '2024-06-02T00:00:00.000Z',
    ...partial,
  });
}

function httpRequest(port, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathname, timeout: 5000, ...opts },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

function httpGet(port, pathname) {
  return httpRequest(port, pathname);
}

function httpSseOneEvent(port, accepts = () => true) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path: '/events', timeout: 5000 },
      (res) => {
        assert.equal(res.statusCode, 200);
        assert.match(String(res.headers['content-type'] || ''), /text\/event-stream/);
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          let end;
          while ((end = buf.indexOf('\n\n')) !== -1) {
            const body = buf.slice(0, end + 2);
            buf = buf.slice(end + 2);
            if (accepts(body)) {
              req.destroy();
              resolve({ headers: res.headers, body });
              return;
            }
          }
        });
        res.on('error', () => {});
      }
    );
    req.on('error', (err) => {
      if (err && err.code === 'ECONNRESET') return;
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('sse timeout'));
    });
  });
}

describe('aflt dashboard', () => {
  let home;
  let prevHome;
  let prevAfHome;
  let prevMem;
  let prevReg;
  let prevCopilotHome;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevMem = process.env.AFLT_MEMORY_REPO;
    prevReg = process.env.AGENTFLEET_REGISTRY;
    prevCopilotHome = process.env.AGENTFLEET_COPILOT_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-dash-home-'));
    fs.mkdirSync(path.join(home, 'proj'), { recursive: true });
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = home;
    process.env.AGENTFLEET_COPILOT_HOME = path.join(home, 'copilot');
    delete process.env.AFLT_MEMORY_REPO;
    delete process.env.AGENTFLEET_REGISTRY;
    delete process.env.AFLT_PROJECT;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAfHome === undefined) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevAfHome;
    if (prevMem === undefined) delete process.env.AFLT_MEMORY_REPO;
    else process.env.AFLT_MEMORY_REPO = prevMem;
    if (prevReg === undefined) delete process.env.AGENTFLEET_REGISTRY;
    else process.env.AGENTFLEET_REGISTRY = prevReg;
    if (prevCopilotHome === undefined) delete process.env.AGENTFLEET_COPILOT_HOME;
    else process.env.AGENTFLEET_COPILOT_HOME = prevCopilotHome;
    delete process.env.AFLT_PROJECT;
    clearDashboardModules();
  });

  function env(extra = {}) {
    return {
      ...process.env,
      HOME: home,
      AGENTFLEET_HOME: home,
      AFLT_MEMORY_REPO: '',
      AGENTFLEET_SESSION: '',
      AGENTFLEET_ID: '',
      ...extra,
    };
  }

  it('aggregates counts, derived states, grouping, sparklines, and timeline', () => {
    const dash = loadDashboard(home);
    const now = '2024-06-10T12:00:00.000Z';
    const master = {
      id: 'master-aaaaaaaaaaaa',
      title: 'orch-master',
      project: 'alpha',
      engine: 'cursor',
      status: 'active',
      role: 'master',
      created: '2024-06-10T10:00:00.000Z',
      lastUsed: '2024-06-10T11:55:00.000Z',
      lastRunAt: '2024-06-10T11:50:00.000Z',
      runPid: process.pid,
      cwd: path.join(home, 'proj'),
    };
    const worker = {
      id: 'worker-bbbbbbbbbbbb',
      title: 'helper-worker',
      project: 'alpha',
      engine: 'copilot',
      status: 'done',
      parent: master.id,
      role: 'worker',
      created: '2024-06-10T10:05:00.000Z',
      lastUsed: '2024-06-10T10:30:00.000Z',
      lastRunAt: '2024-06-10T10:20:00.000Z',
      lastExit: 0,
      cwd: path.join(home, 'proj'),
    };
    const failed = {
      id: 'fail-cccccccccccc',
      title: 'broke-session',
      project: 'beta',
      engine: 'cursor',
      status: 'done',
      created: '2024-06-09T08:00:00.000Z',
      lastUsed: '2024-06-09T09:00:00.000Z',
      lastExit: 2,
      lastError: 'boom',
      cwd: path.join(home, 'proj'),
    };
    const idle = {
      id: 'idle-dddddddddddd',
      title: 'paused-one',
      project: 'beta',
      engine: 'cursor',
      status: 'paused',
      created: '2024-06-08T00:00:00.000Z',
      lastUsed: '2024-06-08T01:00:00.000Z',
      cwd: path.join(home, 'proj'),
    };

    const payload = dash.aggregateDashboard({
      sessions: [master, worker, failed, idle],
      memoryRecords: [],
      enrichmentById: {
        [master.id]: { runtime: 'running', address: 't1', name: 'af-master', checkedAt: now },
      },
      now,
      isAlive: (pid) => Number(pid) === process.pid,
    });

    assert.equal(payload.stats.sessions, 4);
    assert.equal(payload.stats.runningSessions, 1);
    assert.equal(payload.stats.open, 1);
    assert.equal(payload.stats.idle, 1);
    assert.equal(payload.stats.engines.cursor, 3);
    assert.equal(payload.stats.engines.copilot, 1);
    assert.equal(payload.stats.failed, 1);
    assert.ok(payload.stats.activeProjects >= 1);

    const byId = Object.fromEntries(payload.sessions.map((s) => [s.id, s]));
    assert.equal(byId[master.id].displayState, 'running');
    assert.equal(byId[worker.id].displayState, 'done');
    assert.equal(byId[failed.id].displayState, 'failed');
    assert.equal(byId[idle.id].displayState, 'idle');
    assert.equal(byId[worker.id].project, 'alpha');
    assert.deepEqual(byId[master.id].children, [worker.id]);

    const projects = Object.fromEntries(payload.projects.map((p) => [p.name, p]));
    assert.ok(projects.alpha);
    assert.ok(projects.beta);
    assert.equal(projects.alpha.displayState, 'running');
    assert.ok(payload.links.some((l) => l.kind === 'parent' && l.from === master.id));
    assert.equal(payload.sparkline24h.length, 24);
    assert.equal(payload.sparkline7d.length, 7);
    assert.ok(payload.sparkline24h.some((n) => n > 0) || payload.sparkline7d.some((n) => n > 0));
    assert.ok(payload.events.length > 0);
    assert.ok(payload.events[0].at >= payload.events[payload.events.length - 1].at);
  });

  it('connects each session only to its parent or its project when the parent is absent', () => {
    const dash = loadDashboard(home);
    const state = dash.aggregateDashboard({
      sessions: [
        { id: 'master', project: 'alpha' },
        { id: 'worker', project: 'alpha', parent: 'master' },
        { id: 'nested', project: 'beta', parent: 'worker' },
        { id: 'orphan', project: 'alpha', parent: 'missing' },
        { id: 'self', project: 'alpha', parent: 'self' },
      ],
    });
    const expected = [
      { from: 'project:alpha', to: 'master', kind: 'project' },
      { from: 'master', to: 'worker', kind: 'parent' },
      { from: 'worker', to: 'nested', kind: 'parent' },
      { from: 'project:alpha', to: 'orphan', kind: 'project' },
      { from: 'project:alpha', to: 'self', kind: 'project' },
    ];
    assert.deepEqual(state.links, expected);
    const layout = dash.layoutGraph(state, 800, 600);
    assert.deepEqual(layout.edges, expected.map((edge) => ({ ...edge, recent: false })));
    const snapshot = dash.renderSvg(state);
    assert.equal((snapshot.match(/<line /g) || []).length, expected.length);
  });

  it('shortens long node labels while preserving full session identities and short IDs', () => {
    const dash = loadDashboard(home);
    const ids = ['pla-funnel-lifecycle-29c501', 'pla-funnel-lifecycle-29c502', '123456789012345678', 'short'];
    const state = dash.aggregateDashboard({ sessions: ids.map((id) => ({ id, project: 'alpha' })) });
    assert.deepEqual(state.sessions.map((s) => s.id), ids);
    assert.deepEqual(state.sessions.map((s) => s.nodeLabel), [
      'pla-funne...29c501', 'pla-funne...29c502', '123456789012345678', 'short',
    ]);
    const svg = dash.renderSvg(state);
    assert.ok(svg.includes('>pla-funne...29c501</text>'));
    assert.ok(svg.includes('Session ID: pla-funnel-lifecycle-29c501\n'));
    assert.ok(!svg.includes('>pla-funnel-lifecycle-29c501</text>'));
  });

  it('focuses the uniquely live labeled terminal rather than stale saved Herdr metadata', async () => {
    const dash = loadDashboard(home);
    const session = { id: 'target', herdr: { address: 't1' } };
    const before = JSON.stringify(session);
    const calls = [];
    const result = await dash.focusHerdrSession(session, {
      fetchHerdrTerminals: () => ({ ok: true, terminals: [
        { afId: 'target', address: 't1', state: 'finished' },
        { afId: 'other', address: 't2', state: 'live' },
        { afId: 'target', address: 't3', state: 'live' },
      ] }),
      runApp: async (args) => { calls.push(args); return { stdout: '{"ok":true}' }; },
      raiseApp: async () => { calls.push('raise'); },
    });
    assert.deepEqual(result, { sessionId: 'target', address: 't3' });
    assert.deepEqual(calls, [['do', 'agent.focus', '--terminal', 't3'], 'raise']);
    assert.equal(JSON.stringify(session), before);
  });

  it('reports absent or ambiguous terminals and Herdr failures without launching an agent', async () => {
    const dash = loadDashboard(home);
    const calls = [];
    const options = {
      runApp: async () => { calls.push('focus'); return { stdout: '{"error":"app unavailable"}' }; },
      raiseApp: async () => { calls.push('raise'); },
    };
    for (const terminals of [
      [],
      [{ afId: 'target', address: 't1', state: 'finished' }],
      [{ afId: 'target', address: 't1' }, { afId: 'target', address: 't2' }],
    ]) {
      await assert.rejects(dash.focusHerdrSession({ id: 'target' }, {
        ...options, fetchHerdrTerminals: () => ({ ok: true, terminals }),
      }), /No unique live Herdr terminal/);
    }
    await assert.rejects(dash.focusHerdrSession({ id: 'target' }, {
      ...options, fetchHerdrTerminals: () => ({ ok: false, error: 'hc timed out' }),
    }), /hc timed out/);
    assert.deepEqual(calls, []);
    await assert.rejects(dash.focusHerdrSession({ id: 'target' }, {
      ...options,
      fetchHerdrTerminals: () => ({ ok: true, terminals: [{ afId: 'target', address: 't1' }] }),
    }), /app unavailable/);
    assert.deepEqual(calls, ['focus']);
  });

  it('requires a local authenticated POST for Herdr focus and never writes the registry', async () => {
    const session = seedSession(home, { title: 'Focus me', project: 'alpha' });
    const dash = loadDashboard(home);
    const registryFile = path.join(home, 'sessions.json');
    const before = fs.readFileSync(registryFile, 'utf8');
    const focused = [];
    let fail = false;
    const handle = dash.createDashboardServer({
      collect: () => dash.aggregateDashboard({ sessions: [session] }),
      focusHerdrSession: async (s) => {
        focused.push(s.id);
        if (fail) throw new Error('Herdr app is not open');
        return { sessionId: s.id, address: 't3' };
      },
    });
    handle.server.listen(0, '127.0.0.1');
    await new Promise((resolve) => handle.server.once('listening', resolve));
    const port = handle.server.address().port;
    const route = '/api/herdr/focus/' + encodeURIComponent(session.id);
    try {
      const state = JSON.parse((await httpGet(port, '/api/state')).body);
      const headers = { 'X-Aflt-Action-Token': state.actions.herdrFocusToken };
      assert.equal((await httpGet(port, route)).status, 405);
      assert.equal((await httpRequest(port, route, { method: 'POST' })).status, 403);
      for (const extra of [
        { Origin: 'https://other.example' },
        { Host: 'untrusted.example:' + port },
        { 'X-Aflt-Action-Token': 'wrong' },
      ]) {
        assert.equal((await httpRequest(port, route, {
          method: 'POST', headers: { ...headers, ...extra },
        })).status, 403);
      }
      assert.equal((await httpRequest(port, '/api/herdr/focus/missing', { method: 'POST', headers })).status, 404);
      assert.deepEqual(focused, []);
      const success = await httpRequest(port, route, {
        method: 'POST', headers: { ...headers, Origin: `http://127.0.0.1:${port}` },
      });
      assert.equal(success.status, 200);
      assert.deepEqual(JSON.parse(success.body), { ok: true, sessionId: session.id, address: 't3' });
      fail = true;
      const failure = await httpRequest(port, route, { method: 'POST', headers });
      assert.equal(failure.status, 502);
      assert.match(JSON.parse(failure.body).error, /Herdr app is not open/);
      fail = false;
      assert.equal((await httpRequest(port, route, { method: 'POST', headers })).status, 200);
      assert.equal(fs.readFileSync(registryFile, 'utf8'), before);
    } finally {
      await handle.close();
    }
  });

  it('marks confirmed waiting sessions without confusing idle, stopped or completed sessions', () => {
    const dash = loadDashboard(home);
    const cases = [
      ['recorded', 'active', 'waiting', null, true, 'waiting'],
      ['blocked', 'active', null, { runtime: 'running', status: { state: 'blocked' } }, true, 'waiting'],
      ['turn-complete', 'active', null, { runtime: 'running', status: 'done' }, false, 'completed'],
      ['working', 'active', 'waiting', { runtime: 'running', status: { state: 'working' } }, false, 'working'],
      ['fresh-idle', 'active', null, { runtime: 'running', status: { state: 'idle' } }, false, 'running'],
      ['no-signal', 'active', 'waiting', { runtime: 'running', status: null }, false, 'running'],
      ['exited', 'active', 'waiting', { runtime: 'exited', status: 'blocked' }, false, 'idle'],
      ['shell', 'active', 'waiting', { runtime: 'shell', status: 'blocked' }, false, 'running'],
      ['missing', 'active', 'waiting', { runtime: 'missing' }, false, 'idle'],
      ['completed', 'done', 'waiting', { runtime: 'running', status: 'blocked' }, false, 'completed'],
    ];
    const sessions = cases.map(([id, status, workerStatus]) => ({
      id, title: id, project: 'alpha', cwd: home, status, workerStatus,
    }));
    const state = dash.aggregateDashboard({
      sessions, now: '2024-06-10T12:00:00.000Z',
      enrichmentById: Object.fromEntries(cases.filter((c) => c[3]).map((c) => [c[0], c[3]])),
      isAlive: () => false,
    });
    for (const [id, status, , , expected, activityState] of cases) {
      const session = state.sessions.find((s) => s.id === id);
      assert.equal(session.awaitingInput, expected, id);
      assert.equal(session.status, status);
      assert.equal(session.activityState, activityState, id);
    }
    assert.equal(state.sessions.find((s) => s.id === 'blocked').displayState, 'running');
    const svg = dash.renderSvg(state);
    assert.match(svg, /<title>State: waiting\nSession ID: blocked\n/);
    assert.match(svg, /stroke-dasharray="3 3"/);
    assert.doesNotMatch(svg, /State: waiting\nSession ID: working\n/);
    assert.match(svg, /<title>State: working\nSession ID: working\n/);
    assert.match(svg, /pathLength="100" stroke-dasharray="25 75"/);
    assert.match(svg, /<title>State: completed\nSession ID: turn-complete\n[^<]+<\/title>\s*<circle[^>]+fill="#4da6ff"/);
  });

  it('tracks working, completion and input transitions without persisting dashboard state', () => {
    const dash = loadDashboard(home);
    const previousGrace = process.env.AGENTFLEET_SEND_GRACE;
    process.env.AGENTFLEET_SEND_GRACE = '15';
    try {
      const session = { id: 'live', title: 'Live', project: 'alpha', cwd: home, status: 'active' };
      const enrichment = { runtime: 'running', status: { state: 'working' } };
      const opts = {
        sessions: [session], enrichmentById: { live: enrichment },
        memoryProjects: [], memoryRecords: [], waitingState: new Map(),
        now: '2024-06-10T12:00:00.000Z', isAlive: () => false,
      };
      const waiting = () => dash.collectState(opts).sessions[0].awaitingInput;
      const activity = () => dash.collectState(opts).sessions[0].activityState;
      assert.equal(waiting(), false);
      assert.equal(activity(), 'working');
      enrichment.status = { state: 'idle' };
      assert.equal(waiting(), true);
      assert.equal(activity(), 'waiting');
      session.lastSendAt = opts.now;
      enrichment.status = { state: 'done' };
      assert.equal(waiting(), false, 'ignore the previous turn after a new send');
      assert.equal(activity(), 'running');
      opts.now = '2024-06-10T12:00:16.000Z';
      assert.equal(activity(), 'completed', 'recognize an instant turn after send grace');
      assert.equal(waiting(), false, 'a completed turn is not an input request');
      enrichment.status = { state: 'idle' };
      assert.equal(activity(), 'completed', 'retain completion when a finished agent becomes idle');
      session.lastSendAt = opts.now;
      assert.equal(activity(), 'running', 'a new prompt clears the previous completion');
      enrichment.status = { state: 'working' };
      assert.equal(waiting(), false);
      assert.equal(activity(), 'working');
      enrichment.status = { state: 'blocked' };
      assert.equal(waiting(), true);
      assert.equal(activity(), 'waiting');
      enrichment.runtime = 'shell';
      assert.equal(waiting(), false);
      opts.sessions = [];
      dash.collectState(opts);
      assert.equal(opts.waitingState.size, 0);
      assert.equal(fs.existsSync(path.join(home, 'sessions.json')), false);
      assert.equal(session.workerStatus, undefined);
    } finally {
      if (previousGrace === undefined) delete process.env.AGENTFLEET_SEND_GRACE;
      else process.env.AGENTFLEET_SEND_GRACE = previousGrace;
    }
  });

  it('distinguishes live and finished headless work without changing lifecycle counts or marking failures complete', () => {
    const dash = loadDashboard(home);
    const state = dash.aggregateDashboard({
      sessions: [
        { id: 'live-worker', status: 'active', workerStatus: 'running', runPid: 42 },
        { id: 'dead-worker', status: 'active', workerStatus: 'running', runPid: 43 },
        { id: 'finished-worker', status: 'active', workerStatus: 'done', lastExit: 0 },
        { id: 'failed', status: 'done', lastExit: 1 },
        { id: 'paused', status: 'paused' },
      ].map((s) => ({ project: 'alpha', cwd: home, ...s })),
      enrichmentById: { paused: { runtime: 'running', status: 'working' } },
      isAlive: (pid) => pid === 42,
    });
    const sessions = Object.fromEntries(state.sessions.map((s) => [s.id, s]));
    assert.equal(sessions['live-worker'].activityState, 'working');
    assert.equal(sessions['live-worker'].displayState, 'running');
    assert.equal(sessions['dead-worker'].activityState, 'idle');
    assert.equal(sessions['finished-worker'].activityState, 'completed');
    assert.equal(sessions['finished-worker'].displayState, 'idle');
    assert.equal(sessions['finished-worker'].status, 'active');
    assert.equal(sessions.failed.activityState, 'failed');
    assert.equal(sessions.paused.activityState, 'idle');
  });

  it('active + Herdr exited is idle (not open); registry status stays active; af→aflt', () => {
    const dash = loadDashboard(home);
    const exited = {
      id: 'exited-aaaaaaaaaaaa',
      title: 'was-live',
      project: 'af',
      engine: 'cursor',
      status: 'active',
      created: '2024-06-10T10:00:00.000Z',
      lastUsed: '2024-06-10T11:00:00.000Z',
      cwd: path.join(home, 'proj'),
    };
    const live = {
      id: 'live-bbbbbbbbbbbb',
      title: 'still-running',
      project: 'aflt',
      engine: 'cursor',
      status: 'active',
      created: '2024-06-10T10:00:00.000Z',
      lastUsed: '2024-06-10T11:30:00.000Z',
      runPid: process.pid,
      cwd: path.join(home, 'proj'),
    };
    const payload = dash.aggregateDashboard({
      sessions: [exited, live],
      enrichmentById: {
        [exited.id]: { runtime: 'exited', checkedAt: '2024-06-10T11:01:00.000Z' },
        [live.id]: { runtime: 'running', checkedAt: '2024-06-10T11:31:00.000Z' },
      },
      now: '2024-06-10T12:00:00.000Z',
      isAlive: (pid) => Number(pid) === process.pid,
    });
    const byId = Object.fromEntries(payload.sessions.map((s) => [s.id, s]));
    assert.equal(byId[exited.id].displayState, 'idle');
    assert.equal(byId[live.id].displayState, 'running');
    assert.equal(byId[exited.id].status, 'active');
    assert.equal(byId[exited.id].project, 'aflt');
    assert.equal(byId[live.id].project, 'aflt');
    assert.equal(payload.stats.open, 1);
    assert.equal(payload.stats.idle, 1);
    assert.equal(payload.stats.runningSessions, 1);
    assert.equal(payload.projects.length, 1);
    assert.equal(payload.projects[0].name, 'aflt');
    assert.equal(exited.project, 'af');
  });

  it('mergeSimPreserve keeps positions when node ids are unchanged', () => {
    const dash = loadDashboard(home);
    const prev = {
      nodes: [
        { id: 'project:a', kind: 'project', label: 'a', x: 10, y: 20, vx: 0.5, vy: -0.2, r: 20 },
        { id: 's1', kind: 'session', label: 'one', x: 40, y: 50, vx: 0.1, vy: 0.1, r: 8 },
      ],
      links: [],
      w: 800,
      h: 600,
      cx: 400,
      cy: 300,
      alpha: 0.3,
    };
    const nextBuilt = {
      nodes: [
        {
          id: 'project:a',
          kind: 'project',
          label: 'a',
          displayState: 'idle',
          x: 100,
          y: 200,
          vx: 0,
          vy: 0,
          r: 20,
        },
        {
          id: 's1',
          kind: 'session',
          label: 'one-renamed',
          displayState: 'running',
          x: 300,
          y: 400,
          vx: 0,
          vy: 0,
          r: 8,
          recent: true,
        },
      ],
      links: [{ source: 'project:a', target: 's1', kind: 'project', recent: true }],
      w: 800,
      h: 600,
      cx: 400,
      cy: 300,
    };
    const merged = dash.mergeSimPreserve(prev, nextBuilt, { preserveAlpha: true });
    assert.equal(merged.nodeSetChanged, false);
    assert.equal(merged.alpha, 0.3);
    const byId = Object.fromEntries(merged.nodes.map((n) => [n.id, n]));
    assert.equal(byId['project:a'].x, 10);
    assert.equal(byId['project:a'].y, 20);
    assert.equal(byId['project:a'].vx, 0.5);
    assert.equal(byId.s1.x, 40);
    assert.equal(byId.s1.label, 'one-renamed');
    assert.equal(byId.s1.displayState, 'running');
    assert.equal(byId.s1.recent, true);
    assert.equal(merged.links.length, 1);
    assert.equal(merged.links[0].source.x, 10);

    const withNew = dash.mergeSimPreserve(prev, {
      ...nextBuilt,
      nodes: [
        ...nextBuilt.nodes,
        { id: 's2', kind: 'session', label: 'two', x: 1, y: 2, vx: 0, vy: 0, r: 8 },
      ],
    });
    assert.equal(withNew.nodeSetChanged, true);
    assert.equal(withNew.alpha, 1);
  });

  it('merges optional memory sessions.jsonl and ignores when absent', () => {
    const dash = loadDashboard(home);
    const memRepo = path.join(home, 'memory-repo');
    fs.mkdirSync(path.join(memRepo, 'gamma', '_aflt'), { recursive: true });
    fs.writeFileSync(
      path.join(memRepo, 'gamma', '_aflt', 'sessions.jsonl'),
      JSON.stringify({
        id: 'hist-1',
        title: 'old-gamma',
        project: 'gamma',
        start: '2024-06-01T00:00:00.000Z',
        lastUsed: '2024-06-01T01:00:00.000Z',
      }) + '\n'
    );

    const withMem = dash.aggregateDashboard({
      sessions: [
        {
          id: 's1',
          title: 'live',
          project: 'alpha',
          engine: 'cursor',
          status: 'done',
          created: '2024-06-10T00:00:00.000Z',
          lastUsed: '2024-06-10T01:00:00.000Z',
          lastExit: 0,
        },
      ],
      memoryRecords: dash.loadMemoryRecords(memRepo),
      now: '2024-06-10T12:00:00.000Z',
    });
    assert.equal(withMem.memory.present, true);
    assert.ok(withMem.memory.recordCount >= 1);
    assert.ok(withMem.projects.some((p) => p.name === 'gamma'));

    const noMem = dash.aggregateDashboard({
      sessions: [
        {
          id: 's1',
          title: 'live',
          project: 'alpha',
          engine: 'cursor',
          status: 'done',
          created: '2024-06-10T00:00:00.000Z',
          lastUsed: '2024-06-10T01:00:00.000Z',
          lastExit: 0,
        },
      ],
      memoryRecords: dash.loadMemoryRecords(path.join(home, 'missing-memory')),
      now: '2024-06-10T12:00:00.000Z',
    });
    assert.equal(noMem.memory.present, false);
    assert.equal(noMem.memory.recordCount, 0);
  });

  it('loads project summaries and docs, preferring canonical folders and including memory-only projects', () => {
    const dash = loadDashboard(home);
    const repo = path.join(home, 'memory');
    const notes = path.join(repo, 'aflt', 'status-notes');
    fs.mkdirSync(path.join(notes, 'archive'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'af'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'notes-only'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'af', 'README.md'), 'Old alias notes');
    fs.writeFileSync(path.join(repo, 'aflt', 'README.md'), '# AgentFleet\nProject docs');
    fs.writeFileSync(path.join(repo, 'aflt', 'dashboard.md'), '# Project status\nPending implementation');
    fs.writeFileSync(path.join(repo, 'notes-only', 'README.md'), '# No sessions yet');
    fs.writeFileSync(path.join(notes, 'archive', '2099-01-01-ignore.md'), 'Archived');
    fs.writeFileSync(path.join(notes, '2026-11-16T1205-metadata.md'), '# Metadata proposal\nNot shipped');
    fs.writeFileSync(path.join(notes, '2026-11-16T1213-messaging.md'), '# Direct messaging proposal\nPending');
    fs.writeFileSync(path.join(repo, 'DASHBOARD.md'),
      '<!-- doc-bot:summary:start -->\n' +
      '| Project | What moved | Blocked |\n| --- | --- | --- |\n' +
      '| [aflt](aflt/) | Metadata \\| messaging proposals | _None reported._ |\n' +
      '<!-- doc-bot:summary:end -->\n');
    const before = fs.readFileSync(path.join(repo, 'DASHBOARD.md'), 'utf8');
    const state = dash.collectState({
      sessions: [{ id: 's1', project: 'af', title: 'Expert', status: 'done' }],
      memoryRepo: repo,
      enrichmentById: {},
    });
    assert.deepEqual(state.projects.map((p) => p.name), ['aflt', 'notes-only']);
    const project = state.projects[0];
    assert.equal(project.sessionCount, 1);
    assert.equal(project.memory.summary.moved, 'Metadata | messaging proposals');
    assert.equal(project.memory.summary.blocked, '_None reported._');
    assert.deepEqual(project.memory.documents.map((d) => d.kind), ['readme', 'dashboard', 'status', 'status']);
    assert.match(project.memory.documents[2].path, /1213-messaging/);
    assert.equal(project.memory.documents[2].content, '# Direct messaging proposal\nPending');
    assert.equal(project.memory.documents[2].date, '2026-11-16');
    assert.equal(state.projects[1].fromMemoryOnly, true);
    assert.equal(state.memory.present, true);
    assert.equal(state.memory.configured, true);
    assert.equal(fs.readFileSync(path.join(repo, 'DASHBOARD.md'), 'utf8'), before);
  });

  it('bounds and redacts document previews, excludes archives and rejects escaped symlinks', () => {
    const dash = loadDashboard(home);
    const repo = path.join(home, 'memory');
    fs.mkdirSync(path.join(repo, 'alpha', 'status-notes'), { recursive: true });
    const external = path.join(home, 'private.md');
    fs.writeFileSync(external, 'Must not expose outside document');
    fs.symlinkSync(external, path.join(repo, 'alpha', 'README.md'));
    fs.symlinkSync(home, path.join(repo, 'escaped-project'));
    fs.writeFileSync(path.join(repo, 'alpha', 'dashboard.md'),
      '# Status\nContact person@example.org\n' + 'Long preview text.\n'.repeat(3000));
    for (let day = 1; day <= 12; day++) {
      fs.writeFileSync(path.join(repo, 'alpha', 'status-notes', `2026-11-${String(day).padStart(2, '0')}-note.md`), '# Note');
    }
    const context = dash.loadMemoryProjects(repo);
    assert.equal(context.projects.length, 1);
    const project = context.projects[0];
    assert.match(project.errors.join('\n'), /README.md: path resolves outside/);
    assert.match(context.errors.join('\n'), /escaped-project: path resolves outside/);
    const doc = project.documents.find((d) => d.kind === 'dashboard');
    assert.ok(doc.truncated);
    assert.match(doc.content, /\[redacted\]/);
    assert.doesNotMatch(JSON.stringify(context), /person@example.org|Must not expose/);
    assert.equal(project.documents.filter((d) => d.kind === 'status').length, 10);
    assert.match(project.documents[1].path, /2026-11-12/);
  });

  it('distinguishes unconfigured memory, unavailable repos, and empty projects without hiding sessions', () => {
    const dash = loadDashboard(home);
    const sessions = [{ id: 's1', title: 'Live', project: 'alpha', status: 'active' }];
    const opts = { sessions, memoryRepo: '', enrichmentById: {} };
    const missing = dash.collectState(opts);
    assert.equal(missing.memory.configured, false);
    assert.equal(missing.projects[0].memory, null);
    const unavailable = dash.collectState({ ...opts, memoryRepo: path.join(home, 'missing') });
    assert.equal(unavailable.sessions.length, 1);
    assert.match(unavailable.memory.errors.join('\n'), /Cannot read memory repo/);
    const repo = path.join(home, 'empty-memory');
    fs.mkdirSync(path.join(repo, 'alpha'), { recursive: true });
    const empty = dash.collectState({ ...opts, memoryRepo: repo });
    assert.deepEqual(empty.projects[0].memory.documents, []);
    assert.equal(empty.projects[0].memory.summary, null);
    assert.deepEqual(empty.projects[0].memory.errors, []);
  });

  it('renders project context safely and embeds the offline document reader in HTML snapshots', () => {
    const dash = loadDashboard(home);
    const client = require('../templates/dashboard/dashboard');
    const project = {
      project: 'alpha',
      folder: 'alpha',
      summary: { moved: '<img src=x onerror=alert(1)>', blocked: '_None._' },
      documents: [{
        kind: 'status', date: '2026-11-16', title: '<script>unsafe</script>',
        path: 'alpha/status-notes/2026-11-16-note.md',
        content: '# Proposal\n</script><script>alert(1)</script>', truncated: false,
      }],
      errors: [],
    };
    const state = dash.aggregateDashboard({ memoryProjects: [project] });
    const markup = client.renderProjectMemory(state.projects[0], state.memory);
    assert.match(markup, /&lt;img/);
    assert.match(markup, /&lt;script&gt;/);
    assert.doesNotMatch(markup, /<img|<script>/);
    const html = dash.renderHtmlDocument(state);
    assert.match(html, /id="document-dialog"/);
    assert.match(html, /id="project-select"/);
    assert.match(html, /if \(snapshotData\)/);
    assert.doesNotMatch(html, /<script src=|<link rel="stylesheet"/);
    assert.doesNotMatch(html, /<\/script><script>alert\(1\)/);
    const data = html.match(/<script type="application\/json" id="aflt-dashboard-data">([\s\S]*?)<\/script>/);
    assert.deepEqual(JSON.parse(data[1]).projects[0].memory.documents, project.documents);
    assert.match(dash.renderSvg(state), /&lt;img/);
    assert.match(dash.renderSvg(state), /Doc Bot summary/);
  });

  it('renders Markdown structure, safe links and unique heading anchors', () => {
    const client = require('../templates/dashboard/dashboard');
    const html = client.renderMarkdown([
      '# Review', '', '## Review', '', '## Review-1', '',
      '**Bold**, *emphasis*, ~~removed~~ and `inline`.', '',
      '- First', '  - Nested', '', '1. Ordered', '2. Items', '',
      '> Quoted', '', '| Item | Status |', '| --- | --- |', '| Reader | Done |', '',
      '```js', 'const value = "<tag>";', '```', '',
      '[Web](https://example.com "Docs") and [note](status-notes/review.md#review).',
      '[reference][docs]', '', '[docs]: https://example.com/reference',
    ].join('\n'));
    assert.match(html, /<h1 id="document-heading-review">Review<\/h1>/);
    assert.match(html, /<h2 id="document-heading-review-1">Review<\/h2>/);
    assert.match(html, /<h2 id="document-heading-review-1-1">Review-1<\/h2>/);
    assert.match(html, /<strong>Bold<\/strong>/);
    assert.match(html, /<em>emphasis<\/em>/);
    assert.match(html, /<del>removed<\/del>/);
    assert.match(html, /<code>inline<\/code>/);
    assert.match(html, /<ul>[\s\S]*<ul>/);
    assert.match(html, /<ol>/);
    assert.match(html, /<blockquote>/);
    assert.match(html, /<table>[\s\S]*<th>Item<\/th>[\s\S]*<td>Done<\/td>/);
    assert.match(html, /<pre><code class="language-js">/);
    assert.match(html, /&lt;tag&gt;/);
    assert.match(html, /href="https:\/\/example.com" title="Docs" target="_blank" rel="noopener noreferrer"/);
    assert.match(html, /href="#" data-document-link="status-notes\/review.md#review"/);
    assert.match(html, /href="https:\/\/example.com\/reference"/);
  });

  it('keeps untrusted Markdown inert and never loads embedded images', () => {
    const client = require('../templates/dashboard/dashboard');
    const html = client.renderMarkdown([
      '<script>alert(1)</script>', '',
      '<img src="https://example.com/track" onerror="alert(1)">', '',
      '<iframe src="https://example.com"></iframe>', '',
      '![Tracking pixel](https://example.com/pixel)', '',
      '[Script](javascript:alert%281%29)', '',
      '[Encoded](java&#x73;cript:alert%281%29)', '',
      '[Data](data:text/html;base64,abc)', '',
      '[Network](//example.com/path)', '',
      '[Control](java%0ascript:alert%281%29)', '',
      '[Unsafe label <svg onload=alert(1)>](https://example.com)',
    ].join('\n'));
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;img/);
    assert.match(html, /\[Image: Tracking pixel\]/);
    assert.match(html, /&lt;svg/);
    assert.doesNotMatch(html, /<(?:script|img|iframe|svg)\b/i);
    assert.doesNotMatch(html, /\bhref="(?:javascript:|data:|\/\/)/i);
  });

  it('resolves document links only to included previews and handles invalid fragments explicitly', () => {
    const client = require('../templates/dashboard/dashboard');
    const projects = [{
      id: 'project:alpha',
      memory: { documents: [{ path: 'alpha/README.md' }, { path: 'alpha/status-notes/review.md' }] },
    }];
    assert.deepEqual(client.resolveDocumentLink(projects, 'alpha/status-notes/review.md', '../README.md#review'), {
      project: 'project:alpha', path: 'alpha/README.md', fragment: 'review',
    });
    assert.deepEqual(client.resolveDocumentLink(projects, 'alpha/README.md', '#review'), {
      project: 'project:alpha', path: 'alpha/README.md', fragment: 'review',
    });
    for (const href of ['../../secrets.md', 'missing.md', 'https://example.com', 'javascript:alert(1)', '#%ZZ', 'http://[']) {
      assert.equal(client.resolveDocumentLink(projects, 'alpha/README.md', href), null, href);
    }
  });

  it('limits project popups to the full escaped Doc Bot summary or missing-summary feedback', () => {
    const client = require('../templates/dashboard/dashboard');
    const project = {
      name: '<alpha>', displayState: 'idle', completion: { summary: 'Finished task' },
      memory: {
        summary: { moved: '<img src=x>' + 'x'.repeat(700), blocked: '<blocked>' },
        documents: [
          { kind: 'readme', title: 'README', content: 'Not a status note' },
          { kind: 'status', title: '<Latest>', content: '<script>unsafe</script>' + 'y'.repeat(400) },
          { kind: 'status', title: 'Older note', content: 'Outdated' },
        ],
        errors: ['<read error>'],
      },
    };
    const html = client.renderGraphHint(project);
    assert.match(html, /Doc Bot summary/);
    assert.match(html, /&lt;img src=x&gt;/);
    assert.ok(html.includes('x'.repeat(700)));
    assert.doesNotMatch(html, /alpha|Status:|Blocked|blocked|Latest|read error|<img|<script>|Older note|Not a status note|Finished task/);
    assert.match(client.renderGraphHint({ name: 'empty' }), /No Doc Bot summary recorded/);
    assert.equal(client.renderGraphHint(null, null), '');
  });

  it('limits session popups to escaped state, ID, engine, status and Herdr status', () => {
    const client = require('../templates/dashboard/dashboard');
    const html = client.renderGraphHint({
      name: 'project-private',
      memory: { summary: { moved: 'Project progress' }, documents: [{ kind: 'status', title: 'Long note' }] },
    }, {
      id: 'worker<id>', title: 'Session title', activityState: 'working', displayState: 'running',
      status: 'active', engine: '<copilot>', herdr: { runtime: '<running>' },
      completion: { summary: 'Long completion' },
    });
    assert.equal((html.match(/<p>/g) || []).length, 5);
    assert.match(html, /State: <strong>Working<\/strong>/);
    assert.match(html, /Session ID: <code>worker&lt;id&gt;<\/code>/);
    assert.match(html, /Engine: <strong>&lt;copilot&gt;<\/strong>/);
    assert.match(html, /<p>Status: <strong>active<\/strong>/);
    assert.match(html, /Herdr status: <strong>&lt;running&gt;<\/strong>/);
    assert.doesNotMatch(html, /project-private|Project progress|Long note|Session title|Long completion|Doc Bot|<copilot>|<running>/);
    const missing = client.renderGraphHint(null, { id: 'unreported', displayState: 'idle' });
    assert.match(missing, /State: <strong>idle<\/strong>/);
    assert.match(missing, /Herdr status: <strong>unknown<\/strong>/);
  });

  it('serves project documents through state/SSE and refreshes note edits without registry writes', async () => {
    const dash = loadDashboard(home);
    const repo = path.join(home, 'memory');
    fs.mkdirSync(path.join(repo, 'alpha', 'status-notes'), { recursive: true });
    const note = path.join(repo, 'alpha', 'status-notes', '2026-11-16-note.md');
    fs.writeFileSync(note, '# Proposal\nDraft');
    const handle = dash.createDashboardServer({
      sessions: [], memoryRepo: repo, enrichmentById: {},
      sseIntervalMs: 60_000, registryPollMs: 60_000,
    });
    await new Promise((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
    const port = handle.server.address().port;
    try {
      const state = JSON.parse((await httpGet(port, '/api/state')).body);
      assert.equal(state.projects[0].memory.documents[0].content, '# Proposal\nDraft');
      fs.writeFileSync(note, '# Proposal\nReviewed');
      handle.refresh('tick');
      const event = await httpSseOneEvent(port);
      const updated = JSON.parse(event.body.split('\n').find((l) => l.startsWith('data: ')).slice(6));
      assert.equal(updated.projects[0].memory.documents[0].content, '# Proposal\nReviewed');
      assert.equal(fs.existsSync(path.join(home, 'sessions.json')), false);
      assert.equal(fs.readFileSync(note, 'utf8'), '# Proposal\nReviewed');
    } finally {
      await handle.close();
    }
  });

  it('keeps graph interactions stable, renders offline docs and updates waiting markers over SSE', async () => {
    const dash = loadDashboard(home);
    const context = {
      project: 'alpha', folder: 'alpha', summary: null, errors: [],
      documents: [{
        path: 'alpha/README.md', kind: 'readme', title: 'Alpha',
        content: '# Alpha\n\n**Rendered**\n\n<script>not executable</script>',
      }],
    };
    const state = dash.aggregateDashboard({
      sessions: [
        { id: 'beta-session', title: 'Beta worker', project: 'beta', status: 'done' },
        { id: 'waiting-session', title: 'Needs input', project: 'alpha', parent: 'beta-session', status: 'active', workerStatus: 'waiting' },
        { id: 'pla-funnel-lifecycle-29c501', title: 'Long agent', project: 'alpha', status: 'done' },
      ],
      completionsById: {
        'beta-session': {
          eventId: 'finished-beta', sessionId: 'beta-session', sessionTitle: 'Beta worker',
          at: '2026-11-17T05:30:00.000Z', summary: '**Shipped Beta**\n\n<script>inert</script>',
          notePath: 'beta/status-notes/2026-11-17-task-complete.md',
        },
      },
      memoryProjects: [context, {
        project: 'beta', folder: 'beta', summary: { moved: 'Beta progress', blocked: '_None._' }, errors: [],
        documents: [
          { path: 'beta/README.md', kind: 'readme', title: 'Beta docs', content: '# Beta' },
          { path: 'beta/status-notes/review.md', kind: 'status', title: 'Review complete', content: 'Status: Analysis completed.' },
        ],
      }],
    });
    const elements = new Map();
    const frames = [];
    const timeouts = new Map();
    let nextTimeout = 0;
    const windowHandlers = {};
    function scheduleTimeout(callback, delay) {
      const id = ++nextTimeout;
      timeouts.set(id, { callback, delay });
      return id;
    }
    function flushTimeouts() {
      const pending = [...timeouts.values()];
      timeouts.clear();
      pending.forEach((timer) => timer.callback());
    }
    function makeElement(ns, tagName) {
      return {
        html: '', htmlWrites: 0, textContent: '', value: '', handlers: {}, open: false,
        get innerHTML() { return this.html; },
        set innerHTML(value) { this.htmlWrites++; this.html = value; },
        children: [], attributes: {}, parent: null, style: {}, hidden: false, tagName,
        get firstChild() { return this.children[0] || null; },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return this.attributes[name]; },
        appendChild(child) { this.children.push(child); child.parent = this; },
        removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parent = null; },
        getBoundingClientRect() { return { width: 800, height: 600 }; },
        addEventListener(type, listener) { this.handlers[type] = listener; },
        dispatch(type, event) {
          if (this.handlers[type]) this.handlers[type](event);
          if (!event.stopped && this.parent) this.parent.dispatch(type, event);
        },
        showModal() { this.open = true; },
        close() { this.open = false; },
        scrollIntoView() { this.scrolled = true; },
      };
    }
    function element(id) {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    }
    element('aflt-dashboard-data').textContent = JSON.stringify(state);
    element('graph-tooltip').getBoundingClientRect = () => ({ width: 320, height: 240 });
    element('graph').parent = element('stage');
    element('graph-tooltip').parent = element('stage');
    const browser = vm.createContext({
      document: { getElementById: element, createElementNS: makeElement },
      window: { addEventListener(type, handler) { windowHandlers[type] = handler; } },
      URL,
      matchMedia: () => ({ matches: true }),
      setInterval() {},
      setTimeout: scheduleTimeout,
      clearTimeout: (id) => timeouts.delete(id),
      requestAnimationFrame: (frame) => { frames.push(frame); return frames.length; },
      fetch() { assert.fail('offline snapshots must not fetch'); },
      EventSource() { assert.fail('offline snapshots must not open SSE'); },
    });
    const snapshotScripts = [...dash.renderHtmlDocument(state).matchAll(/<script>([\s\S]*?)<\/script>/g)];
    snapshotScripts.slice(1).forEach((script) => vm.runInContext(script[1], browser));
    assert.equal(element('project-select').value, 'project:alpha');
    assert.match(element('project-memory').innerHTML, /Alpha/);
    element('project-memory').handlers.click({
      target: { closest: () => ({ dataset: { documentPath: 'alpha/README.md' } }) },
    });
    assert.equal(element('document-dialog').open, true);
    assert.match(element('document-content').innerHTML, /<h1 id="document-heading-alpha">Alpha<\/h1>/);
    assert.match(element('document-content').innerHTML, /<strong>Rendered<\/strong>/);
    assert.match(element('document-content').innerHTML, /&lt;script&gt;not executable&lt;\/script&gt;/);
    element('document-toggle').handlers.click();
    assert.match(element('document-content').innerHTML, /<pre class="markdown-source"># Alpha/);
    assert.doesNotMatch(element('document-content').innerHTML, /<h1|<script>/);
    assert.equal(element('document-toggle').textContent, 'Render Markdown');
    element('document-toggle').handlers.click();
    assert.match(element('document-content').innerHTML, /<strong>Rendered<\/strong>/);
    element('document-content').handlers.click({
      target: { closest: () => ({ dataset: { documentLink: '../beta/README.md' } }) },
      preventDefault() {},
    });
    assert.equal(element('document-title').textContent, 'Beta docs');
    element('document-content').handlers.click({
      target: { closest: () => ({ dataset: { documentLink: 'missing.md' } }) },
      preventDefault() {},
    });
    assert.match(element('document-notice').textContent, /not included/);
    assert.equal(element('document-title').textContent, 'Beta docs');
    element('document-close').handlers.click();
    assert.equal(element('document-dialog').open, false);
    element('project-select').value = '';
    element('project-select').handlers.change();
    assert.match(element('project-memory').innerHTML, /Select a project/);

    frames.shift()();
    const graph = element('graph');
    const graphEdges = graph.children[1].children;
    assert.equal(graphEdges.length, 3);
    assert.deepEqual(graphEdges.map((edge) => edge.getAttribute('class')), ['edge project', 'edge parent', 'edge project']);
    const css = fs.readFileSync(path.join(__dirname, '../templates/dashboard/dashboard.css'), 'utf8');
    const edgeStyle = css.match(/\.edge\s*\{([^}]+)\}/)[1];
    assert.match(edgeStyle, /stroke:\s*var\(--cp-border-strong\)/);
    assert.match(edgeStyle, /stroke-width:\s*1\.4/);
    assert.doesNotMatch(css, /\.edge\.parent\s*\{[^}]*stroke-dasharray/);
    const nodeLayer = graph.children[2];
    const longSession = nodeLayer.children.find((n) => n.getAttribute('data-id') === 'pla-funnel-lifecycle-29c501');
    assert.equal(longSession.children[1].textContent, 'pla-funne...29c501');
    assert.match(longSession.getAttribute('aria-label'), /^pla-funnel-lifecycle-29c501/);
    longSession.dispatch('mouseenter', {});
    assert.match(element('graph-tooltip').innerHTML, /Session ID: <code>pla-funnel-lifecycle-29c501<\/code>/);
    const parentCircle = nodeLayer.children.find((n) => n.getAttribute('data-id') === 'beta-session').children[0];
    const workerCircle = nodeLayer.children.find((n) => n.getAttribute('data-id') === 'waiting-session').children[0];
    assert.equal(graphEdges[1].getAttribute('x1'), parentCircle.getAttribute('cx'));
    assert.equal(graphEdges[1].getAttribute('y1'), parentCircle.getAttribute('cy'));
    assert.equal(graphEdges[1].getAttribute('x2'), workerCircle.getAttribute('cx'));
    assert.equal(graphEdges[1].getAttribute('y2'), workerCircle.getAttribute('cy'));
    const beta = nodeLayer.children.find((n) => n.getAttribute('data-id') === 'project:beta');
    const betaCircle = beta.children[0];
    const betaLabel = beta.children[1];
    beta.dispatch('mouseenter', {});
    assert.equal(element('graph-tooltip').hidden, false);
    assert.match(element('graph-tooltip').innerHTML, /Doc Bot summary/);
    assert.match(element('graph-tooltip').innerHTML, /Beta progress/);
    assert.doesNotMatch(element('graph-tooltip').innerHTML, /Status:|Review complete|Analysis completed|Latest Task Complete/);
    assert.ok(parseFloat(element('graph-tooltip').style.left) >= 12);
    assert.ok(parseFloat(element('graph-tooltip').style.left) + 320 <= 788);
    assert.ok(parseFloat(element('graph-tooltip').style.top) >= 12);
    assert.ok(parseFloat(element('graph-tooltip').style.top) + 240 <= 588);
    frames.shift()();
    assert.equal(graph.children[2], nodeLayer);
    assert.equal(nodeLayer.children.find((n) => n.getAttribute('data-id') === 'project:beta'), beta);
    assert.equal(beta.children[0], betaCircle);
    assert.equal(beta.children[1], betaLabel);
    assert.deepEqual(beta.children.map((n) => n.tagName), ['circle', 'text']);
    assert.match(element('graph-tooltip').innerHTML, /Beta progress/);
    beta.dispatch('mouseleave', {});
    assert.equal(element('graph-tooltip').hidden, false);
    assert.equal([...timeouts.values()][0].delay, 450);
    element('graph-tooltip').dispatch('mouseenter', {});
    flushTimeouts();
    assert.equal(element('graph-tooltip').hidden, false);
    element('graph-tooltip').dispatch('click', { stopPropagation() { this.stopped = true; } });
    assert.equal(element('graph-tooltip').hidden, false);
    element('graph-tooltip').dispatch('mouseleave', {});
    flushTimeouts();
    assert.equal(element('graph-tooltip').hidden, true);
    beta.dispatch('focus', {});
    assert.equal(element('graph-tooltip').hidden, false);
    beta.dispatch('keydown', { key: 'Escape' });
    assert.equal(element('graph-tooltip').hidden, true);
    beta.dispatch('focus', {});
    beta.dispatch('blur', {});
    flushTimeouts();
    assert.equal(element('graph-tooltip').hidden, true);
    beta.dispatch('focus', {});
    element('graph-tooltip').dispatch('mouseenter', {});
    element('graph-tooltip').dispatch('mouseleave', {});
    flushTimeouts();
    assert.equal(element('graph-tooltip').hidden, true, 'popup rollout also clears a keyboard-focused hint');
    betaLabel.dispatch('click', { stopPropagation() { this.stopped = true; } });
    assert.equal(element('project-select').value, 'project:beta');
    assert.match(element('detail').innerHTML, /<h2>beta<\/h2>/);
    assert.match(element('detail').innerHTML, /Latest Task Complete/);
    assert.match(element('detail').innerHTML, /<strong>Shipped Beta<\/strong>/);
    assert.doesNotMatch(element('detail').innerHTML, /<script>inert<\/script>/);
    assert.match(element('project-memory').innerHTML, /Beta progress/);
    assert.match(element('project-memory').innerHTML, /Beta docs/);
    frames.shift()();
    assert.equal(beta.getAttribute('aria-pressed'), 'true');

    const alpha = nodeLayer.children.find((n) => n.getAttribute('data-id') === 'project:alpha');
    alpha.dispatch('mouseenter', {});
    assert.match(element('graph-tooltip').innerHTML, /No Doc Bot summary recorded/);
    assert.doesNotMatch(element('graph-tooltip').innerHTML, /Beta progress/);
    alpha.dispatch('mouseleave', {});
    alpha.children[0].dispatch('click', { stopPropagation() { this.stopped = true; } });
    assert.equal(element('project-select').value, 'project:alpha');
    assert.match(element('project-memory').innerHTML, /Alpha/);
    const session = nodeLayer.children.find((n) => n.getAttribute('data-id') === 'beta-session');
    assert.equal(session.children[1].textContent, 'beta-session');
    assert.equal(session.children[1].getAttribute('visibility'), 'visible');
    assert.equal(session.children[1].getAttribute('class'), 'session-label');
    assert.equal(session.children[1].getAttribute('y'), String(Number(session.children[0].getAttribute('cy')) + 22));
    session.dispatch('dblclick', { stopPropagation() { this.stopped = true; } });
    assert.match(element('action-status').textContent, /live local dashboard/);
    assert.match(session.children[0].getAttribute('class'), /completed/);
    assert.match(session.children[0].getAttribute('style'), /--cp-link/);
    assert.match(session.getAttribute('aria-label'), /Completed/);
    session.dispatch('mouseenter', {});
    assert.match(element('graph-tooltip').innerHTML, /Session ID: <code>beta-session<\/code>/);
    assert.match(element('graph-tooltip').innerHTML, /State: <strong>Completed<\/strong>/);
    assert.doesNotMatch(element('graph-tooltip').innerHTML, /Beta worker|Project: beta|Beta progress|Latest Task Complete/);
    session.dispatch('keydown', {
      key: 'Enter', preventDefault() {}, stopPropagation() { this.stopped = true; },
    });
    assert.equal(element('project-select').value, 'project:beta');
    assert.match(element('detail').innerHTML, /Beta worker/);
    assert.match(element('detail').innerHTML, /Captured in project docs/);
    assert.match(element('detail').innerHTML, /<strong>Shipped Beta<\/strong>/);

    const waiting = nodeLayer.children.find((n) => n.getAttribute('data-id') === 'waiting-session');
    assert.equal(waiting.children[2].getAttribute('visibility'), 'visible');
    assert.match(waiting.getAttribute('aria-label'), /Awaiting input/);
    assert.match(waiting.children[0].getAttribute('class'), /awaiting-input/);
    waiting.dispatch('mouseenter', {});
    assert.match(element('graph-tooltip').innerHTML, /State: <strong>Awaiting input<\/strong>/);
    waiting.dispatch('click', { stopPropagation() { this.stopped = true; } });
    assert.match(element('detail').innerHTML, /class="badge waiting">Awaiting input/);

    graph.children = [];
    frames.length = 0;
    timeouts.clear();
    let source;
    const focusRequests = [];
    let focusError = null;
    state.actions = { herdrFocusToken: 'test-action-token' };
    const liveBrowser = vm.createContext({
      document: {
        getElementById: (id) => id === 'aflt-dashboard-data' ? null : element(id),
        createElementNS: makeElement,
      },
      window: { addEventListener(type, handler) { windowHandlers[type] = handler; } }, URL,
      matchMedia: () => ({ matches: true }), setInterval() {},
      setTimeout: scheduleTimeout, clearTimeout: (id) => timeouts.delete(id),
      requestAnimationFrame: (frame) => { frames.push(frame); return frames.length; },
      fetch: async (url, opts) => {
        if (!opts) return { json: async () => state };
        focusRequests.push({ url, opts });
        return { ok: !focusError, json: async () => focusError ? { error: focusError } : { ok: true } };
      },
      EventSource: function () { source = this; },
    });
    snapshotScripts.slice(1).forEach((script) => vm.runInContext(script[1], liveBrowser));
    await new Promise((resolve) => setImmediate(resolve));
    frames.shift()();
    const liveNode = graph.children[2].children.find((n) => n.getAttribute('data-id') === 'waiting-session');
    assert.equal(liveNode.children[2].getAttribute('visibility'), 'visible');
    liveNode.dispatch('click', { stopPropagation() { this.stopped = true; } });
    assert.equal(focusRequests.length, 0);
    liveNode.dispatch('dblclick', { stopPropagation() { this.stopped = true; } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(focusRequests.length, 1);
    assert.equal(focusRequests[0].url, '/api/herdr/focus/waiting-session');
    assert.equal(focusRequests[0].opts.method, 'POST');
    assert.equal(focusRequests[0].opts.headers['X-Aflt-Action-Token'], 'test-action-token');
    assert.match(element('action-status').textContent, /Selected Needs input in Herdr/);
    focusError = 'No unique live Herdr terminal';
    liveNode.dispatch('dblclick', { stopPropagation() { this.stopped = true; } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(element('action-status').textContent, /No unique live Herdr terminal/);
    assert.equal(element('action-status').getAttribute('class'), 'action-status error');
    const liveProject = graph.children[2].children.find((n) => n.getAttribute('data-id') === 'project:alpha');
    assert.equal(liveProject.handlers.dblclick, undefined);
    const liveLongSession = graph.children[2].children.find((n) => n.getAttribute('data-id') === 'pla-funnel-lifecycle-29c501');
    liveLongSession.dispatch('dblclick', { stopPropagation() { this.stopped = true; } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(focusRequests.at(-1).url, '/api/herdr/focus/pla-funnel-lifecycle-29c501');
    const liveSession = state.sessions.find((s) => s.id === 'waiting-session');
    liveSession.awaitingInput = false;
    liveSession.activityState = 'working';
    source.onmessage({ data: JSON.stringify(state) });
    frames.shift()();
    assert.equal(graph.children[2].children.find((n) => n.getAttribute('data-id') === 'waiting-session'), liveNode);
    assert.equal(liveNode.children[2].getAttribute('visibility'), 'hidden');
    assert.doesNotMatch(liveNode.getAttribute('aria-label'), /Awaiting input/);
    assert.doesNotMatch(liveNode.children[0].getAttribute('class'), /awaiting-input/);
    const spinner = liveNode.children[3];
    assert.equal(spinner.getAttribute('visibility'), 'visible');
    assert.equal(spinner.getAttribute('pathLength'), '100');
    assert.match(liveNode.children[0].getAttribute('class'), /working/);
    assert.match(liveNode.getAttribute('aria-label'), /Working/);
    liveNode.dispatch('mouseenter', {});
    assert.match(element('graph-tooltip').innerHTML, /State: <strong>Working<\/strong>/);
    liveNode.dispatch('mouseleave', {});
    element('graph-tooltip').dispatch('mouseenter', {});
    flushTimeouts();
    const tooltipWrites = element('graph-tooltip').htmlWrites;
    liveNode.dispatch('click', { stopPropagation() { this.stopped = true; } });
    assert.match(element('detail').innerHTML, /class="badge working">Working/);

    liveSession.activityState = 'completed';
    liveSession.completion = {
      eventId: 'finished-live', sessionId: 'waiting-session', sessionTitle: 'Needs input',
      at: '2026-11-17T05:40:00.000Z', summary: '**Finished task**',
    };
    source.onmessage({ data: JSON.stringify(state) });
    frames.shift()();
    assert.equal(graph.children[2].children.find((n) => n.getAttribute('data-id') === 'waiting-session'), liveNode);
    assert.equal(liveNode.children[3], spinner);
    assert.equal(spinner.getAttribute('visibility'), 'hidden');
    assert.equal(liveNode.children[2].getAttribute('visibility'), 'hidden');
    assert.match(liveNode.children[0].getAttribute('class'), /completed/);
    assert.match(liveNode.children[0].getAttribute('style'), /--cp-link/);
    assert.match(liveNode.getAttribute('aria-label'), /Completed/);
    assert.match(element('graph-tooltip').innerHTML, /State: <strong>Working<\/strong>/);
    assert.equal(element('graph-tooltip').htmlWrites, tooltipWrites, 'refresh must not replace selectable popup text');
    element('graph-tooltip').dispatch('mouseleave', {});
    liveNode.dispatch('mouseenter', {});
    flushTimeouts();
    assert.equal(element('graph-tooltip').hidden, false);
    assert.match(element('graph-tooltip').innerHTML, /State: <strong>Completed<\/strong>/);
    assert.match(element('detail').innerHTML, /class="badge completed">Completed/);
    assert.match(element('detail').innerHTML, /<strong>Finished task<\/strong>/);
    assert.doesNotMatch(element('graph-tooltip').innerHTML, /Latest Task Complete|Finished task/);

    liveSession.activityState = 'waiting';
    liveSession.awaitingInput = true;
    source.onmessage({ data: JSON.stringify(state) });
    frames.shift()();
    assert.equal(spinner.getAttribute('visibility'), 'hidden');
    assert.equal(liveNode.children[2].getAttribute('visibility'), 'visible');
    assert.doesNotMatch(liveNode.children[0].getAttribute('class'), /completed/);
    liveNode.dispatch('mouseleave', {});
    liveNode.dispatch('focus', {});
    element('graph-tooltip').dispatch('mouseenter', {});
    graph.dispatch('click', {});
    assert.equal(element('graph-tooltip').hidden, true, 'empty SVG background closes even a focused popup');
    source.onmessage({ data: JSON.stringify(state) });
    frames.shift()();
    flushTimeouts();
    assert.equal(element('graph-tooltip').hidden, true, 'refresh must not reopen a dismissed popup');
    liveNode.dispatch('mouseenter', {});
    liveNode.dispatch('mouseleave', {});
    element('stage').dispatch('click', {});
    flushTimeouts();
    assert.equal(element('graph-tooltip').hidden, true, 'empty stage clears pending popup dismissal');
    liveNode.dispatch('mouseenter', {});
    windowHandlers.keydown({ key: 'Escape' });
    assert.equal(element('graph-tooltip').hidden, true);
  });

  it('HTTP serve: /, /api/state, /events; read-only on registry', async () => {
    seedSession(home, {
      title: 'dash-alpha',
      project: 'alpha',
      engine: 'cursor',
      status: 'active',
      lastUsed: new Date().toISOString(),
      created: new Date().toISOString(),
    });
    seedSession(home, {
      title: 'dash-beta-fail',
      project: 'beta',
      engine: 'copilot',
      status: 'done',
      lastExit: 1,
      lastError: 'nope',
      lastUsed: '2024-01-01T00:00:00.000Z',
      created: '2024-01-01T00:00:00.000Z',
    });

    const dash = loadDashboard(home);
    const registry = require('../lib/registry');
    let saveCalls = 0;
    let updateCalls = 0;
    let addCalls = 0;
    const origSave = registry.save;
    const origUpdate = registry.update;
    const origAdd = registry.add;
    registry.save = (...args) => {
      saveCalls += 1;
      return origSave(...args);
    };
    registry.update = (...args) => {
      updateCalls += 1;
      return origUpdate(...args);
    };
    registry.add = (...args) => {
      addCalls += 1;
      return origAdd(...args);
    };

    const handle = dash.createDashboardServer({
      sseIntervalMs: 60_000,
      registryPollMs: 60_000,
      herdrFetch: { ok: false, error: 'stub', terminals: [], checkedAt: new Date().toISOString() },
    });

    await new Promise((resolve, reject) => {
      handle.server.once('error', reject);
      handle.server.listen(0, '127.0.0.1', resolve);
    });
    const port = handle.server.address().port;

    try {
      const index = await httpGet(port, '/');
      assert.equal(index.status, 200);
      assert.match(index.body, /aflt live/);
      assert.match(index.headers['content-type'] || '', /text\/html/);
      assert.match(index.body, /<script src="\/marked.min.js"><\/script>/);
      const parser = await httpGet(port, '/marked.min.js');
      assert.equal(parser.status, 200);
      assert.match(parser.headers['content-type'] || '', /javascript/);

      const api = await httpGet(port, '/api/state');
      assert.equal(api.status, 200);
      const payload = JSON.parse(api.body);
      assert.ok(payload.sessions.some((s) => s.title === 'dash-alpha'));
      assert.ok(payload.sessions.some((s) => s.title === 'dash-beta-fail'));
      assert.ok(payload.projects.some((p) => p.name === 'alpha'));

      const sse = await httpSseOneEvent(port);
      assert.match(sse.body, /^data: /m);
      const line = sse.body.split('\n').find((l) => l.startsWith('data: '));
      const ssePayload = JSON.parse(line.slice(6));
      assert.ok(ssePayload.sessions.some((s) => s.title === 'dash-alpha'));

      assert.equal(saveCalls, 0);
      assert.equal(updateCalls, 0);
      assert.equal(addCalls, 0);
    } finally {
      registry.save = origSave;
      registry.update = origUpdate;
      registry.add = origAdd;
      await handle.close();
    }
  });

  it('snapshot stamp is America/New_York (ET), not UTC', () => {
    const dash = loadDashboard(home);
    const utcWinter = '2026-11-16T00:52:17.000Z'; // 19:52:17 ET (EST, UTC-5)
    const utcSummer = '2026-06-15T00:52:17.000Z'; // 20:52:17 ET (EDT, UTC-4)
    assert.equal(dash.formatSnapshotStamp(utcWinter), '2026-11-15 19:52:17 ET');
    assert.equal(dash.formatSnapshotStamp(utcSummer), '2026-06-14 20:52:17 ET');
    assert.equal(dash.formatSnapshotStamp(new Date(utcWinter)), '2026-11-15 19:52:17 ET');
    assert.equal(dash.formatSnapshotStamp('not-a-date'), '');

    const svg = dash.renderSvg({
      generatedAt: utcWinter,
      stats: { activeProjects: 0, runningSessions: 0, engines: {} },
      projects: [],
      sessions: [],
      events: [],
      sparkline24h: [],
      sparkline7d: [],
      links: [],
    });
    assert.match(svg, /local · snapshot 2026-11-15 19:52:17 ET/);
    assert.doesNotMatch(svg, /2026-11-16 00:52:17/);
  });

  it('snapshot writes .svg and .html with seeded labels', () => {
    const session = seedSession(home, {
      title: 'snap-session',
      project: 'snapproj',
      engine: 'cursor',
      status: 'done',
      lastExit: 0,
      lastUsed: '2024-06-01T00:00:00.000Z',
      created: '2024-06-01T00:00:00.000Z',
    });
    const dash = loadDashboard(home);
    const state = dash.collectState({
      herdrFetch: { ok: false, error: 'stub', terminals: [], checkedAt: '2024-06-01T00:00:00.000Z' },
    });

    const svgPath = path.join(home, 'out', 'dash.svg');
    const htmlPath = path.join(home, 'out', 'dash.html');
    dash.writeSnapshot(svgPath, state);
    dash.writeSnapshot(htmlPath, state);

    const svg = fs.readFileSync(svgPath, 'utf8');
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(svg.length > 100);
    assert.ok(html.length > 100);
    assert.match(svg, /snapproj/);
    assert.match(svg, /aflt live/);
    assert.ok(svg.includes(`>${state.sessions.find((s) => s.id === session.id).nodeLabel}</text>`));
    assert.ok(svg.includes(`Session ID: ${session.id}\nEngine: cursor\nStatus: done\nHerdr status:`));
    assert.match(html, /snapproj|snap-session/);
    assert.match(html, /<svg/);

    assert.throws(
      () => dash.writeSnapshot(path.join(home, 'out', 'dash.png'), state),
      /unsupported snapshot extension/
    );
  });

  it('CLI snapshot via aflt dashboard --snapshot', () => {
    seedSession(home, {
      title: 'cli-snap',
      project: 'cliproj',
      status: 'done',
      lastExit: 0,
      lastUsed: '2024-06-01T00:00:00.000Z',
      created: '2024-06-01T00:00:00.000Z',
    });
    const out = path.join(home, 'cli.svg');
    const r = af(['dashboard', '--snapshot', out, '--json'], env());
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.ok(fs.existsSync(out));
    assert.match(fs.readFileSync(out, 'utf8'), /cliproj/);
  });

  it('captures native completion messages over live SSE and exposes their notes without changing the registry', async () => {
    const session = seedSession(home, { title: 'Feature', project: 'alpha', engine: 'copilot', status: 'active' });
    const repo = path.join(home, 'memory');
    fs.mkdirSync(repo);
    const source = path.join(process.env.AGENTFLEET_COPILOT_HOME, 'session-state', session.chatId, 'events.jsonl');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    const registryFile = path.join(home, 'sessions.json');
    const before = fs.readFileSync(registryFile, 'utf8');
    const dash = loadDashboard(home);
    const handle = dash.createDashboardServer({
      sessions: [session], memoryRepo: repo, enrichmentById: {}, isAlive: () => false,
      captureCompletions: true, sseIntervalMs: 20,
    });
    await new Promise((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
    const port = handle.server.address().port;
    try {
      const initial = JSON.parse((await httpGet(port, '/api/state')).body);
      assert.equal(initial.sessions[0].completion, null);
      const update = httpSseOneEvent(port, (frame) => frame.includes('new-completion'));
      fs.writeFileSync(source, JSON.stringify({
        type: 'session.task_complete', id: 'new-completion', timestamp: '2026-11-17T05:30:01.000Z',
        data: { success: true, summary: 'Shipped **the feature**.' },
      }) + '\n');
      const message = await update;
      const state = JSON.parse(message.body.split('\n').find((line) => line.startsWith('data: ')).slice(6));
      const completion = state.sessions[0].completion;
      assert.equal(completion.summary, 'Shipped **the feature**.');
      assert.equal(state.projects[0].completion.eventId, completion.eventId);
      assert.equal(state.completions.captureEnabled, true);
      assert.deepEqual(state.completions.errors, []);
      assert.deepEqual(state.stats, initial.stats);
      assert.ok(fs.existsSync(path.join(repo, completion.notePath)));
      assert.ok(state.projects[0].memory.documents.some((doc) =>
        doc.path === completion.notePath && doc.content.includes(completion.summary)));
      assert.match(dash.renderHtmlDocument(state), /Shipped \*\*the feature\*\*/);
      assert.doesNotMatch(dash.renderSvg(state), /Latest Task Complete/);
      assert.equal(fs.readFileSync(registryFile, 'utf8'), before);
    } finally {
      await handle.close();
    }
  });

  it('rejects capture for snapshots or without a configured memory repo', () => {
    const out = path.join(home, 'never-written.html');
    const snapshot = af(['dashboard', '--snapshot', out, '--capture-completions', '--json'], env());
    assert.equal(snapshot.status, 1);
    assert.match(snapshot.stderr + snapshot.stdout, /requires --serve/);
    assert.equal(fs.existsSync(out), false);
    const missing = af(['dashboard', '--serve', '--capture-completions', '--json'], env());
    assert.equal(missing.status, 1);
    assert.match(missing.stderr + missing.stdout, /requires a memory repo/);
  });

  it('CLI usage error without --serve or --snapshot', () => {
    const r = af(['dashboard'], env());
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--serve|--snapshot/);
  });
});
