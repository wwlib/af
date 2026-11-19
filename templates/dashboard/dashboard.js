'use strict';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderMarkdown(value, { documentLinks = true } = {}) {
  const engine = typeof module !== 'undefined' && module.exports && typeof document === 'undefined'
    ? require('./marked.min') : marked;
  const headings = new Set();
  const parser = new engine.Marked({
    gfm: true,
    renderer: {
      html: function (html) { return escapeHtml(html); },
      image: function (href, title, text) {
        return '<span class="markdown-image">[Image: ' + escapeHtml(text) + ']</span>';
      },
      link: function (href, title, text) {
        href = String(href || '').trim();
        if (!href || /[\u0000-\u001f\u007f]/.test(href)) return text;
        const label = title ? ' title="' + escapeHtml(title) + '"' : '';
        if (/^(https?:\/\/|mailto:)/i.test(href)) {
          return '<a href="' + escapeHtml(href) + '"' + label +
            ' target="_blank" rel="noopener noreferrer">' + text + '</a>';
        }
        if (/^[a-z][a-z0-9+.-]*:|^[\\/]{2}/i.test(href)) return text;
        if (!documentLinks) return text;
        return '<a href="#" data-document-link="' + escapeHtml(href) + '"' + label + '>' + text + '</a>';
      },
      heading: function (text, level, raw) {
        const slug = raw.toLowerCase().replace(/<[^>]*>/g, '')
          .replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-');
        const base = 'document-heading-' + slug;
        let id = base;
        let count = 0;
        while (headings.has(id)) id = base + '-' + (++count);
        headings.add(id);
        return '<h' + level + ' id="' + escapeHtml(id) + '">' + text + '</h' + level + '>\n';
      },
    },
  });
  return parser.parse(String(value == null ? '' : value));
}

function resolveDocumentLink(projects, fromPath, href) {
  let target;
  let file;
  let fragment;
  try {
    target = new URL(href, 'https://aflt.invalid/' + fromPath);
    file = decodeURIComponent(target.pathname).slice(1);
    fragment = decodeURIComponent(target.hash.slice(1));
  } catch (error) {
    if (error.name !== 'TypeError' && error.name !== 'URIError') throw error;
    return null;
  }
  if (target.origin !== 'https://aflt.invalid') return null;
  for (const project of projects || []) {
    const doc = project.memory && (project.memory.documents || []).find(function (d) {
      return d.path === file;
    });
    if (doc) return { project: project.id, path: doc.path, fragment: fragment };
  }
  return null;
}

function renderProjectMemory(project, memoryState) {
  const context = project && project.memory;
  const errors = [...((memoryState && memoryState.errors) || []), ...((context && context.errors) || [])];
  let html = errors.map(function (error) {
    return '<p class="memory-error">' + escapeHtml(error) + '</p>';
  }).join('');
  if (!project) return html + '<p class="empty">Select a project to review its status and docs.</p>';
  if (!context) {
    return html + '<p class="empty">' +
      (memoryState && memoryState.configured
        ? 'No memory documents found for this project.'
        : 'No memory repo configured. Use aflt memory init to opt in.') + '</p>';
  }
  if (context.summary) {
    html += '<div class="label">Doc Bot summary</div><p>' + escapeHtml(context.summary.moved) +
      '</p><div class="label">Blocked</div><p>' + escapeHtml(context.summary.blocked) + '</p>';
  } else {
    html += '<p class="empty">No Doc Bot summary recorded for this project.</p>';
  }
  const documents = context.documents || [];
  if (!documents.length) return html + '<p class="empty">No project documents recorded yet.</p>';
  html += '<ul class="memory-documents">';
  documents.forEach(function (doc) {
    html += '<li><button type="button" class="document-link" data-document-path="' +
      escapeHtml(doc.path) + '">' + escapeHtml(doc.title) + '</button><small>' +
      escapeHtml(doc.kind === 'status' ? 'Status note · ' + doc.date : doc.kind === 'readme' ? 'README' : 'Project dashboard') +
      (doc.truncated ? ' · preview limited to 32 KiB' : '') + '</small></li>';
  });
  return html + '</ul>';
}

function activityLabel(item) {
  const activity = item.activityState || (item.awaitingInput ? 'waiting' : item.displayState);
  return { working: 'Working', completed: 'Completed', waiting: 'Awaiting input' }[activity] ||
    item.displayState || 'unknown';
}

