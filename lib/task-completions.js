'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const copilot = require('./copilot');
const memory = require('./memory');
const projectLib = require('./project');

const PREVIEW_LIMIT = 32 * 1024;

function readEvents(file, entry) {
  const records = [];
  const errors = [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('completion event source is not a file');
    const identity = `${stat.dev}:${stat.ino}`;
    if (entry.identity !== identity || entry.offset > stat.size) entry.offset = 0;
    entry.identity = identity;
    let position = entry.offset;
    let carry = Buffer.alloc(0);
    const buffer = Buffer.alloc(256 * 1024);
    while (position < stat.size) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!count) break;
      position += count;
      const bytes = Buffer.concat([carry, buffer.subarray(0, count)]);
      let start = 0;
      let end;
      while ((end = bytes.indexOf(10, start)) !== -1) {
        const line = bytes.subarray(start, end).toString('utf8');
        start = end + 1;
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          errors.push('Invalid JSON in completion event source');
          continue;
        }
        if (event?.type !== 'session.task_complete' || event.data?.success !== true) continue;
        if (typeof event.id !== 'string' || !event.id ||
            typeof event.data.summary !== 'string' || !event.data.summary.trim() ||
            typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp))) {
          errors.push('Task Complete event is missing its ID, timestamp or summary');
          continue;
        }
        records.push({
          eventId: event.id,
          at: new Date(event.timestamp).toISOString(),
          summary: memory.redactSensitive(event.data.summary),
        });
      }
      carry = Buffer.from(bytes.subarray(start));
    }
    // Leave an unfinished final JSONL line for the next poll, including its UTF-8 bytes.
    entry.offset = position - carry.length;
  } catch (error) {
    if (error.code !== 'ENOENT') errors.push(`Completion events: ${error.code || error.message}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return { records, errors };
}

function ensureDirectory(root, parts) {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const real = fs.realpathSync(current);
    const relative = path.relative(root, real);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('completion destination escapes the memory repo');
    }
    if (!fs.statSync(real).isDirectory()) throw new Error('completion destination is not a directory');
  }
  return current;
}

function readOwnedFile(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('completion destination is not a regular file');
  return fs.readFileSync(file, 'utf8');
}

function createOnce(file, body, matches) {
  const existing = readOwnedFile(file);
  if (existing !== null) {
    if (!matches(existing)) throw new Error('completion destination already contains a different record');
    return;
  }
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  let fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, body, 'utf8');
    fs.closeSync(fd);
    fd = null;
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!matches(readOwnedFile(file))) throw new Error('completion destination already contains a different record');
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
    fs.unlinkSync(temporary);
  }
}

function noteStamp(at) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}${value('minute')}${value('second')}`;
}

function capture(record, session, project, repo) {
  const root = fs.realpathSync(repo);
  const folder = memory.sanitizeFolderName(project);
  const key = crypto.createHash('sha256').update(JSON.stringify([session.id, record.eventId])).digest('hex');
  const filename = `${noteStamp(record.at)}-task-complete-${key.slice(0, 12)}.md`;
  const notePath = [folder, 'status-notes', filename].join('/');
  const receipts = ensureDirectory(root, [folder, '_aflt', 'task-completions']);
  const receiptPath = path.join(receipts, key + '.json');
  const receipt = readOwnedFile(receiptPath);
  if (receipt !== null) {
    const saved = JSON.parse(receipt);
    if (saved.key !== key || saved.eventId !== record.eventId ||
        saved.at !== record.at || saved.notePath !== notePath) {
      throw new Error('invalid completion capture receipt');
    }
    return notePath;
  }
  const notes = ensureDirectory(root, [folder, 'status-notes']);
  const marker = `Completion event: ${memory.redactSensitive(record.eventId)}`;
  const title = String(session.title || session.id).replace(/[\r\n]+/g, ' ');
  const body = memory.redactSensitive(
    `# Task Complete: ${title}\n\n` +
    `Completed: ${record.at}\n\nProject: ${project}\n\nSession: ${session.id}\n\n` +
    `Source: Copilot CLI \`session.task_complete\` (agent-reported completion).\n\n` +
    record.summary + '\n\n---\n\n' + marker + '\n'
  );
  createOnce(path.join(notes, filename), body, (text) => typeof text === 'string' && text.includes('\n' + marker + '\n'));
  const saved = JSON.stringify({ key, eventId: record.eventId, at: record.at, notePath }, null, 2) + '\n';
  createOnce(receiptPath, saved, (text) => {
    const previous = JSON.parse(text);
    return previous.key === key && previous.notePath === notePath;
  });
  return notePath;
}

function collectTaskCompletions(sessions, opts = {}) {
  const cache = opts.cache || new Map();
  const bySessionId = {};
  const errors = [];
  const ids = new Set();
  if (opts.capture && !opts.memoryRepo) errors.push('Task Complete capture requires a configured memory repo');
  for (const session of sessions) {
    if (!session?.id || session.engine !== 'copilot' || !session.chatId) continue;
    ids.add(session.id);
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session.chatId)) {
      errors.push(`${session.title || session.id}: invalid Copilot chat ID`);
      continue;
    }
    let entry = cache.get(session.id);
    if (!entry || entry.chatId !== session.chatId || entry.repo !== opts.memoryRepo) {
      entry = { chatId: session.chatId, repo: opts.memoryRepo, offset: 0, pending: new Map(), latest: null };
      cache.set(session.id, entry);
    }
    const file = path.join(copilot.sessionStateRoot(opts.env), session.chatId, 'events.jsonl');
    const read = readEvents(file, entry);
    errors.push(...read.errors.map((error) => `${session.title || session.id}: ${error}`));
    for (const record of read.records) {
      if (!entry.latest || record.at >= entry.latest.at) entry.latest = record;
      if (opts.capture) entry.pending.set(record.eventId, record);
    }
    if (opts.capture && opts.memoryRepo) {
      const project = projectLib.canonicalProjectName(projectLib.resolveProjectName(session, { cache: opts.projectCache }));
      for (const [id, record] of entry.pending) {
        try {
          record.notePath = capture(record, session, project, opts.memoryRepo);
          delete record.saveError;
          entry.pending.delete(id);
        } catch (error) {
          record.saveError = memory.redactSensitive(error.message);
          errors.push(`${session.title || session.id}: could not save Task Complete: ${record.saveError}`);
        }
      }
    }
    if (entry.latest) {
      const latest = entry.latest;
      bySessionId[session.id] = {
        eventId: latest.eventId, at: latest.at,
        sessionId: session.id, sessionTitle: session.title || session.id,
        summary: latest.summary.slice(0, PREVIEW_LIMIT),
        truncated: latest.summary.length > PREVIEW_LIMIT,
        notePath: latest.notePath || null, saveError: latest.saveError || null,
      };
    }
  }
  for (const id of cache.keys()) {
    if (!ids.has(id)) cache.delete(id);
  }
  return { bySessionId, errors: errors.slice(0, 20).map(memory.redactSensitive) };
}

module.exports = { collectTaskCompletions };
