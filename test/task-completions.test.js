'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectTaskCompletions } = require('../lib/task-completions');

describe('Task Complete capture', () => {
  let home;
  let repo;
  let file;
  let session;
  let options;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-completions-'));
    repo = path.join(home, 'memory');
    fs.mkdirSync(repo);
    session = {
      id: 'worker-one', title: 'Feature worker', project: 'alpha', engine: 'copilot',
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cwd: home, status: 'active',
    };
    const copilotHome = path.join(home, 'copilot');
    file = path.join(copilotHome, 'session-state', session.chatId, 'events.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    options = {
      cache: new Map(), memoryRepo: repo,
      env: { ...process.env, AGENTFLEET_COPILOT_HOME: copilotHome },
    };
  });

  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function event(id, summary, extra = {}) {
    return JSON.stringify({
      id, type: 'session.task_complete', timestamp: '2026-11-17T05:30:01.000Z',
      data: { success: true, summary }, ...extra,
    }) + '\n';
  }

  function collect(extra = {}) {
    return collectTaskCompletions([session], { ...options, ...extra });
  }

  it('uses only successful native events and stays read-only without capture enabled', () => {
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'tool.execution_start', data: { toolName: 'task_complete', arguments: { summary: 'Not yet completed' } } }),
      event('failed', 'Not successful', { data: { success: false, summary: 'Not successful' } }).trim(),
      event('success', '**Shipped**', { timestamp: '2026-11-17T05:31:00.000Z' }).trim(),
    ].join('\n') + '\n');
    const result = collect();
    assert.deepEqual(result.errors, []);
    assert.equal(result.bySessionId[session.id].eventId, 'success');
    assert.equal(result.bySessionId[session.id].summary, '**Shipped**');
    assert.equal(result.bySessionId[session.id].notePath, null);
    assert.deepEqual(fs.readdirSync(repo), []);
    assert.equal(session.status, 'active');
  });

  it('handles partial UTF-8 lines, incremental appends and a truncated event source', () => {
    fs.writeFileSync(file, JSON.stringify({ type: 'user.message', data: { content: 'x'.repeat(300 * 1024) } }) + '\n');
    const bytes = Buffer.from(event('first', 'Finished \u2713'));
    const cut = bytes.indexOf(Buffer.from('\u2713')) + 1;
    fs.appendFileSync(file, bytes.subarray(0, cut));
    assert.equal(collect().bySessionId[session.id], undefined);
    fs.appendFileSync(file, bytes.subarray(cut));
    assert.equal(collect().bySessionId[session.id].summary, 'Finished \u2713');
    const offset = options.cache.get(session.id).offset;
    assert.equal(collect().bySessionId[session.id].eventId, 'first');
    assert.equal(options.cache.get(session.id).offset, offset);
    fs.writeFileSync(file, event('replacement', 'Finished again', { timestamp: '2026-11-17T05:40:00.000Z' }));
    assert.equal(collect().bySessionId[session.id].eventId, 'replacement');
  });

  it('captures every message once, redacts notes, preserves full text and does not recreate archived notes', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
    const longSummary = 'Completed work. '.repeat(3000) + 'Full message ends here.';
    fs.writeFileSync(file, event('one', `Shipped **feature** with ${secret}`) + event('two', longSummary));
    const result = collect({ capture: true });
    assert.deepEqual(result.errors, []);
    const notes = path.join(repo, 'alpha', 'status-notes');
    const names = fs.readdirSync(notes);
    assert.equal(names.length, 2, 'two completions in the same second have distinct notes');
    const bodies = names.map((name) => fs.readFileSync(path.join(notes, name), 'utf8'));
    assert.ok(bodies.some((body) => body.includes('Shipped **feature** with [redacted]')));
    assert.ok(bodies.every((body) => !body.includes(secret)));
    assert.ok(bodies.some((body) => body.includes(longSummary)), 'archive the entire summary, not just its UI preview');
    assert.equal(result.bySessionId[session.id].truncated, true);
    const latest = path.join(repo, result.bySessionId[session.id].notePath);
    fs.appendFileSync(latest, '\nHuman follow-up.\n');
    const preserved = fs.readFileSync(latest, 'utf8');
    const old = names.find((name) => path.join(notes, name) !== latest);
    const archive = path.join(repo, 'alpha', 'archive');
    fs.mkdirSync(archive);
    fs.renameSync(path.join(notes, old), path.join(archive, old));
    const replay = collect({ capture: true, cache: new Map() });
    assert.deepEqual(replay.errors, []);
    assert.equal(fs.readdirSync(notes).length, 1, 'a receipt preserves the archive decision across restarts');
    assert.equal(fs.readFileSync(latest, 'utf8'), preserved);
    assert.equal(fs.readdirSync(path.join(repo, 'alpha', '_aflt', 'task-completions')).length, 2);
  });

  it('reports an escaped destination and retries the unsaved message after it is repaired', () => {
    const outside = path.join(home, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(repo, 'alpha'));
    fs.writeFileSync(file, event('retry', 'Keep this completion'));
    const failed = collect({ capture: true });
    assert.match(failed.errors.join('\n'), /escapes the memory repo/);
    assert.equal(failed.bySessionId[session.id].summary, 'Keep this completion');
    assert.equal(failed.bySessionId[session.id].notePath, null);
    assert.match(failed.bySessionId[session.id].saveError, /escapes/);
    assert.deepEqual(fs.readdirSync(outside), []);
    fs.unlinkSync(path.join(repo, 'alpha'));
    fs.mkdirSync(path.join(repo, 'alpha'));
    const retried = collect({ capture: true });
    assert.deepEqual(retried.errors, []);
    assert.ok(fs.existsSync(path.join(repo, retried.bySessionId[session.id].notePath)));
    assert.equal(retried.bySessionId[session.id].saveError, null);
  });

  it('surfaces malformed records without losing a following valid completion', () => {
    fs.writeFileSync(file, '{broken}\n' + event('valid', 'Still captured'));
    const result = collect({ capture: true });
    assert.match(result.errors.join('\n'), /Invalid JSON/);
    assert.equal(result.bySessionId[session.id].summary, 'Still captured');
    assert.ok(fs.existsSync(path.join(repo, result.bySessionId[session.id].notePath)));
    const invalid = collectTaskCompletions([{ ...session, chatId: '../outside' }], options);
    assert.match(invalid.errors.join('\n'), /invalid Copilot chat ID/);
  });

  it('reports a corrupted capture receipt instead of claiming the message is saved elsewhere', () => {
    fs.writeFileSync(file, event('owned', 'Preserve this note'));
    const first = collect({ capture: true });
    const note = path.join(repo, first.bySessionId[session.id].notePath);
    const body = fs.readFileSync(note, 'utf8');
    const directory = path.join(repo, 'alpha', '_aflt', 'task-completions');
    const receipt = path.join(directory, fs.readdirSync(directory)[0]);
    const data = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    data.notePath = '../outside.md';
    fs.writeFileSync(receipt, JSON.stringify(data));
    const result = collect({ capture: true, cache: new Map() });
    assert.match(result.errors.join('\n'), /invalid completion capture receipt/);
    assert.equal(result.bySessionId[session.id].notePath, null);
    assert.equal(fs.readFileSync(note, 'utf8'), body);
  });
});