function renderTaskCompletion(completion) {
  if (!completion) return '';
  return '<section class="task-completion"><div class="label">Latest Task Complete</div>' +
    '<p class="completion-meta">' + escapeHtml(completion.sessionTitle) + ' · ' +
    escapeHtml(completion.at) + '</p><div class="completion-body">' +
    renderMarkdown(completion.summary, { documentLinks: false }) + '</div>' +
    (completion.truncated ? '<p class="completion-meta">Preview truncated; the full message is saved in the project note when capture is enabled.</p>' : '') +
    (completion.saveError ? '<p class="memory-error">Could not save completion: ' + escapeHtml(completion.saveError) + '</p>' : '') +
    (completion.notePath ? '<p class="completion-meta">Captured in project docs: <code>' +
      escapeHtml(completion.notePath) + '</code></p>' : '') + '</section>';
}

function renderGraphHint(project, session) {
  if (session) {
    return '<p>State: <strong>' + escapeHtml(activityLabel(session)) + '</strong></p>' +
      '<p>Session ID: <code>' + escapeHtml(session.id) + '</code></p>' +
      '<p>Engine: <strong>' + escapeHtml(session.engine || 'unknown') + '</strong></p>' +
      '<p>Status: <strong>' + escapeHtml(session.status || 'unknown') + '</strong></p>' +
      '<p>Herdr status: <strong>' + escapeHtml(session.herdr && session.herdr.runtime || 'unknown') + '</strong></p>';
  }
  if (!project) return '';
  const summary = project.memory && project.memory.summary;
  return '<div class="label">Doc Bot summary</div><p>' +
    escapeHtml(summary ? summary.moved : 'No Doc Bot summary recorded for this project.') + '</p>';
}

/**
 * Preserve force-sim positions across SSE updates (shared algorithm with lib/dashboard.js).
 * Exported for hermetic Node tests when required without a DOM.
 */
function mergeSimPreserve(prevSim, nextBuilt, opts) {
  opts = opts || {};
  const nextNodes = nextBuilt && Array.isArray(nextBuilt.nodes) ? nextBuilt.nodes : [];
  const nextLinks = nextBuilt && Array.isArray(nextBuilt.links) ? nextBuilt.links : [];
  const prevNodes = prevSim && Array.isArray(prevSim.nodes) ? prevSim.nodes : [];
  const prevById = {};
  for (let i = 0; i < prevNodes.length; i++) {
    const n = prevNodes[i];
    if (n && n.id != null) prevById[n.id] = n;
  }
  const prevIds = Object.keys(prevById);
  const nextIds = {};
  for (let i = 0; i < nextNodes.length; i++) {
    if (nextNodes[i] && nextNodes[i].id != null) nextIds[nextNodes[i].id] = true;
  }
  let nodeSetChanged = prevIds.length !== Object.keys(nextIds).length;
  if (!nodeSetChanged) {
    for (let i = 0; i < prevIds.length; i++) {
      if (!nextIds[prevIds[i]]) {
        nodeSetChanged = true;
        break;
      }
    }
  }

  const nodes = nextNodes.map(function (n) {
    const prev = prevById[n.id];
    if (!prev) return n;
    return Object.assign({}, n, {
      x: prev.x,
      y: prev.y,
      vx: prev.vx != null ? prev.vx : 0,
      vy: prev.vy != null ? prev.vy : 0,
      fixed: prev.fixed != null ? prev.fixed : n.fixed,
    });
  });

  const byId = {};
  for (let i = 0; i < nodes.length; i++) byId[nodes[i].id] = nodes[i];
  const links = nextLinks
    .map(function (l) {
      var source = typeof l.source === 'object' && l.source ? l.source : byId[l.source];
      var target = typeof l.target === 'object' && l.target ? l.target : byId[l.target];
      var src =
        source && source.id != null && byId[source.id] ? byId[source.id] : source;
      var tgt =
        target && target.id != null && byId[target.id] ? byId[target.id] : target;
      if (!src || !tgt) return null;
      return {
        source: src,
        target: tgt,
        kind: l.kind,
        recent: l.recent,
      };
    })
    .filter(Boolean);

  var alpha;
  if (opts.preserveAlpha && prevSim && typeof prevSim.alpha === 'number' && !nodeSetChanged) {
    alpha = prevSim.alpha;
  } else if (nodeSetChanged || !prevSim) {
    alpha = opts.reheatAlpha != null ? opts.reheatAlpha : 1;
  } else {
    alpha = typeof prevSim.alpha === 'number' ? prevSim.alpha : 1;
  }

  return {
    nodes: nodes,
    links: links,
    w: nextBuilt.w,
    h: nextBuilt.h,
    cx: nextBuilt.cx,
    cy: nextBuilt.cy,
    alpha: alpha,
    nodeSetChanged: nodeSetChanged,
  };
}

