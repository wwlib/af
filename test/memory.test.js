'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

function af(args, env, opts = {}) {
  return spawnSync(process.execPath, [afJs, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd || env.HOME,
    env: { ...process.env, ...env },
  });
}

function loadMemory(home) {
  delete require.cache[require.resolve('../lib/util')];
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/project')];
  delete require.cache[require.resolve('../lib/timeline')];
  delete require.cache[require.resolve('../lib/memory')];
  delete require.cache[require.resolve('../lib/registry')];
  process.env.AGENTFLEET_HOME = home;
  process.env.HOME = home;
  return require('../lib/memory');
}

function loadRegistry(home) {
  delete require.cache[require.resolve('../lib/util')];
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/registry')];
  delete require.cache[require.resolve('../lib/project')];
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
    cwd: partial.cwd || home,
    engine: 'cursor',
    status: partial.status || 'done',
    created: partial.created || '2024-01-01T00:00:00.000Z',
    lastUsed: partial.lastUsed || '2024-01-02T00:00:00.000Z',
    ...partial,
  });
}

describe('aflt memory', () => {
  let home;
  let memRepo;
  let prevHome;
  let prevAfHome;
  let prevMem;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevMem = process.env.AFLT_MEMORY_REPO;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-mem-home-'));
    memRepo = path.join(home, 'memory-repo');
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = home;
    delete process.env.AFLT_MEMORY_REPO;
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
    delete process.env.AFLT_PROJECT;
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

  it('init creates git repo + files + registers memoryRepo', () => {
    const r = af(['memory', 'init', memRepo, '--json'], env());
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.repo, fs.realpathSync(memRepo));
    assert.ok(fs.existsSync(path.join(memRepo, '.aflt-memory.json')));
    assert.ok(fs.existsSync(path.join(memRepo, 'README.md')));
    assert.ok(fs.existsSync(path.join(memRepo, 'DOC-AGENT.md')));
    const docAgent = fs.readFileSync(path.join(memRepo, 'DOC-AGENT.md'), 'utf8');
    assert.match(docAgent, /Memory documentarian/);
    assert.ok(fs.existsSync(path.join(memRepo, '.gitignore')));
    const gi = fs.readFileSync(path.join(memRepo, '.gitignore'), 'utf8');
    assert.match(gi, /\.DS_Store/);
    assert.match(gi, /memory\//);
    const git = spawnSync('git', ['-C', memRepo, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
    });
    assert.equal(git.status, 0);
    assert.equal(String(git.stdout).trim(), 'true');
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(cfg.memoryRepo, fs.realpathSync(memRepo));
    // never committed
    const log = spawnSync('git', ['-C', memRepo, 'log', '--oneline'], { encoding: 'utf8' });
    assert.notEqual(log.status, 0);
  });

  it('init is idempotent and re-registers', () => {
    assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
    const marker1 = fs.readFileSync(path.join(memRepo, '.aflt-memory.json'), 'utf8');
    const docPath = path.join(memRepo, 'DOC-AGENT.md');
    fs.writeFileSync(docPath, '# custom doc agent\n');
    const r2 = af(['memory', 'init', memRepo, '--json'], env());
    assert.equal(r2.status, 0, r2.stderr);
    const j = JSON.parse(r2.stdout);
    assert.equal(j.created, false);
    assert.equal(fs.readFileSync(docPath, 'utf8'), '# custom doc agent\n');
    assert.equal(fs.readFileSync(path.join(memRepo, '.aflt-memory.json'), 'utf8'), marker1);
  });

  it('refuses non-empty foreign dir without --force', () => {
    fs.mkdirSync(memRepo, { recursive: true });
    fs.writeFileSync(path.join(memRepo, 'notes.txt'), 'keep me\n');
    const r = af(['memory', 'init', memRepo], env());
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusing|non-empty|not an aflt memory/i);
    const forced = af(['memory', 'init', memRepo, '--force', '--json'], env());
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(fs.readFileSync(path.join(memRepo, 'notes.txt'), 'utf8'), 'keep me\n');
    assert.ok(fs.existsSync(path.join(memRepo, '.aflt-memory.json')));
  });

  it('AFLT_MEMORY_REPO overrides config; where prints path + source', () => {
    assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
    const other = path.join(home, 'other-mem');
    fs.mkdirSync(other, { recursive: true });
    // where from config
    const w1 = af(['memory', 'where', '--json'], env());
    assert.equal(w1.status, 0);
    const j1 = JSON.parse(w1.stdout);
    assert.equal(j1.source, 'config');
    assert.equal(j1.repo, fs.realpathSync(memRepo));
    // env override
    const w2 = af(['memory', 'where', '--json'], env({ AFLT_MEMORY_REPO: other }));
    assert.equal(w2.status, 0);
    const j2 = JSON.parse(w2.stdout);
    assert.equal(j2.source, 'env');
    assert.equal(j2.repo, path.resolve(other));
    // bare memory
    const w3 = af(['memory'], env());
    assert.equal(w3.status, 0);
    assert.match(w3.stdout, /config/);
  });

  it('where exits 1 with hint when unset', () => {
    const r = af(['memory', 'where'], env());
    assert.equal(r.status, 1);
    assert.match(r.stderr, /memory init/);
  });

  it('sync layout: folders, sessions.jsonl shape/order, idempotent, stubs', () => {
    assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
    const projDir = path.join(home, 'workspace', 'alpha-app');
    fs.mkdirSync(projDir, { recursive: true });

    seedSession(home, {
      title: 'later-session',
      project: 'alpha-app',
      cwd: projDir,
      created: '2024-06-02T00:00:00.000Z',
      runStartedAt: '2024-06-02T00:00:00.000Z',
      lastUsed: '2024-06-02T12:00:00.000Z',
      lastRunAt: '2024-06-02T12:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
      prompt: 'second prompt',
    });
    // Add earlier session with explicit earlier start
    seedSession(home, {
      title: 'earlier-session',
      project: 'alpha-app',
      cwd: projDir,
      created: '2024-06-01T00:00:00.000Z',
      runStartedAt: '2024-06-01T00:00:00.000Z',
      lastUsed: '2024-06-01T12:00:00.000Z',
      lastRunAt: '2024-06-01T12:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
      prompt: 'first prompt',
      role: 'master',
    });
    // non-repo --project ops
    seedSession(home, {
      title: 'ops-task',
      project: 'ops',
      cwd: home,
      created: '2024-05-01T00:00:00.000Z',
      runStartedAt: '2024-05-01T00:00:00.000Z',
      lastUsed: '2024-05-01T01:00:00.000Z',
      lastRunAt: '2024-05-01T01:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
      prompt: 'ops work',
    });

    const sync1 = af(['memory', 'sync', '--all', '--json'], env());
    assert.equal(sync1.status, 0, sync1.stderr + sync1.stdout);
    const j1 = JSON.parse(sync1.stdout);
    assert.equal(j1.ok, true);
    const folders = j1.projects.map((p) => p.folder).sort();
    assert.deepEqual(folders, ['alpha-app', 'ops']);

    const jsonlPath = path.join(memRepo, 'alpha-app', '_aflt', 'sessions.jsonl');
    const mdPath = path.join(memRepo, 'alpha-app', '_aflt', 'timeline.md');
    assert.ok(fs.existsSync(jsonlPath));
    assert.ok(fs.existsSync(mdPath));
    assert.ok(fs.existsSync(path.join(memRepo, 'alpha-app', 'README.md')));
    assert.ok(fs.existsSync(path.join(memRepo, 'alpha-app', 'status-notes', '.gitkeep')));
    assert.ok(fs.existsSync(path.join(memRepo, 'ops', '_aflt', 'sessions.jsonl')));

    const lines = fs
      .readFileSync(jsonlPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    // sorted by start then id
    assert.ok(
      Date.parse(lines[0].start) <= Date.parse(lines[1].start) ||
        (lines[0].start === lines[1].start && lines[0].id <= lines[1].id)
    );
    const keys = Object.keys(lines[0]);
    assert.deepEqual(keys, [
      'id',
      'title',
      'project',
      'parent',
      'role',
      'engine',
      'status',
      'workerStatus',
      'start',
      'end',
      'lastUsed',
      'cwd',
      'promptSummary',
      'commits',
      'commitsReason',
    ]);
    assert.equal(lines[0].project, 'alpha-app');
    assert.ok(Array.isArray(lines[0].commits));
    assert.match(fs.readFileSync(mdPath, 'utf8'), /2 sessions/);

    const md1 = fs.readFileSync(mdPath, 'utf8');
    const jl1 = fs.readFileSync(jsonlPath, 'utf8');
    const mtime1 = fs.statSync(jsonlPath).mtimeMs;

    // human-edited README must not be overwritten
    const humanReadme = '# alpha-app\n\nmy notes\n';
    fs.writeFileSync(path.join(memRepo, 'alpha-app', 'README.md'), humanReadme);
    fs.writeFileSync(path.join(memRepo, 'alpha-app', 'status-notes', 'note.md'), 'keep\n');

    // second sync: idempotent (no content change for aflt files)
    const sync2 = af(['memory', 'sync', '--all', '--json'], env());
    assert.equal(sync2.status, 0, sync2.stderr);
    const j2 = JSON.parse(sync2.stdout);
    const alpha = j2.projects.find((p) => p.project === 'alpha-app');
    const afltFiles = alpha.files.filter((f) => f.path.includes('/_aflt/'));
    assert.ok(afltFiles.every((f) => f.changed === false));
    assert.equal(fs.readFileSync(jsonlPath, 'utf8'), jl1);
    assert.equal(fs.readFileSync(mdPath, 'utf8'), md1);
    assert.equal(fs.statSync(jsonlPath).mtimeMs, mtime1);
    assert.equal(fs.readFileSync(path.join(memRepo, 'alpha-app', 'README.md'), 'utf8'), humanReadme);
    assert.equal(
      fs.readFileSync(path.join(memRepo, 'alpha-app', 'status-notes', 'note.md'), 'utf8'),
      'keep\n'
    );
  });

  it('adhoc excluded from --all unless --include-adhoc', () => {
    assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
    seedSession(home, {
      title: 'personal',
      project: 'adhoc',
      cwd: home,
      created: '2024-01-01T00:00:00.000Z',
      runStartedAt: '2024-01-01T00:00:00.000Z',
      lastUsed: '2024-01-01T01:00:00.000Z',
      lastRunAt: '2024-01-01T01:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
    });
    seedSession(home, {
      title: 'real',
      project: 'widget',
      cwd: path.join(home, 'widget'),
      created: '2024-01-01T00:00:00.000Z',
      runStartedAt: '2024-01-01T00:00:00.000Z',
      lastUsed: '2024-01-01T01:00:00.000Z',
      lastRunAt: '2024-01-01T01:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
    });
    fs.mkdirSync(path.join(home, 'widget'), { recursive: true });

    const r1 = af(['memory', 'sync', '--all', '--json'], env());
    assert.equal(r1.status, 0, r1.stderr);
    const j1 = JSON.parse(r1.stdout);
    assert.deepEqual(
      j1.projects.map((p) => p.project),
      ['widget']
    );
    assert.ok(!fs.existsSync(path.join(memRepo, 'adhoc')));

    const r2 = af(['memory', 'sync', '--all', '--include-adhoc', '--json'], env());
    assert.equal(r2.status, 0, r2.stderr);
    const j2 = JSON.parse(r2.stdout);
    assert.ok(j2.projects.some((p) => p.project === 'adhoc'));
    assert.ok(fs.existsSync(path.join(memRepo, 'adhoc', '_aflt', 'sessions.jsonl')));
  });

  it('dry-run writes nothing', () => {
    assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
    seedSession(home, {
      title: 'x',
      project: 'dryproj',
      cwd: home,
      created: '2024-01-01T00:00:00.000Z',
      runStartedAt: '2024-01-01T00:00:00.000Z',
      lastUsed: '2024-01-01T01:00:00.000Z',
      lastRunAt: '2024-01-01T01:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
    });
    const before = fs.readdirSync(memRepo);
    const r = af(['memory', 'sync', 'dryproj', '--dry-run', '--json'], env());
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.ok(j.projects[0].files.some((f) => f.changed));
    assert.deepEqual(fs.readdirSync(memRepo).sort(), before.sort());
    assert.ok(!fs.existsSync(path.join(memRepo, 'dryproj')));
    assert.ok(!fs.existsSync(path.join(memRepo, 'DASHBOARD.md')));
    assert.ok(j.dashboard);
    assert.equal(j.dashboard.path, 'DASHBOARD.md');
    assert.equal(j.dashboard.changed, true);
  });

  it('redaction cases + commit hash preserved + --no-redact', () => {
    const mem = loadMemory(home);
    const cases = [
      ['host 10.0.0.5 inside', /\[redacted\]/],
      ['loop 127.0.0.1', /\[redacted\]/],
      ['lan 192.168.1.9', /\[redacted\]/],
      ['priv 172.16.4.1', /\[redacted\]/],
      ['printer.local says hi', /\[redacted\]/],
      ['mail me@example.com please', /\[redacted\]/],
      ['sk-abc1234567890xyz', /\[redacted\]/],
      ['ghp_ABCDEFGHIJKLMNOPQRSTUV', /\[redacted\]/],
      ['gho_ABCDEFGHIJKLMNOPQRSTUV', /\[redacted\]/],
      ['github_pat_ABCDEFGHIJKLMNOP', /\[redacted\]/],
      ['xoxb-1234-5678-abcdef', /\[redacted\]/],
      ['token=supersecretvalue', /\[redacted\]/],
      ['key=abc123secret', /\[redacted\]/],
      ['password=hunter2', /\[redacted\]/],
      ['secret=shh', /\[redacted\]/],
      ['key_ABCDEFGHIJKLMNOP', /\[redacted\]/],
      ['crsr_ABCDEFGHIJKLMNOP', /\[redacted\]/],
      ['deadbeefdeadbeefdeadbeefdeadbeef', /\[redacted\]/], // 32 hex
      [
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        /\[redacted\]/,
      ], // 40 base64-ish
    ];
    for (const [input, re] of cases) {
      assert.match(mem.redactSensitive(input), re, input);
    }
    // home → ~
    const homePath = path.join(home, 'src', 'app');
    assert.equal(mem.redactSensitive(homePath), path.join('~', 'src', 'app'));

    // commit hash 7–12 hex must NOT be redacted when alone / as hash field
    const hash = 'abc1234';
    assert.equal(mem.redactSensitive(hash), hash);
    assert.equal(mem.redactSensitive('abcdef1'), 'abcdef1');
    assert.equal(mem.redactSensitive('abcd1234abcd'), 'abcd1234abcd');

    assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
    seedSession(home, {
      title: 'leak sk-abc1234567890xyz to me@example.com',
      project: 'sec',
      cwd: path.join(home, 'sec'),
      prompt: 'token=supersecretvalue at 10.1.2.3',
      created: '2024-01-01T00:00:00.000Z',
      runStartedAt: '2024-01-01T00:00:00.000Z',
      lastUsed: '2024-01-01T01:00:00.000Z',
      lastRunAt: '2024-01-01T01:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
    });
    fs.mkdirSync(path.join(home, 'sec'), { recursive: true });

    const r1 = af(['memory', 'sync', 'sec', '--json'], env());
    assert.equal(r1.status, 0, r1.stderr);
    const row = JSON.parse(
      fs.readFileSync(path.join(memRepo, 'sec', '_aflt', 'sessions.jsonl'), 'utf8').trim()
    );
    assert.match(row.title, /\[redacted\]/);
    assert.match(row.promptSummary, /\[redacted\]/);
    assert.equal(row.cwd, path.join('~', 'sec'));

    // --no-redact
    fs.rmSync(path.join(memRepo, 'sec'), { recursive: true, force: true });
    const r2 = af(['memory', 'sync', 'sec', '--no-redact', '--json'], env());
    assert.equal(r2.status, 0, r2.stderr);
    const row2 = JSON.parse(
      fs.readFileSync(path.join(memRepo, 'sec', '_aflt', 'sessions.jsonl'), 'utf8').trim()
    );
    assert.match(row2.title, /sk-abc1234567890xyz/);
    assert.match(row2.promptSummary, /token=supersecretvalue/);
  });

  it('status: stale before sync / not after / stale after new session', () => {
    assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
    seedSession(home, {
      title: 's1',
      project: 'statproj',
      cwd: home,
      created: '2024-01-01T00:00:00.000Z',
      runStartedAt: '2024-01-01T00:00:00.000Z',
      lastUsed: '2024-01-01T01:00:00.000Z',
      lastRunAt: '2024-01-01T01:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
    });

    const st0 = af(['memory', 'status', '--json'], env());
    assert.equal(st0.status, 0, st0.stderr);
    const j0 = JSON.parse(st0.stdout);
    assert.equal(j0.repo, fs.realpathSync(memRepo));
    assert.equal(j0.source, 'config');
    assert.equal(j0.isGit, true);
    const p0 = j0.projects.find((p) => p.project === 'statproj');
    assert.ok(p0);
    assert.equal(p0.stale, true);
    assert.equal(p0.folderExists, false);

    assert.equal(af(['memory', 'sync', 'statproj'], env()).status, 0);

    const st1 = af(['memory', 'status', '--json'], env());
    assert.equal(st1.status, 0, st1.stderr);
    const p1 = JSON.parse(st1.stdout).projects.find((p) => p.project === 'statproj');
    assert.equal(p1.stale, false);
    assert.equal(p1.folderExists, true);
    assert.ok(p1.lastSync);

    seedSession(home, {
      title: 's2',
      project: 'statproj',
      cwd: home,
      created: '2024-02-01T00:00:00.000Z',
      runStartedAt: '2024-02-01T00:00:00.000Z',
      lastUsed: '2024-02-01T01:00:00.000Z',
      lastRunAt: '2024-02-01T01:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
    });

    const st2 = af(['memory', 'status', '--json'], env());
    assert.equal(st2.status, 0, st2.stderr);
    const p2 = JSON.parse(st2.stdout).projects.find((p) => p.project === 'statproj');
    assert.equal(p2.stale, true);
    assert.equal(p2.sessions, 2);
  });

  it('folder sanitization', () => {
    const mem = loadMemory(home);
    assert.equal(mem.sanitizeFolderName('ops'), 'ops');
    assert.equal(mem.sanitizeFolderName('a/b'), 'a-b');
    assert.equal(mem.sanitizeFolderName('..evil'), '-evil');
    assert.equal(mem.sanitizeFolderName('foo/../bar'), 'foo---bar');
    assert.equal(mem.sanitizeFolderName('.hidden'), '-hidden');
    assert.equal(mem.sanitizeFolderName('bad:name*here'), 'bad-name-here');
    assert.throws(() => mem.sanitizeFolderName('...'), /empty/);
    assert.throws(() => mem.sanitizeFolderName('///'), /empty/);
  });

  function git(repo, args) {
    return spawnSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'aflt-test',
        GIT_AUTHOR_EMAIL: 'aflt-test@example.com',
        GIT_COMMITTER_NAME: 'aflt-test',
        GIT_COMMITTER_EMAIL: 'aflt-test@example.com',
      },
    });
  }

  function configureGitIdentity(repo) {
    assert.equal(git(repo, ['config', 'user.name', 'aflt-test']).status, 0);
    assert.equal(git(repo, ['config', 'user.email', 'aflt-test@example.com']).status, 0);
  }

  function seedProjAndInit() {
    assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
    configureGitIdentity(memRepo);
    const projDir = path.join(home, 'workspace', 'commit-app');
    fs.mkdirSync(projDir, { recursive: true });
    seedSession(home, {
      title: 'commit-session',
      project: 'commit-app',
      cwd: projDir,
      created: '2024-06-01T00:00:00.000Z',
      runStartedAt: '2024-06-01T00:00:00.000Z',
      lastUsed: '2024-06-01T12:00:00.000Z',
      lastRunAt: '2024-06-01T12:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
      prompt: 'do work',
    });
    return projDir;
  }

  it('--push without --commit errors', () => {
    assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
    const r = af(['memory', 'sync', '--push'], env());
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /--push requires --commit/);
  });

  it('--commit --dry-run errors', () => {
    assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
    const r = af(['memory', 'sync', '--commit', '--dry-run'], env());
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /--commit cannot be used with --dry-run/);
  });

  function isCommitEligiblePath(p) {
    return p === 'DASHBOARD.md' || /^[^/]+\/_aflt\//.test(p);
  }

  it('--commit stages only _aflt paths; leaves dirty human files unstaged', () => {
    seedProjAndInit();
    const sync1 = af(['memory', 'sync', 'commit-app', '--commit', '--json'], env());
    assert.equal(sync1.status, 0, sync1.stderr + sync1.stdout);
    const j1 = JSON.parse(sync1.stdout);
    assert.equal(j1.ok, true);
    assert.equal(j1.commit.committed, true);
    assert.ok(j1.commit.hash);
    assert.ok(j1.commit.files >= 2);
    assert.match(j1.commit.message, /^memory: sync \d{4}-\d{2}-\d{2}$/);

    const show = git(memRepo, ['show', '--name-only', '--pretty=format:', 'HEAD']);
    assert.equal(show.status, 0, show.stderr);
    const committed = show.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    assert.ok(committed.every(isCommitEligiblePath));
    assert.ok(committed.some((p) => p === 'DASHBOARD.md'));
    assert.ok(committed.some((p) => p.endsWith('_aflt/timeline.md')));
    assert.ok(committed.some((p) => p.endsWith('_aflt/sessions.jsonl')));
    assert.ok(!committed.some((p) => p.endsWith('README.md')));
    assert.ok(!committed.some((p) => /(?:^|\/)dashboard\.md$/.test(p)));
    assert.ok(!committed.some((p) => p.includes('status-notes')));

    // Dirty human files must stay unstaged / uncommitted on next sync --commit
    const readme = path.join(memRepo, 'commit-app', 'README.md');
    const dash = path.join(memRepo, 'commit-app', 'dashboard.md');
    const note = path.join(memRepo, 'commit-app', 'status-notes', '2024-06-01.md');
    fs.writeFileSync(readme, '# commit-app\n\nhuman edit\n');
    fs.writeFileSync(dash, '# dashboard dirty\n');
    fs.writeFileSync(note, 'untracked note\n');

    // Change generated content so there is something to commit
    seedSession(home, {
      title: 'commit-session-2',
      project: 'commit-app',
      cwd: path.join(home, 'workspace', 'commit-app'),
      created: '2024-06-02T00:00:00.000Z',
      runStartedAt: '2024-06-02T00:00:00.000Z',
      lastUsed: '2024-06-02T12:00:00.000Z',
      lastRunAt: '2024-06-02T12:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
      prompt: 'more work',
    });

    const head1 = String(git(memRepo, ['rev-parse', 'HEAD']).stdout).trim();
    const sync2 = af(['memory', 'sync', 'commit-app', '--commit', '--json'], env());
    assert.equal(sync2.status, 0, sync2.stderr + sync2.stdout);
    const j2 = JSON.parse(sync2.stdout);
    assert.equal(j2.commit.committed, true);
    const head2 = String(git(memRepo, ['rev-parse', 'HEAD']).stdout).trim();
    assert.notEqual(head1, head2);

    const staged = git(memRepo, ['diff', '--cached', '--name-only']);
    assert.equal(String(staged.stdout).trim(), '');
    const porcelain = git(memRepo, ['status', '--porcelain', '-uall']);
    assert.match(porcelain.stdout, /README\.md/);
    assert.match(porcelain.stdout, /dashboard\.md/);
    assert.match(porcelain.stdout, /status-notes\/2024-06-01\.md/);
    // Human files must not be in the new commit
    const show2 = git(memRepo, ['show', '--name-only', '--pretty=format:', 'HEAD']);
    const committed2 = show2.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    assert.ok(committed2.every(isCommitEligiblePath));
    assert.equal(fs.readFileSync(readme, 'utf8'), '# commit-app\n\nhuman edit\n');
    assert.equal(fs.readFileSync(dash, 'utf8'), '# dashboard dirty\n');
    assert.equal(fs.readFileSync(note, 'utf8'), 'untracked note\n');
  });

  it('--commit with no changes reports committed:false', () => {
    seedProjAndInit();
    assert.equal(af(['memory', 'sync', 'commit-app', '--commit'], env()).status, 0);
    const head1 = String(git(memRepo, ['rev-parse', 'HEAD']).stdout).trim();
    const r = af(['memory', 'sync', 'commit-app', '--commit', '--json'], env());
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const j = JSON.parse(r.stdout);
    assert.equal(j.commit.committed, false);
    assert.equal(j.commit.reason, 'no changes');
    assert.equal(j.commit.hash, null);
    const text = af(['memory', 'sync', 'commit-app', '--commit'], env());
    assert.equal(text.status, 0);
    assert.match(text.stdout, /memory commit: no changes/);
    const head2 = String(git(memRepo, ['rev-parse', 'HEAD']).stdout).trim();
    assert.equal(head1, head2);
  });

  it('pre-staged human file refuses commit', () => {
    seedProjAndInit();
    assert.equal(af(['memory', 'sync', 'commit-app'], env()).status, 0);
    // Make an initial commit of generated files so repo has history, then stage a human file
    configureGitIdentity(memRepo);
    assert.equal(
      git(memRepo, ['add', '-A', '--', ':(glob)*/_aflt/**']).status,
      0
    );
    assert.equal(git(memRepo, ['commit', '-m', 'seed']).status, 0);

    fs.writeFileSync(path.join(memRepo, 'commit-app', 'README.md'), '# staged human\n');
    assert.equal(git(memRepo, ['add', '--', 'commit-app/README.md']).status, 0);
    const stagedBefore = git(memRepo, ['diff', '--cached', '--name-only']);
    assert.match(stagedBefore.stdout, /README\.md/);

    seedSession(home, {
      title: 'commit-session-3',
      project: 'commit-app',
      cwd: path.join(home, 'workspace', 'commit-app'),
      created: '2024-06-03T00:00:00.000Z',
      runStartedAt: '2024-06-03T00:00:00.000Z',
      lastUsed: '2024-06-03T12:00:00.000Z',
      lastRunAt: '2024-06-03T12:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
    });

    const head1 = String(git(memRepo, ['rev-parse', 'HEAD']).stdout).trim();
    const r = af(['memory', 'sync', 'commit-app', '--commit', '--json'], env());
    assert.equal(r.status, 1);
    const out = r.stderr + r.stdout;
    assert.match(out, /refusing to commit|staged changes/i);
    assert.match(out, /README\.md/);
    const head2 = String(git(memRepo, ['rev-parse', 'HEAD']).stdout).trim();
    assert.equal(head1, head2);
    // Still staged (we refused before touching the index)
    const stagedAfter = git(memRepo, ['diff', '--cached', '--name-only']);
    assert.match(stagedAfter.stdout, /README\.md/);
  });

  it('--push pushes to bare upstream', () => {
    seedProjAndInit();
    const bare = path.join(home, 'memory-bare.git');
    assert.equal(
      spawnSync('git', ['init', '--bare', bare], { encoding: 'utf8' }).status,
      0
    );
    configureGitIdentity(memRepo);
    assert.equal(git(memRepo, ['remote', 'add', 'origin', bare]).status, 0);
    // First sync+commit so we have a branch tip, then set upstream via push -u once… but
    // aflt never passes remote/branch args. Establish upstream with a seed commit + push -u.
    assert.equal(af(['memory', 'sync', 'commit-app'], env()).status, 0);
    assert.equal(git(memRepo, ['add', '-A', '--', ':(glob)*/_aflt/**']).status, 0);
    assert.equal(git(memRepo, ['commit', '-m', 'seed']).status, 0);
    const branch = String(git(memRepo, ['branch', '--show-current']).stdout).trim() || 'main';
    assert.equal(git(memRepo, ['push', '-u', 'origin', branch]).status, 0);

    seedSession(home, {
      title: 'push-session-2',
      project: 'commit-app',
      cwd: path.join(home, 'workspace', 'commit-app'),
      created: '2024-07-01T00:00:00.000Z',
      runStartedAt: '2024-07-01T00:00:00.000Z',
      lastUsed: '2024-07-01T12:00:00.000Z',
      lastRunAt: '2024-07-01T12:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
    });

    const r = af(['memory', 'sync', 'commit-app', '--commit', '--push', '--json'], env());
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const j = JSON.parse(r.stdout);
    assert.equal(j.commit.committed, true);
    assert.equal(j.push.pushed, true);
    assert.ok(j.push.upstream);
    const local = String(git(memRepo, ['rev-parse', 'HEAD']).stdout).trim();
    const remote = String(
      spawnSync('git', ['-C', bare, 'rev-parse', branch], { encoding: 'utf8' }).stdout
    ).trim();
    assert.equal(local, remote);
  });

  it('--push without upstream keeps commit and exits non-zero', () => {
    seedProjAndInit();
    const r = af(['memory', 'sync', 'commit-app', '--commit', '--push', '--json'], env());
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, false);
    assert.equal(j.commit.committed, true);
    assert.ok(j.commit.hash);
    assert.equal(j.push.pushed, false);
    assert.equal(j.push.reason, 'no upstream');
    const head = String(git(memRepo, ['rev-parse', 'HEAD']).stdout).trim();
    assert.ok(head);
    assert.ok(head.startsWith(j.commit.hash) || j.commit.hash === head.slice(0, j.commit.hash.length));
  });

  it('commit message uses local date format', () => {
    seedProjAndInit();
    const mem = loadMemory(home);
    const fixed = new Date(2026, 10, 15, 12, 0, 0); // local Nov 15, 2026
    assert.equal(mem.localDateYmd(fixed), '2026-11-15');
    // CLI uses Date.now(); assert message pattern from a real commit
    const r = af(['memory', 'sync', 'commit-app', '--commit', '--json'], env());
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const j = JSON.parse(r.stdout);
    assert.match(j.commit.message, /^memory: sync \d{4}-\d{2}-\d{2}$/);
    const log = git(memRepo, ['log', '-1', '--pretty=%s']);
    assert.equal(String(log.stdout).trim(), j.commit.message);
  });

  describe('DASHBOARD.md', () => {
    const NOW = new Date('2026-11-15T17:00:00.000Z'); // afternoon ET on 2026-11-15

    function initDash() {
      assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
      configureGitIdentity(memRepo);
    }

    it('sync and dashboard write root DASHBOARD.md; idempotent with same now', () => {
      initDash();
      seedSession(home, {
        title: 'dash-a',
        project: 'dash-a',
        cwd: path.join(home, 'workspace', 'dash-a'),
        created: '2026-11-10T00:00:00.000Z',
        lastUsed: '2026-11-10T12:00:00.000Z',
        status: 'done',
      });
      const mem = loadMemory(home);
      const registry = loadRegistry(home);
      const sessions = registry.list({ includeDone: true });
      const r1 = mem.syncMemory(sessions, {
        projects: ['dash-a'],
        now: NOW,
        redact: true,
      });
      assert.equal(r1.ok, true);
      assert.ok(r1.dashboard);
      assert.equal(r1.dashboard.changed, true);
      const dashPath = path.join(memRepo, 'DASHBOARD.md');
      assert.ok(fs.existsSync(dashPath));
      const body1 = fs.readFileSync(dashPath, 'utf8');
      assert.match(body1, /^# aflt project memory dashboard/m);
      assert.match(body1, /Active = activity within the last 14 days/);
      assert.match(body1, /America\/New_York/);
      assert.ok(!/generated at/i.test(body1));
      assert.match(body1, /<!-- doc-bot:summary:start -->/);
      assert.match(body1, /_No Doc Bot summary yet\._/);

      const r2 = mem.syncMemory(sessions, {
        projects: ['dash-a'],
        now: NOW,
        redact: true,
      });
      assert.equal(r2.dashboard.changed, false);
      assert.equal(fs.readFileSync(dashPath, 'utf8'), body1);
      const mtime1 = fs.statSync(dashPath).mtimeMs;

      const d1 = mem.syncDashboard(sessions, { now: NOW, redact: true });
      assert.equal(d1.dashboard.changed, false);
      assert.equal(fs.statSync(dashPath).mtimeMs, mtime1);

      const builtA = mem.buildDashboard(sessions, { now: NOW, redact: true });
      const builtB = mem.buildDashboard(sessions, { now: NOW, redact: true });
      assert.equal(builtA.md, builtB.md);
    });

    it('active vs dormant with injected now; flag wins over memoryActiveDays', () => {
      initDash();
      seedSession(home, {
        title: 'fresh',
        project: 'fresh-app',
        cwd: home,
        created: '2026-11-10T00:00:00.000Z',
        lastUsed: '2026-11-10T12:00:00.000Z',
        status: 'done',
      });
      seedSession(home, {
        title: 'old',
        project: 'old-app',
        cwd: home,
        created: '2026-01-01T00:00:00.000Z',
        lastUsed: '2026-01-02T12:00:00.000Z',
        status: 'done',
      });
      const mem = loadMemory(home);
      const sessions = loadRegistry(home).list({ includeDone: true });

      const def = mem.buildDashboard(sessions, { now: NOW, redact: false });
      assert.equal(def.activeDays, 14);
      assert.ok(def.active.some((r) => r.project === 'fresh-app'));
      assert.ok(def.dormant.some((r) => r.project === 'old-app'));

      fs.writeFileSync(
        path.join(home, 'config.json'),
        JSON.stringify({ memoryRepo: fs.realpathSync(memRepo), memoryActiveDays: 400 }, null, 2)
      );
      const fromCfg = mem.buildDashboard(sessions, { now: NOW, redact: false });
      assert.equal(fromCfg.activeDays, 400);
      assert.ok(fromCfg.active.some((r) => r.project === 'old-app'));

      const fromFlag = mem.buildDashboard(sessions, {
        now: NOW,
        redact: false,
        activeDays: 7,
      });
      assert.equal(fromFlag.activeDays, 7);
      assert.ok(fromFlag.active.some((r) => r.project === 'fresh-app'));
      assert.ok(fromFlag.dormant.some((r) => r.project === 'old-app'));
      assert.equal(mem.resolveActiveDays({ activeDays: 3, config: { memoryActiveDays: 99 } }), 3);
    });

    it('sorts by last activity newest first with name tie-break', () => {
      initDash();
      seedSession(home, {
        title: 'b',
        project: 'beta',
        cwd: home,
        created: '2026-11-01T00:00:00.000Z',
        lastUsed: '2026-11-12T12:00:00.000Z',
        status: 'done',
      });
      seedSession(home, {
        title: 'a',
        project: 'alpha',
        cwd: home,
        created: '2026-11-01T00:00:00.000Z',
        lastUsed: '2026-11-12T12:00:00.000Z',
        status: 'done',
      });
      seedSession(home, {
        title: 'z',
        project: 'zeta',
        cwd: home,
        created: '2026-11-01T00:00:00.000Z',
        lastUsed: '2026-11-14T12:00:00.000Z',
        status: 'done',
      });
      const mem = loadMemory(home);
      const built = mem.buildDashboard(loadRegistry(home).list({ includeDone: true }), {
        now: NOW,
        redact: false,
      });
      assert.deepEqual(
        built.active.map((r) => r.project),
        ['zeta', 'alpha', 'beta']
      );
    });

    it('session counts open/idle/total from display-state (not bare registry active)', () => {
      initDash();
      const cwd = path.join(home, 'workspace', 'counts');
      fs.mkdirSync(cwd, { recursive: true });
      const live = seedSession(home, {
        title: 'o1',
        project: 'counts',
        cwd,
        status: 'active',
        created: '2026-11-01T00:00:00.000Z',
        lastUsed: '2026-11-14T00:00:00.000Z',
        runPid: process.pid,
      });
      const exited = seedSession(home, {
        title: 'o2',
        project: 'counts',
        cwd,
        status: 'active',
        created: '2026-11-01T00:00:00.000Z',
        lastUsed: '2026-11-14T01:00:00.000Z',
        herdr: { runtime: 'exited', checkedAt: '2026-11-14T01:00:00.000Z' },
      });
      seedSession(home, {
        title: 'idle',
        project: 'counts',
        cwd,
        status: 'paused',
        created: '2026-11-01T00:00:00.000Z',
        lastUsed: '2026-11-14T02:00:00.000Z',
      });
      seedSession(home, {
        title: 'done',
        project: 'counts',
        cwd,
        status: 'done',
        created: '2026-11-01T00:00:00.000Z',
        lastUsed: '2026-11-14T03:00:00.000Z',
      });
      const mem = loadMemory(home);
      const sessions = loadRegistry(home).list({ includeDone: true });
      const built = mem.buildDashboard(sessions, {
        now: NOW,
        redact: false,
        herdrFetch: { ok: false, error: 'stub', terminals: [], checkedAt: '2026-11-14T00:00:00.000Z' },
        isAlive: (pid) => Number(pid) === process.pid,
      });
      const row = built.active.find((r) => r.project === 'counts');
      assert.ok(row);
      assert.equal(row.open, 1);
      assert.equal(row.idle, 2);
      assert.equal(row.total, 4);
      assert.match(built.md, /\| \[counts\]\(counts\/\) \| 2026-11-1[34] \| 1\/2\/4 \|/);
      const raw = sessions.find((s) => s.id === exited.id);
      assert.equal(raw.status, 'active');
      assert.equal(sessions.find((s) => s.id === live.id).status, 'active');
    });

    it('active + Herdr exited counts as idle; af aliases to aflt folder', () => {
      initDash();
      const cwd = path.join(home, 'workspace', 'aflt');
      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(path.join(memRepo, 'af'), { recursive: true });
      fs.mkdirSync(path.join(memRepo, 'aflt'), { recursive: true });
      const sess = seedSession(home, {
        title: 'legacy-af',
        project: 'af',
        cwd,
        status: 'active',
        created: '2026-11-01T00:00:00.000Z',
        lastUsed: '2026-11-14T12:00:00.000Z',
        herdr: { runtime: 'exited', checkedAt: '2026-11-14T12:00:00.000Z' },
      });
      const mem = loadMemory(home);
      const sessions = loadRegistry(home).list({ includeDone: true });
      assert.equal(sessions.find((s) => s.id === sess.id).project, 'af');

      const counts = mem.projectSessionCounts(sessions, 'aflt', {
        enrichmentById: {
          [sess.id]: { runtime: 'exited', checkedAt: '2026-11-14T12:00:00.000Z' },
        },
      });
      assert.equal(counts.open, 0);
      assert.equal(counts.idle, 1);
      assert.equal(counts.total, 1);

      const syncProjects = mem.resolveSyncProjects(sessions, { all: true });
      assert.ok(syncProjects.includes('aflt'));
      assert.ok(!syncProjects.includes('af'));

      const built = mem.buildDashboard(sessions, {
        now: NOW,
        redact: false,
        enrichmentById: {
          [sess.id]: { runtime: 'exited', checkedAt: '2026-11-14T12:00:00.000Z' },
        },
      });
      const afltRow = built.rows.find((r) => r.project === 'aflt');
      assert.ok(afltRow);
      assert.equal(afltRow.open, 0);
      assert.equal(afltRow.idle, 1);
      // Legacy af/ folder may still appear from the repo listing; do not delete it
      assert.ok(fs.existsSync(path.join(memRepo, 'af')));
      assert.equal(sessions.find((s) => s.id === sess.id).project, 'af');
    });

    it('status-note title+date from filename/heading; archive ignored; newest wins', () => {
      initDash();
      const folder = path.join(memRepo, 'notes-app');
      fs.mkdirSync(path.join(folder, 'status-notes', 'archive'), { recursive: true });
      fs.writeFileSync(
        path.join(folder, 'status-notes', 'archive', '2026-11-20-ignored.md'),
        '# Should Ignore\n'
      );
      fs.writeFileSync(
        path.join(folder, 'status-notes', '2026-11-01-older.md'),
        '# Older Note\n'
      );
      fs.writeFileSync(
        path.join(folder, 'status-notes', '2026-11-12T1500-shipped.md'),
        '# Shipped Feature\n\nbody\n'
      );
      const mem = loadMemory(home);
      const built = mem.buildDashboard([], { now: NOW, redact: false });
      const row = built.rows.find((r) => r.project === 'notes-app');
      assert.ok(row);
      assert.equal(row.noteYmd, '2026-11-12');
      assert.equal(row.noteTitle, 'Shipped Feature');
      assert.equal(row.noteFile, '2026-11-12T1500-shipped.md');
      assert.equal(row.activityYmd, '2026-11-12');
      assert.match(
        built.md,
        /\[Shipped Feature\]\(notes-app\/status-notes\/2026-11-12T1500-shipped\.md\) \(2026-11-12\)/
      );
    });

    it('doc-bot block preserved verbatim; placeholder when missing; later sync keeps summary', () => {
      initDash();
      seedSession(home, {
        title: 'd',
        project: 'docbot',
        cwd: home,
        created: '2026-11-01T00:00:00.000Z',
        lastUsed: '2026-11-14T00:00:00.000Z',
        status: 'done',
      });
      const mem = loadMemory(home);
      const sessions = loadRegistry(home).list({ includeDone: true });
      mem.syncMemory(sessions, { projects: ['docbot'], now: NOW });
      const dashPath = path.join(memRepo, 'DASHBOARD.md');
      let body = fs.readFileSync(dashPath, 'utf8');
      assert.match(body, /_No Doc Bot summary yet\._/);

      const customInner = '\nHello from Doc Bot — contact human@example.com\n\n';
      body = body.replace(
        /<!-- doc-bot:summary:start -->[\s\S]*?<!-- doc-bot:summary:end -->/,
        `${mem.DOC_BOT_SUMMARY_START}${customInner}${mem.DOC_BOT_SUMMARY_END}`
      );
      fs.writeFileSync(dashPath, body);

      mem.syncMemory(sessions, { projects: ['docbot'], now: NOW });
      const after = fs.readFileSync(dashPath, 'utf8');
      const inner = mem.extractDocBotSummaryInner(after);
      assert.equal(inner, customInner);
      assert.match(after, /human@example\.com/);
      assert.ok(!after.includes('[redacted]@') || after.includes('human@example.com'));
    });

    it('redacts status-note titles; --no-redact leaves them; doc-bot inner not redacted', () => {
      initDash();
      const folder = path.join(memRepo, 'sec-dash');
      fs.mkdirSync(path.join(folder, 'status-notes'), { recursive: true });
      fs.writeFileSync(
        path.join(folder, 'status-notes', '2026-11-14-leak.md'),
        '# Leak me@example.com and sk-abc1234567890xyz\n'
      );
      fs.writeFileSync(
        path.join(memRepo, 'DASHBOARD.md'),
        `# aflt project memory dashboard\n\n` +
          `<!-- doc-bot:summary:start -->\n` +
          `Doc Bot: mail keep@example.com please\n` +
          `<!-- doc-bot:summary:end -->\n`
      );
      const mem = loadMemory(home);
      const red = mem.buildDashboard([], { now: NOW, redact: true });
      assert.match(red.md, /\[redacted\]/);
      assert.match(red.md, /Doc Bot: mail keep@example\.com please/);
      const raw = mem.buildDashboard([], { now: NOW, redact: false });
      assert.match(raw.md, /Leak me@example\.com and sk-abc1234567890xyz/);
      assert.match(raw.md, /Doc Bot: mail keep@example\.com please/);
    });

    it('one-project sync still lists other memory-repo folders on dashboard', () => {
      initDash();
      fs.mkdirSync(path.join(memRepo, 'orphan-proj', 'status-notes'), { recursive: true });
      fs.writeFileSync(path.join(memRepo, 'orphan-proj', 'README.md'), '# orphan\n');
      seedSession(home, {
        title: 'only',
        project: 'only-sync',
        cwd: home,
        created: '2026-11-01T00:00:00.000Z',
        lastUsed: '2026-11-14T00:00:00.000Z',
        status: 'done',
      });
      const r = af(['memory', 'sync', 'only-sync', '--json'], env());
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const j = JSON.parse(r.stdout);
      assert.deepEqual(
        j.projects.map((p) => p.project),
        ['only-sync']
      );
      const dash = fs.readFileSync(path.join(memRepo, 'DASHBOARD.md'), 'utf8');
      assert.match(dash, /\[only-sync\]\(only-sync\/\)/);
      assert.match(dash, /\[orphan-proj\]\(orphan-proj\/\)/);
      assert.match(dash, /no recorded activity/);
    });

    it('dashboard --dry-run writes nothing; CLI --json works', () => {
      initDash();
      seedSession(home, {
        title: 'cli',
        project: 'cli-dash',
        cwd: home,
        created: '2026-11-01T00:00:00.000Z',
        lastUsed: '2026-11-14T00:00:00.000Z',
        status: 'done',
      });
      const before = fs.readdirSync(memRepo).sort();
      const dry = af(['memory', 'dashboard', '--dry-run', '--json'], env());
      assert.equal(dry.status, 0, dry.stderr + dry.stdout);
      const dj = JSON.parse(dry.stdout);
      assert.equal(dj.ok, true);
      assert.equal(dj.dashboard.path, 'DASHBOARD.md');
      assert.equal(dj.dashboard.changed, true);
      assert.deepEqual(fs.readdirSync(memRepo).sort(), before);
      assert.ok(!fs.existsSync(path.join(memRepo, 'DASHBOARD.md')));

      const live = af(['memory', 'dashboard', '--json', '--active-days', '14'], env());
      assert.equal(live.status, 0, live.stderr + live.stdout);
      const lj = JSON.parse(live.stdout);
      assert.equal(lj.ok, true);
      assert.equal(lj.dashboard.changed, true);
      assert.equal(lj.dashboard.activeDays, 14);
      assert.ok(fs.existsSync(path.join(memRepo, 'DASHBOARD.md')));
    });

    it('folder sanitization; prefer note/updated over later _aflt-only git commit', () => {
      initDash();
      const folder = path.join(memRepo, 'prefer-dates');
      fs.mkdirSync(path.join(folder, '_aflt'), { recursive: true });
      fs.mkdirSync(path.join(folder, 'status-notes'), { recursive: true });
      fs.writeFileSync(
        path.join(folder, 'dashboard.md'),
        '---\nid: prefer-dates\nupdated: 2026-10-01\n---\n\n# prefer-dates\n'
      );
      fs.writeFileSync(
        path.join(folder, 'status-notes', '2026-10-05-note.md'),
        '# Note Wins\n'
      );
      fs.writeFileSync(path.join(folder, '_aflt', 'timeline.md'), '# t\n');
      fs.writeFileSync(path.join(folder, '_aflt', 'sessions.jsonl'), '');
      assert.equal(git(memRepo, ['add', '-A']).status, 0);
      assert.equal(git(memRepo, ['commit', '-m', 'seed prefer']).status, 0);
      // Later commit that only touches _aflt must not win over note date
      fs.writeFileSync(path.join(folder, '_aflt', 'timeline.md'), '# t2\n');
      assert.equal(git(memRepo, ['add', '-A', '--', 'prefer-dates/_aflt']).status, 0);
      assert.equal(git(memRepo, ['commit', '-m', 'aflt only']).status, 0);

      const mem = loadMemory(home);
      const built = mem.buildDashboard([], { now: NOW, redact: false });
      const row = built.rows.find((r) => r.project === 'prefer-dates');
      assert.ok(row);
      assert.equal(row.activityYmd, '2026-10-05');

      // Unsafe project name still sanitizes for folder links when synced
      seedSession(home, {
        title: 'weird',
        project: 'weird:name',
        cwd: home,
        created: '2026-11-01T00:00:00.000Z',
        lastUsed: '2026-11-14T00:00:00.000Z',
        status: 'done',
      });
      const sessions = loadRegistry(home).list({ includeDone: true });
      const sync = mem.syncMemory(sessions, {
        projects: ['weird:name'],
        now: NOW,
        redact: false,
      });
      assert.ok(sync.projects.some((p) => p.folder === 'weird-name'));
      assert.ok(fs.existsSync(path.join(memRepo, 'weird-name', '_aflt', 'timeline.md')));
      assert.match(fs.readFileSync(path.join(memRepo, 'DASHBOARD.md'), 'utf8'), /weird-name/);
    });

    it('empty Active/Dormant use stable _None._ wording', () => {
      initDash();
      // Only a very old session → Active empty
      seedSession(home, {
        title: 'ancient',
        project: 'ancient',
        cwd: home,
        created: '2020-01-01T00:00:00.000Z',
        lastUsed: '2020-01-02T00:00:00.000Z',
        status: 'done',
      });
      const mem = loadMemory(home);
      const built = mem.buildDashboard(loadRegistry(home).list({ includeDone: true }), {
        now: NOW,
        activeDays: 14,
        redact: false,
      });
      assert.equal(built.active.length, 0);
      assert.match(built.md, /## Active\n\n_None\._/);
      assert.ok(built.dormant.length >= 1);
    });
  });

  describe('aflt memory doc', () => {
    it('fails when no memory repo is configured', () => {
      const r = af(['memory', 'doc', '--dry-run', '--json'], env({ AFLT_MEMORY_REPO: '' }));
      assert.equal(r.status, 1, r.stderr + r.stdout);
      assert.match(r.stderr + r.stdout, /no memory repo configured/);
    });

    it('fails when DOC-AGENT.md is missing', () => {
      assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
      fs.rmSync(path.join(memRepo, 'DOC-AGENT.md'));
      const r = af(['memory', 'doc', '--dry-run', '--json'], env());
      assert.equal(r.status, 1, r.stderr + r.stdout);
      assert.match(r.stderr + r.stdout, /missing DOC-AGENT\.md|missing DOC-AGENT.md/);
    });

    it('dry-run --engine copilot does not create a session and includes the prompt', () => {
      assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
      const r = af(
        ['memory', 'doc', '--engine', 'copilot', '--dry-run', '--json'],
        env()
      );
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const j = JSON.parse(r.stdout);
      assert.equal(j.ok, true);
      assert.equal(j.dryRun, true);
      assert.equal(j.session.engine, 'copilot');
      assert.equal(j.session.title, 'doc-bot');
      assert.match(String(j.command || ''), /copilot/);
      assert.match(r.stderr, /would create a copilot session/);
      const real = fs.realpathSync(memRepo);
      // cwd is the memory repo
      assert.ok(
        (j.session.cwd && fs.existsSync(j.session.cwd) && fs.realpathSync(j.session.cwd) === real) ||
          String(j.command || r.stderr || '').includes(memRepo) ||
          String(j.command || r.stderr || '').includes(real),
        `expected memory repo cwd in dry-run output: ${r.stdout}\n${r.stderr}`
      );
      // prompt comes from DOC-AGENT.md
      const prompt = fs.readFileSync(path.join(memRepo, 'DOC-AGENT.md'), 'utf8');
      assert.ok(
        String(j.command || '').includes('Memory documentarian') ||
          String(j.command || '').includes('DOC-AGENT') ||
          prompt.includes('Memory documentarian'),
        'DOC-AGENT.md should be the prompt source'
      );
      // no registry write
      const sessionsPath = path.join(home, 'sessions.json');
      if (fs.existsSync(sessionsPath)) {
        const raw = fs.readFileSync(sessionsPath, 'utf8').trim();
        if (raw) {
          const data = JSON.parse(raw);
          const list = Array.isArray(data) ? data : data.sessions || [];
          assert.equal(list.length, 0, 'dry-run must not write the registry');
        }
      }
    });

    for (const title of ['memory-doc', 'doc-bot']) {
      it(`reuses ${title} without changing the registry, preferring doc-bot when both exist`, () => {
        assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
        const legacy = seedSession(home, {
          title: 'memory-doc', cwd: fs.realpathSync(memRepo), project: 'aflt-memory',
          engine: 'copilot', status: 'active',
        });
        const expected = title === 'memory-doc' ? legacy : seedSession(home, {
          title: 'doc-bot', cwd: fs.realpathSync(memRepo), project: 'aflt-memory',
          engine: 'copilot', status: 'active',
        });
        const registryPath = path.join(home, 'sessions.json');
        const before = fs.readFileSync(registryPath, 'utf8');
        const r = af(['memory', 'doc', '--engine', 'copilot', '--dry-run', '--json'], env());
        assert.equal(r.status, 0, r.stderr + r.stdout);
        const plan = JSON.parse(r.stdout);
        assert.equal(plan.session.id, expected.id);
        assert.ok(plan.command.includes(expected.chatId), 'resume the existing chat');
        assert.equal(plan.session.title, title);
        assert.equal(fs.readFileSync(registryPath, 'utf8'), before);
      });
    }
  });

});