if (typeof module !== 'undefined' && module.exports && typeof document === 'undefined') {
  module.exports = { mergeSimPreserve, renderProjectMemory, renderGraphHint, renderMarkdown, resolveDocumentLink, renderTaskCompletion };
} else {
  (function () {
    const reduced =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;

    const svg = document.getElementById('graph');
    const stage = document.getElementById('stage');
    const metaEl = document.getElementById('meta');
    const statsEl = document.getElementById('stats');
    const detailEl = document.getElementById('detail');
    const eventsEl = document.getElementById('events');
    const spark24 = document.getElementById('spark24');
    const spark7 = document.getElementById('spark7');
    const hintEl = document.getElementById('hint');
    const actionStatus = document.getElementById('action-status');
    const graphTooltip = document.getElementById('graph-tooltip');
    const projectSelect = document.getElementById('project-select');
    const memoryEl = document.getElementById('project-memory');
    const documentDialog = document.getElementById('document-dialog');
    const documentTitle = document.getElementById('document-title');
    const documentPath = document.getElementById('document-path');
    const documentContent = document.getElementById('document-content');
    const documentNotice = document.getElementById('document-notice');
    const documentToggle = document.getElementById('document-toggle');
    const snapshotData = document.getElementById('aflt-dashboard-data');

    let state = null;
    let selectedId = null;
    let hoverId = null;
    let focusId = null;
    let tooltipId = null;
    let tooltipHovered = false;
    let tooltipHideTimer = null;
    let sim = null;
    let graphLayers = null;
    const graphNodes = new Map();
    let lastUpdatedAt = Date.now();
    let raf = 0;
    let selectedDocument = null;
    let documentSource = false;
    let openingHerdr = false;

    async function openInHerdr(id) {
      if (openingHerdr) return;
      const session = (state.sessions || []).find(function (s) { return s.id === id; });
      if (!session) return;
      actionStatus.hidden = false;
      actionStatus.setAttribute('class', 'action-status');
      if (snapshotData || !state.actions || !state.actions.herdrFocusToken) {
        actionStatus.textContent = 'Open the live local dashboard to select this agent in Herdr.';
        return;
      }
      openingHerdr = true;
      actionStatus.textContent = 'Opening ' + session.title + ' in Herdr...';
      try {
        const response = await fetch('/api/herdr/focus/' + encodeURIComponent(id), {
          method: 'POST',
          headers: { 'X-Aflt-Action-Token': state.actions.herdrFocusToken },
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Unable to open the agent in Herdr.');
        actionStatus.textContent = 'Selected ' + session.title + ' in Herdr.';
      } catch (err) {
        actionStatus.setAttribute('class', 'action-status error');
        actionStatus.textContent = String(err.message || err);
      } finally {
        openingHerdr = false;
      }
    }

    const COLORS = {
      working: 'var(--cp-success)',
      completed: 'var(--cp-link)',
      waiting: 'var(--cp-warning)',
      running: 'var(--cp-success)',
      idle: 'var(--cp-warning)',
      done: 'var(--cp-text-muted)',
      failed: 'var(--cp-danger)',
    };

    function ago(ms) {
      const s = Math.max(0, Math.round(ms / 1000));
      if (s < 60) return s + 's ago';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm ago';
      return Math.floor(m / 60) + 'h ago';
    }

    function tickMeta() {
      if (!state) {
        metaEl.textContent = 'local · connecting…';
        return;
      }
      if (snapshotData) {
        metaEl.textContent = 'snapshot · ' + state.generatedAt;
        return;
      }
      if (state.error) {
        metaEl.textContent = 'dashboard error · ' + state.error;
        return;
      }
      if (state.completions && state.completions.errors.length) {
        metaEl.textContent = 'completion error · ' + state.completions.errors.join('; ');
        return;
      }
      metaEl.textContent = 'local · updated ' + ago(Date.now() - lastUpdatedAt) +
        (state.completions && state.completions.captureEnabled ? ' · completion capture on' : '');
    }
    setInterval(tickMeta, 1000);

    function sparkPath(series, w, h) {
      const vals = series || [];
      if (!vals.length) return '';
      const max = Math.max(1, ...vals);
      const step = w / Math.max(vals.length - 1, 1);
      return vals
        .map(function (v, i) {
          const x = i * step;
          const y = h - (v / max) * (h - 4) - 2;
          return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
        })
        .join(' ');
    }

    function drawSpark(el, series, color) {
      const w = 280;
      const h = 40;
      const d = sparkPath(series, w, h);
      el.innerHTML =
        '<path d="' +
        d +
        '" fill="none" stroke="' +
        color +
        '" stroke-width="1.6" stroke-linejoin="round"/>';
    }

    function renderStats(s) {
      const st = s.stats || {};
      const eng = st.engines || {};
      statsEl.innerHTML =
        '<div class="stat"><div class="k">active projects</div><div class="v">' +
        (st.activeProjects || 0) +
        '</div></div>' +
        '<div class="stat"><div class="k">running</div><div class="v running">' +
        (st.runningSessions || 0) +
        '</div></div>' +
        '<div class="engines">cursor ' +
        (eng.cursor || 0) +
        ' · copilot ' +
        (eng.copilot || 0) +
        ' · open ' +
        (st.open || 0) +
        ' · idle ' +
        (st.idle || 0) +
        ' · done ' +
        (st.done || 0) +
        ' · failed ' +
        (st.failed || 0) +
        '</div>';
    }

    function renderEvents(s) {
      const events = s.events || [];
      eventsEl.innerHTML = events
        .map(function (ev) {
          const when = String(ev.at || '')
            .replace('T', ' ')
            .slice(0, 19);
          return (
            '<li><span class="when">' +
            esc(when) +
            '</span>' +
            esc(ev.text || '') +
            '</li>'
          );
        })
        .join('');
    }

    function esc(s) {
      return escapeHtml(s);
    }

    function currentProject() {
      const item = findSelection();
      if (!item) return null;
      return item.name && item.sessionCount != null ? item : (state.projects || []).find(function (p) {
        return p.name === item.project;
      });
    }

    function renderMemory() {
      const project = currentProject();
      const options = '<option value="">Select a project</option>' + (state.projects || []).map(function (p) {
        return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>';
      }).join('');
      if (projectSelect.innerHTML !== options) projectSelect.innerHTML = options;
      projectSelect.value = project ? project.id : '';
      const html = renderProjectMemory(project, state.memory);
      if (memoryEl.innerHTML !== html) memoryEl.innerHTML = html;
      if (documentDialog.open && selectedDocument) showDocument(selectedDocument);
    }

    function showDocument(selection) {
      const project = (state.projects || []).find(function (p) { return p.id === selection.project; });
      const doc = project && project.memory && project.memory.documents.find(function (d) {
        return d.path === selection.path;
      });
      documentTitle.textContent = doc ? doc.title : 'Document unavailable';
      documentPath.textContent = selection.path;
      const content = doc ? doc.content : 'This document is no longer available. Close this reader and select another document.';
      const html = documentSource
        ? '<pre class="markdown-source">' + escapeHtml(content) + '</pre>'
        : renderMarkdown(content);
      if (documentContent.innerHTML !== html) documentContent.innerHTML = html;
      documentToggle.textContent = documentSource ? 'Render Markdown' : 'View source';
      documentNotice.textContent = 'Read-only ' + (documentSource ? 'Markdown source' : 'Markdown preview') +
        ' · sensitive values redacted' +
        (doc && doc.truncated ? ' · truncated to 32 KiB. Open the source file for the full document.' : '') +
        (documentSource ? '' : ' · images shown as text');
    }

    documentToggle.addEventListener('click', function () {
      documentSource = !documentSource;
      if (selectedDocument) showDocument(selectedDocument);
    });
    documentContent.addEventListener('click', function (event) {
      const link = event.target.closest('a[data-document-link]');
      if (!link || !selectedDocument) return;
      event.preventDefault();
      const target = resolveDocumentLink(state.projects, selectedDocument.path, link.dataset.documentLink);
      if (!target) {
        documentNotice.textContent = 'This linked document is not included in the read-only preview. Open it from the source repository.';
        return;
      }
      selectedDocument = { project: target.project, path: target.path };
      showDocument(selectedDocument);
      if (target.fragment) {
        const heading = document.getElementById('document-heading-' + target.fragment);
        if (heading) heading.scrollIntoView({ block: 'start' });
        else documentNotice.textContent = 'The linked heading was not found in this preview.';
      }
    });

    projectSelect.addEventListener('change', function () {
      selectedId = projectSelect.value || null;
      renderDetail();
    });
    memoryEl.addEventListener('click', function (event) {
      const button = event.target.closest('button[data-document-path]');
      const project = currentProject();
      if (!button || !project) return;
      selectedDocument = { project: project.id, path: button.dataset.documentPath };
      showDocument(selectedDocument);
      documentDialog.showModal();
    });
    document.getElementById('document-close').addEventListener('click', function () {
      documentDialog.close();
    });

    function findSelection() {
      if (!selectedId || !state) return null;
      if (String(selectedId).startsWith('project:')) {
        const name = String(selectedId).slice('project:'.length);
        return (state.projects || []).find(function (p) {
          return p.name === name || p.id === selectedId;
        });
      }
      return (state.sessions || []).find(function (s) {
        return s.id === selectedId;
      });
    }

    function renderDetail() {
      renderMemory();
      const item = findSelection();
      if (!item) {
        detailEl.innerHTML = '<div class="empty">select a project or session</div>';
        return;
      }
      if (item.sessionCount != null && item.name) {
        detailEl.innerHTML =
          '<div class="label">project</div><h2>' +
          esc(item.name) +
          '</h2><span class="badge ' +
          esc(item.displayState) +
          '">' +
          esc(item.displayState) +
          '</span><dl>' +
          row('sessions', item.sessionCount) +
          row('running', item.runningCount) +
          row('last activity', item.lastActivity || '—') +
          '</dl>' + renderTaskCompletion(item.completion);
        return;
      }
      const kids = (item.children || []).length;
      detailEl.innerHTML =
        '<div class="label">session</div><h2>' +
        esc(item.title) +
        '</h2><span class="badge ' +
        esc(item.activityState || (item.awaitingInput ? 'waiting' : item.displayState)) +
        '">' +
        esc(activityLabel(item)) +
        '</span><dl>' +
        row('id', item.id) +
        row('project', item.project) +
        row('engine', item.engine) +
        row('status', item.status) +
        row('worker', item.workerStatus || '—') +
        row('cwd', item.cwd || '—') +
        row('model', item.model || '—') +
        row('last used', item.lastUsed || '—') +
        row('last exit', item.lastExit == null ? '—' : item.lastExit) +
        row('error', item.lastError || '—') +
        row(
          'herdr',
          item.herdr && item.herdr.runtime
            ? item.herdr.runtime + (item.herdr.name ? ' · ' + item.herdr.name : '')
            : '—'
        ) +
        row('children', kids) +
        '</dl>' + renderTaskCompletion(item.completion);
    }

    function row(k, v) {
      return '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>';
    }

    function buildSim(s) {
      const rect = svg.getBoundingClientRect();
      const w = Math.max(rect.width || 800, 320);
      const h = Math.max(rect.height || 600, 320);
      svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);

      const nodes = [];
      const links = [];
      const projects = s.projects || [];
      const sessions = s.sessions || [];
      const n = Math.max(projects.length, 1);
      const hubR = Math.min(w, h) * 0.28;
      const cx = w * 0.5;
      const cy = h * 0.5;

      projects.forEach(function (p, i) {
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
        nodes.push({
          id: p.id,
          kind: 'project',
          label: p.name,
          displayState: p.displayState,
          x: cx + Math.cos(angle) * hubR,
          y: cy + Math.sin(angle) * hubR,
          vx: 0,
          vy: 0,
          r: 20,
          fixed: reduced,
        });
      });

      const hub = {};
      nodes.forEach(function (n) {
        if (n.kind === 'project') hub[n.label] = n;
      });

      sessions.forEach(function (sess, idx) {
        const parent = hub[sess.project] || { x: cx, y: cy };
        const a = ((idx % 12) / 12) * Math.PI * 2;
        nodes.push({
          id: sess.id,
          kind: 'session',
          label: sess.nodeLabel || sess.id,
          displayState: sess.displayState,
          activityState: sess.activityState,
          awaitingInput: !!sess.awaitingInput,
          recent: !!sess.recent,
          x: parent.x + Math.cos(a) * 70,
          y: parent.y + Math.sin(a) * 70,
          vx: 0,
          vy: 0,
          r: 8,
          project: sess.project,
        });
      });

      const sessionById = new Map(sessions.map(function (sess) { return [sess.id, sess]; }));
      (s.links || []).forEach(function (l) {
        links.push({
          source: l.from, target: l.to, kind: l.kind,
          recent: !!(sessionById.get(l.to) || {}).recent,
        });
      });

      const byId = {};
      nodes.forEach(function (n) {
        byId[n.id] = n;
      });
      const resolved = links
        .map(function (l) {
          return {
            source: byId[l.source],
            target: byId[l.target],
            kind: l.kind,
            recent: l.recent,
          };
        })
        .filter(function (l) {
          return l.source && l.target;
        });

      return { nodes: nodes, links: resolved, w: w, h: h, cx: cx, cy: cy, alpha: 1 };
    }

    function stepSim(model) {
      if (reduced) return;
      if (model.alpha == null) model.alpha = 1;
      if (model.alpha < 0.002) {
        for (let i = 0; i < model.nodes.length; i++) {
          model.nodes[i].vx = 0;
          model.nodes[i].vy = 0;
        }
        return;
      }
      const alpha = model.alpha;
      const nodes = model.nodes;
      const links = model.links;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy || 1;
          const dist = Math.sqrt(d2);
          const min = (a.r + b.r) * 2.2;
          if (dist < min) {
            const f = ((min - dist) / dist) * 0.04 * alpha;
            dx *= f;
            dy *= f;
            if (!a.fixed) {
              a.vx -= dx;
              a.vy -= dy;
            }
            if (!b.fixed) {
              b.vx += dx;
              b.vy += dy;
            }
          } else {
            const f = (18 / d2) * alpha;
            dx *= f;
            dy *= f;
            if (!a.fixed) {
              a.vx -= dx;
              a.vy -= dy;
            }
            if (!b.fixed) {
              b.vx += dx;
              b.vy += dy;
            }
          }
        }
      }
      for (let i = 0; i < links.length; i++) {
        const l = links[i];
        const a = l.source;
        const b = l.target;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const ideal = l.kind === 'parent' ? 90 : 70;
        const f = ((dist - ideal) / dist) * 0.02 * alpha;
        dx *= f;
        dy *= f;
        if (!a.fixed) {
          a.vx += dx;
          a.vy += dy;
        }
        if (!b.fixed) {
          b.vx -= dx;
          b.vy -= dy;
        }
      }
      let ke = 0;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.kind === 'project') {
          const dx = model.cx - n.x;
          const dy = model.cy - n.y;
          n.vx += dx * 0.002 * alpha;
          n.vy += dy * 0.002 * alpha;
        }
        if (n.fixed) {
          n.vx = 0;
          n.vy = 0;
          continue;
        }
        n.vx *= 0.86;
        n.vy *= 0.86;
        n.x += n.vx;
        n.y += n.vy;
        n.x = Math.max(n.r + 8, Math.min(model.w - n.r - 8, n.x));
        n.y = Math.max(n.r + 8, Math.min(model.h - n.r - 8, n.y));
        ke += n.vx * n.vx + n.vy * n.vy;
      }
      if (ke < 0.00005) {
        model.alpha = 0;
      } else {
        model.alpha *= 0.988;
      }
    }

    function positionGraphTooltip() {
      if (!tooltipId || !sim || tooltipHovered) return;
      const node = sim.nodes.find(function (n) { return n.id === tooltipId; });
      if (!node) return;
      const graphRect = svg.getBoundingClientRect();
      const tipRect = graphTooltip.getBoundingClientRect();
      const sx = graphRect.width / sim.w;
      const sy = graphRect.height / sim.h;
      let left = (node.x + node.r) * sx + 12;
      if (left + tipRect.width > graphRect.width - 12) {
        left = (node.x - node.r) * sx - tipRect.width - 12;
      }
      graphTooltip.style.left = Math.max(12, Math.min(left, graphRect.width - tipRect.width - 12)) + 'px';
      graphTooltip.style.top = Math.max(12, Math.min(node.y * sy - tipRect.height / 2,
        graphRect.height - tipRect.height - 12)) + 'px';
    }

    function cancelTooltipHide() {
      if (tooltipHideTimer !== null) clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;
    }

    function dismissGraphTooltip() {
      cancelTooltipHide();
      hoverId = null;
      focusId = null;
      tooltipId = null;
      tooltipHovered = false;
      renderGraphTooltip();
    }

    function scheduleTooltipHide() {
      cancelTooltipHide();
      if (hoverId || focusId || tooltipHovered) return;
      tooltipHideTimer = setTimeout(function () {
        tooltipHideTimer = null;
        if (!hoverId && !focusId && !tooltipHovered) dismissGraphTooltip();
      }, 450);
    }

    function renderGraphTooltip() {
      const id = hoverId || focusId || tooltipId;
      const session = state && (state.sessions || []).find(function (s) { return s.id === id; });
      const project = state && (state.projects || []).find(function (p) {
        return p.id === id || (session && p.name === session.project);
      });
      const nextId = session || project ? id : null;
      if (tooltipHovered && nextId && tooltipId === nextId) return;
      tooltipId = nextId;
      if (!tooltipId) {
        tooltipHovered = false;
        cancelTooltipHide();
      }
      graphTooltip.hidden = !tooltipId;
      const html = renderGraphHint(project, session);
      if (graphTooltip.innerHTML !== html) graphTooltip.innerHTML = html;
      hintEl.textContent = tooltipId
        ? 'click for details · double-click an agent for Herdr · Esc to dismiss hint'
        : 'hover a node · click for details · double-click an agent for Herdr';
      positionGraphTooltip();
    }

    function drawGraph() {
      if (!sim) return;
      const ns = 'http://www.w3.org/2000/svg';
      if (!graphLayers) {
        graphLayers = ['stars', 'edges', 'nodes'].map(function () {
          const group = document.createElementNS(ns, 'g');
          svg.appendChild(group);
          return group;
        });
      }
      const stars = graphLayers[0];
      const edgeG = graphLayers[1];
      const nodeG = graphLayers[2];
      while (stars.firstChild) stars.removeChild(stars.firstChild);
      while (edgeG.firstChild) edgeG.removeChild(edgeG.firstChild);

      for (let i = 0; i < 50; i++) {
        const c = document.createElementNS(ns, 'circle');
        c.setAttribute('cx', String((i * 97) % sim.w));
        c.setAttribute('cy', String((i * 53) % sim.h));
        c.setAttribute('r', '1');
        c.setAttribute('fill', 'var(--cp-text-muted)');
        c.setAttribute('opacity', String(0.12 + (i % 5) * 0.04));
        stars.appendChild(c);
      }
      sim.links.forEach(function (l) {
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', l.source.x);
        line.setAttribute('y1', l.source.y);
        line.setAttribute('x2', l.target.x);
        line.setAttribute('y2', l.target.y);
        line.setAttribute(
          'class',
          'edge ' + l.kind + (l.recent ? ' recent' : '')
        );
        edgeG.appendChild(line);

        if (!reduced && l.recent) {
          const t = (Date.now() / 1000) % 1;
          const tx = l.source.x + (l.target.x - l.source.x) * t;
          const ty = l.source.y + (l.target.y - l.source.y) * t;
          const dot = document.createElementNS(ns, 'circle');
          dot.setAttribute('cx', tx);
          dot.setAttribute('cy', ty);
          dot.setAttribute('r', '2.2');
          dot.setAttribute('class', 'traveler');
          edgeG.appendChild(dot);
        }
      });
      const visibleIds = new Set(sim.nodes.map(function (n) { return n.id; }));
      graphNodes.forEach(function (entry, id) {
        if (!visibleIds.has(id)) {
          nodeG.removeChild(entry.group);
          graphNodes.delete(id);
        }
      });
      sim.nodes.forEach(function (n) {
        let entry = graphNodes.get(n.id);
        if (!entry) {
          const g = document.createElementNS(ns, 'g');
          const circle = document.createElementNS(ns, 'circle');
          const label = document.createElementNS(ns, 'text');
          g.setAttribute('data-id', n.id);
          g.setAttribute('role', 'button');
          g.setAttribute('tabindex', '0');
          g.setAttribute('aria-describedby', 'graph-tooltip');
          g.appendChild(circle);
          g.appendChild(label);
          let waiting = null;
          let working = null;
          if (n.kind === 'session') {
            const indicator = document.createElementNS(ns, 'g');
            const ring = document.createElementNS(ns, 'circle');
            const badge = document.createElementNS(ns, 'circle');
            const mark = document.createElementNS(ns, 'text');
            indicator.setAttribute('class', 'waiting-indicator');
            indicator.setAttribute('aria-hidden', 'true');
            ring.setAttribute('class', 'waiting-ring');
            badge.setAttribute('class', 'waiting-badge');
            badge.setAttribute('r', '7');
            mark.setAttribute('class', 'waiting-mark');
            mark.textContent = '?';
            indicator.appendChild(ring);
            indicator.appendChild(badge);
            indicator.appendChild(mark);
            g.appendChild(indicator);
            waiting = { group: indicator, ring: ring, badge: badge, mark: mark };
            working = document.createElementNS(ns, 'circle');
            working.setAttribute('class', 'working-indicator');
            working.setAttribute('aria-hidden', 'true');
            working.setAttribute('pathLength', '100');
            g.appendChild(working);
          }
          g.addEventListener('mouseenter', function () {
            cancelTooltipHide();
            focusId = null;
            hoverId = n.id;
            renderGraphTooltip();
          });
          g.addEventListener('mouseleave', function () {
            if (hoverId === n.id) hoverId = null;
            scheduleTooltipHide();
          });
          g.addEventListener('focus', function () {
            cancelTooltipHide();
            if (hoverId !== n.id) focusId = n.id;
            renderGraphTooltip();
          });
          g.addEventListener('blur', function () {
            if (focusId === n.id) focusId = null;
            scheduleTooltipHide();
          });
          function selectNode(ev) {
            ev.stopPropagation();
            selectedId = n.id;
            renderDetail();
          }
          g.addEventListener('click', selectNode);
          if (n.kind === 'session') {
            g.addEventListener('dblclick', function (ev) {
              ev.stopPropagation();
              openInHerdr(n.id);
            });
          }
          g.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') {
              dismissGraphTooltip();
            }
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              selectNode(ev);
            }
          });
          nodeG.appendChild(g);
          entry = { group: g, circle: circle, label: label, waiting: waiting, working: working };
          graphNodes.set(n.id, entry);
        }
        const g = entry.group;
        const c = entry.circle;
        const label = entry.label;
        g.setAttribute('class', 'node-hit' + (selectedId === n.id ? ' selected' : ''));
        g.setAttribute('aria-label', n.kind === 'session' ? n.id + ' — ' + activityLabel(n) : n.label);
        g.setAttribute('aria-pressed', String(selectedId === n.id));
        c.setAttribute('cx', n.x);
        c.setAttribute('cy', n.y);
        c.setAttribute('r', n.r);
        c.setAttribute('style', '--cp-node-color: ' +
          (COLORS[n.activityState || (n.awaitingInput ? 'waiting' : n.displayState)] || COLORS.done));
        label.setAttribute('x', n.x);
        label.setAttribute('text-anchor', 'middle');
        label.textContent = n.label;

        if (n.kind === 'project') {
          c.setAttribute('class', 'hub');
          c.setAttribute('stroke', COLORS[n.displayState] || COLORS.done);
          label.setAttribute('y', n.y + n.r + 14);
          label.setAttribute('class', 'hub-label');
          label.setAttribute('visibility', 'visible');
        } else {
          c.setAttribute(
            'class',
            'leaf ' +
              (n.activityState || n.displayState || 'done') +
              (n.awaitingInput ? ' awaiting-input' : '') +
              (n.activityState === 'working' && !reduced ? ' pulse' : '')
          );
          label.setAttribute('y', n.y + n.r + 14);
          label.setAttribute('class', 'session-label');
          label.setAttribute('visibility', 'visible');
          const waiting = entry.waiting;
          waiting.group.setAttribute('visibility', n.awaitingInput ? 'visible' : 'hidden');
          waiting.ring.setAttribute('cx', n.x);
          waiting.ring.setAttribute('cy', n.y);
          waiting.ring.setAttribute('r', n.r + 4);
          waiting.badge.setAttribute('cx', n.x + n.r + 6);
          waiting.badge.setAttribute('cy', n.y - n.r - 2);
          waiting.mark.setAttribute('x', n.x + n.r + 6);
          waiting.mark.setAttribute('y', n.y - n.r + 2);
          entry.working.setAttribute('visibility', n.activityState === 'working' ? 'visible' : 'hidden');
          entry.working.setAttribute('cx', n.x);
          entry.working.setAttribute('cy', n.y);
          entry.working.setAttribute('r', n.r + 4);
        }
      });
      positionGraphTooltip();
    }

    function loop() {
      if (sim && !reduced) stepSim(sim);
      drawGraph();
      raf = requestAnimationFrame(loop);
    }

    function applyState(next, opts) {
      opts = opts || {};
      state = next;
      if (!selectedId) {
        const first = (state.projects || []).find(function (p) {
          return p.memory && (p.memory.summary || p.memory.documents.length);
        });
        if (first) selectedId = first.id;
      }
      lastUpdatedAt = Date.now();
      tickMeta();
      renderStats(state);
      drawSpark(spark24, state.sparkline24h, 'var(--cp-accent)');
      drawSpark(spark7, state.sparkline7d, 'var(--cp-link)');
      renderEvents(state);
      renderDetail();
      const built = buildSim(state);
      if (!sim || opts.forceRebuild) {
        sim = Object.assign({}, built, { alpha: 1, nodeSetChanged: true });
      } else {
        sim = mergeSimPreserve(sim, built, { preserveAlpha: true, reheatAlpha: 0.85 });
      }
      renderGraphTooltip();
    }

    graphTooltip.addEventListener('mouseenter', function () {
      cancelTooltipHide();
      hoverId = null;
      focusId = null;
      tooltipHovered = true;
    });
    graphTooltip.addEventListener('mouseleave', function () {
      tooltipHovered = false;
      scheduleTooltipHide();
    });
    graphTooltip.addEventListener('click', function (ev) {
      ev.stopPropagation();
    });
    stage.addEventListener('click', function () {
      selectedId = null;
      dismissGraphTooltip();
      renderDetail();
    });
    window.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') dismissGraphTooltip();
    });

    window.addEventListener('resize', function () {
      if (state) applyState(state, { forceRebuild: true });
    });

    function connectSse() {
      const es = new EventSource('/events');
      es.onmessage = function (msg) {
        try {
          applyState(JSON.parse(msg.data));
        } catch (_) {
          /* ignore */
        }
      };
      es.onerror = function () {
        metaEl.textContent = 'local · reconnecting…';
      };
    }

    if (snapshotData) {
      applyState(JSON.parse(snapshotData.textContent), { forceRebuild: true });
      raf = requestAnimationFrame(loop);
      return;
    }

    fetch('/api/state')
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        applyState(data, { forceRebuild: true });
        if (!raf) raf = requestAnimationFrame(loop);
        connectSse();
      })
      .catch(function () {
        metaEl.textContent = 'local · failed to load';
        connectSse();
        if (!raf) raf = requestAnimationFrame(loop);
      });
  })();
}
