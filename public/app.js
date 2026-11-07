// Business Agent Lab dashboard (vanilla JS, no build step).
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS_LABEL = { queued: 'Queued', running: 'Running', needs_review: 'Needs review', blocked: 'Blocked', completed: 'Completed', failed: 'Failed' };

const state = { status: null, businesses: [], biz: null, runs: [], filter: 'all', runId: null, detailSig: '', view: 'queue' };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 3200);
}

function provBadge(p) {
  if (!p) return '';
  if (p.includes('mock')) return '<span class="badge mock" title="Produced by the deterministic mock adapter, not a language model">SIMULATED · mock</span>';
  if (p.includes('model')) return '<span class="badge model" title="Produced by a real language model">MODEL OUTPUT</span>';
  return '<span class="badge system" title="Deterministic system code">SYSTEM</span>';
}
const sampleBadge = (on) => (on ? '<span class="badge sample" title="Fictional client data">SAMPLE DATA</span>' : '');
const ago = (iso) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(iso).toLocaleString();
};

// ---------------- Minimal Markdown renderer (headings, lists, tables, code, quotes, bold, italics) ----------------
function md(src) {
  const lines = String(src || '').split('\n');
  let out = '';
  let i = 0;
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])_([^_]+)_(?=[\s).,]|$)/g, '$1<em>$2</em>');
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('```')) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out += `<pre>${esc(buf.join('\n'))}</pre>`;
      continue;
    }
    const h = l.match(/^(#{1,3}) (.*)/);
    if (h) { out += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; i++; continue; }
    if (l.startsWith('> ')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('> ')) buf.push(inline(lines[i++].slice(2)));
      out += `<blockquote>${buf.join('<br>')}</blockquote>`;
      continue;
    }
    if (l.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\|[-|\s]+\|$/.test(r));
      out += `<table>${body.map((r, k) => `<tr>${cells(r).map((c) => (k === 0 && rows[1] && /^\|[-|\s]+\|$/.test(rows[1]) ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join('')}</tr>`).join('')}</table>`;
      continue;
    }
    if (/^\s*([-*]|\d+\.) /.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*([-*]|\d+\.) /.test(lines[i])) {
        buf.push(inline(lines[i++].replace(/^\s*([-*]|\d+\.) /, '')).replace(/^\[ \] /, '☐ ').replace(/^\[x\] /i, '☑ '));
      }
      out += `<ul>${buf.map((b) => `<li>${b}</li>`).join('')}</ul>`;
      continue;
    }
    if (l.trim()) out += `<p>${inline(l)}</p>`;
    i++;
  }
  return out;
}

// ---------------- Header ----------------
function renderModes() {
  const s = state.status;
  const a = s.adapter;
  const parts = [];
  parts.push(a.provenance === 'mock'
    ? `<span class="badge mock" title="${esc(a.reason)}">MOCK EXECUTION · simulated outputs</span>`
    : `<span class="badge model">REAL MODEL · ${esc(a.model || '')}</span>`);
  if (!s.real_model.available) parts.push(`<span class="badge off" title="${esc(s.real_model.missing.join('\n'))}">Real model: disabled — ${esc(s.real_model.missing[0] || '')}${s.real_model.missing.length > 1 ? ` (+${s.real_model.missing.length - 1})` : ''}</span>`);
  parts.push(`<span class="badge off" title="${esc(s.notification_channel.note)}">Notifications: none configured</span>`);
  $('#modes').innerHTML = parts.join('');
}

function renderBizSelect() {
  $('#bizSelect').innerHTML = state.businesses.map((b) => {
    const attn = b.counts.needs_review + b.counts.blocked;
    return `<button type="button" data-biz="${b.id}" aria-pressed="${b.id === state.biz}">${esc(b.name)}${attn ? ` <span class="count">${attn}</span>` : ''}</button>`;
  }).join('');
  const pending = state.businesses.reduce((s, b) => s + b.counts.needs_review + b.counts.blocked, 0);
  $('#pendingCount').textContent = pending || '';
  document.querySelectorAll('.bizname').forEach((el) => { el.textContent = state.businesses.find((b) => b.id === state.biz)?.name || ''; });
}

async function renderContext() {
  const [ctx, samples] = await Promise.all([api(`/api/b/${state.biz}/context`), api(`/api/b/${state.biz}/samples`)]);
  const c = ctx.config;
  $('#contextCard').innerHTML = `
    <h2>${esc(ctx.name)} <span class="muted" style="font-weight:400">business context</span></h2>
    <div class="tagline">${esc(c.tagline)}</div>
    <div class="muted" style="font-size:.82rem">Region: ${esc(c.region)}</div>
    <h3>Request types</h3>
    <ul>${c.categories.map((x) => `<li>${esc(x.label)}</li>`).join('')}</ul>
    <h3>Guardrails</h3>
    <ul>${c.policies.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
    <h3>Shared specialist capabilities</h3>
    <div class="caps">${state.status.capabilities.map((x) => `<span class="badge system">${esc(x.label)}</span>`).join('')}</div>
    <div class="scope-note">Data access is scoped to ${esc(ctx.name)} on the server: other businesses' records cannot be read from this view.</div>`;
  $('#samples').innerHTML = samples.length
    ? `<div class="muted" style="font-size:.8rem">Sample inquiries (fictional) — one click submits:</div>` + samples.map((s) => `<button type="button" data-sample="${esc(s.key)}"><span class="badge sample">SAMPLE</span> ${esc(s.title)}</button>`).join('')
    : '';
}

// ---------------- Queue ----------------
function renderFilters() {
  const counts = state.businesses.find((b) => b.id === state.biz)?.counts || {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const opts = [['all', 'All', total], ...Object.keys(STATUS_LABEL).map((k) => [k, STATUS_LABEL[k], counts[k] || 0])];
  $('#filters').innerHTML = opts.map(([k, l, n]) => `<button type="button" role="tab" data-filter="${k}" aria-selected="${state.filter === k}">${l} ${n}</button>`).join('');
}

function renderRunList() {
  const runs = state.filter === 'all' ? state.runs : state.runs.filter((r) => r.status === state.filter);
  $('#runList').innerHTML = runs.length ? runs.map((r) => `
    <li><a href="#/${state.biz}/runs/${r.id}" class="${r.id === state.runId ? 'sel' : ''}">
      <div class="t">${esc(r.request_title)}</div>
      <div class="m"><span class="status ${r.status}">${STATUS_LABEL[r.status]}</span>
        <span>${esc(r.current_step === 'done' ? 'done' : r.current_step.replace('_', ' '))}</span>
        ${r.attempt > 1 ? `<span>attempt ${r.attempt}</span>` : ''}
        ${sampleBadge(r.request_is_sample)}
        <span>${ago(r.created_at)}</span></div>
    </a></li>`).join('') : `<li class="none">No ${state.filter === 'all' ? '' : STATUS_LABEL[state.filter].toLowerCase() + ' '}runs in this business yet.</li>`;
}

// ---------------- Run detail ----------------
function graphHtml(d) {
  const { run, graph, steps } = d;
  const idx = graph.findIndex((g) => g.id === run.current_step);
  const failedSteps = new Set(steps.filter((s) => s.status === 'failed').map((s) => s.step));
  return `<div class="graph" aria-label="Workflow graph">${graph.map((g, i) => {
    let cls = '';
    let mark = '○';
    if (run.status === 'completed' || (idx >= 0 && i < idx)) { cls = 'done'; mark = '✓'; }
    if (i === idx) {
      if (run.status === 'failed') { cls = 'failed'; mark = '✕'; }
      else if (run.status === 'needs_review') { cls = 'waiting'; mark = '…'; }
      else if (run.status === 'blocked') { cls = 'failed'; mark = '!'; }
      else { cls = 'current'; mark = run.status === 'running' ? '▶' : '◷'; }
    }
    const warn = failedSteps.has(g.id) && cls === 'done' ? ' title="Had a failed try before succeeding"' : '';
    return `${i ? '<span class="arrow">→</span>' : ''}<span class="node ${cls}"${warn}>${mark} ${esc(g.label)}</span>`;
  }).join('')}</div>
  <div class="loopnote">Attempt ${run.attempt} · quality repairs used ${run.repair_count}/2 · step retries ${run.step_failures}/2 · adapter: ${esc(run.adapter)}</div>`;
}

function checksHtml(q) {
  if (!q) return '<div class="muted">Not reviewed yet.</div>';
  return `<ul class="checks">${q.checks.map((c) => `<li><span class="${c.passed ? 'ok' : 'bad'}">${c.passed ? '✓' : '✕'}</span><span><strong>${esc(c.label)}</strong><br><span class="muted">${esc(c.detail)}</span></span></li>`).join('')}</ul>
  ${q.model_notes?.length ? `<div class="muted" style="font-size:.8rem">${q.model_notes.map(esc).join(' ')}</div>` : ''}`;
}

function reviewHtml(d) {
  const { run } = d;
  const draft = d.drafts.at(-1);
  const reviewable = run.status === 'needs_review' || (run.status === 'blocked' && ['held_by_reviewer', 'quality_failed_after_repairs'].includes(run.blocked_reason));
  if (!reviewable || !draft) return '';
  const passed = draft.quality?.passed;
  return `<section class="card review" id="reviewPanel">
    <h2>Your decision — draft v${draft.version} ${provBadge(draft.provenance)}</h2>
    <div class="muted" style="font-size:.85rem">Approve saves this exact version for Maya. <strong>Nothing is sent to the client.</strong></div>
    <div style="margin-top:.6rem"><strong>Subject:</strong> ${esc(draft.content.response_draft.subject)}</div>
    <div class="draftbody">${esc(draft.content.response_draft.body)}</div>
    <h3>Quality review ${passed ? '<span class="badge ok">passed</span>' : '<span class="badge bad">not passed</span>'}</h3>
    ${checksHtml(draft.quality)}
    <label style="display:block;font-size:.82rem;color:var(--muted);margin-top:.6rem">Notes (required for “Request changes”)
      <textarea id="reviewNotes" rows="3" placeholder="e.g. Make it shorter; mention we can call on Thursday"></textarea></label>
    <div class="actions">
      <button class="btn primary" data-review="approve" ${passed ? '' : 'disabled title="Only drafts that pass quality review can be approved"'}>Approve &amp; save</button>
      <button class="btn" data-review="request_changes">Request changes</button>
      <button class="btn" data-review="hold" ${run.status === 'needs_review' ? '' : 'disabled'}>Hold</button>
    </div>
  </section>`;
}

function briefHtml(d) {
  const draft = d.drafts.at(-1);
  const cls = d.steps.filter((s) => s.step === 'classify' && s.status === 'succeeded').at(-1);
  if (!draft && !cls) return '';
  const b = draft?.content.brief;
  return `<section class="card">
    <h2>Client brief ${provBadge(draft?.provenance || cls?.provenance)} ${sampleBadge(d.request.is_sample)}</h2>
    ${cls ? `<div><strong>Classification:</strong> ${esc(cls.output.label)} <span class="muted">(${esc(cls.output.category)}, confidence ${cls.output.confidence})</span><div class="muted" style="font-size:.82rem">${esc(cls.output.rationale)}</div></div>` : ''}
    ${b ? `
    <h3>Known facts <span class="muted" style="font-weight:400">— each quoted from the inquiry</span></h3>
    ${b.known_facts.length ? `<table class="facts"><tr><th>Field</th><th>Value</th><th>Evidence</th></tr>${b.known_facts.map((f) => `<tr><td>${esc(f.label)}</td><td>${esc(f.value)}</td><td class="quote">“${esc(f.evidence)}”</td></tr>`).join('')}</table>` : '<div class="muted">None extracted.</div>'}
    <div class="grid2">
      <div><h3>Missing information</h3>${b.missing_info.length ? `<ul class="tight">${b.missing_info.map((m) => `<li><strong>${esc(m.label)}</strong> — ${esc(m.question)}</li>`).join('')}</ul>` : '<div class="muted">Nothing outstanding.</div>'}</div>
      <div><h3>Proposed next actions</h3><ul class="tight">${b.next_actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>
    </div>
    ${b.observations?.length ? `<h3>Observations</h3><ul class="tight">${b.observations.map((o) => `<li><strong>${esc(o.label)}:</strong> ${esc(o.value)}</li>`).join('')}</ul>` : ''}` : ''}
  </section>`;
}

function draftsHtml(d) {
  if (!d.drafts.length) return '';
  const approvedId = d.result?.draft_id;
  return `<section class="card"><h2>Draft versions (${d.drafts.length})</h2>
    ${d.drafts.map((x) => `<details ${x === d.drafts.at(-1) && d.run.status !== 'needs_review' ? 'open' : ''}>
      <summary><strong>v${x.version}</strong> attempt ${x.attempt}${x.repair ? `, repair ${x.repair}` : ''}
        ${x.quality ? (x.quality.passed ? '<span class="badge ok">quality passed</span>' : `<span class="badge bad">quality failed: ${esc(x.quality.issues.map((i) => i.id).join(', '))}</span>`) : ''}
        ${x.id === approvedId ? '<span class="badge sample">APPROVED &amp; SAVED</span>' : ''}
        ${x.content.fault_injected ? '<span class="badge bad">test fault injected</span>' : ''}
        ${provBadge(x.provenance)}</summary>
      ${x.content.changes_from_previous?.length ? `<ul class="tight">${x.content.changes_from_previous.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
      <div class="draftbody">${esc(x.content.response_draft.body)}</div>
      ${x.quality ? checksHtml(x.quality) : ''}
    </details>`).join('')}
  </section>`;
}

function stepsHtml(d) {
  return `<section class="card"><h2>Steps, outputs &amp; evidence (${d.steps.length})</h2>
    ${d.steps.map((s) => `<details>
      <summary><span class="status ${s.status === 'succeeded' ? 'completed' : 'failed'}">${s.status}</span>
        <strong>${esc(s.step)}</strong> <span class="muted">attempt ${s.attempt} · repair ${s.repair} · try ${s.try}</span> ${provBadge(s.provenance)}</summary>
      ${s.error ? `<div class="banner err">${esc(s.error)}</div>` : ''}
      ${s.evidence?.length ? `<ul class="evlist">${s.evidence.map((e) => `<li>${esc(e.type)}${e.id ? ` ${esc(e.id)}` : ''}${e.passed !== undefined ? (e.passed ? ' ✓' : ' ✕') : ''}${e.detail ? `: ${esc(e.detail)}` : ''}</li>`).join('')}</ul>` : ''}
      <pre>${esc(JSON.stringify(s.output, null, 2))}</pre>
      <div class="muted" style="font-size:.75rem">${esc(s.started_at)} → ${esc(s.finished_at)}</div>
    </details>`).join('') || '<div class="muted">No steps yet.</div>'}
  </section>`;
}

function handoffHtml(d) {
  if (!d.handoff) {
    return d.run.status === 'completed' ? '' : `<section class="card"><h2>Maya handoff</h2><div class="muted">Created automatically after you approve a draft.</div></section>`;
  }
  return `<section class="card accent handoff">
    <div class="copyrow"><h2>Maya handoff</h2><button class="btn primary small" id="copyHandoff">Copy Markdown</button></div>
    <div class="md">${md(d.handoff.markdown)}</div>
    <details><summary>Raw Markdown</summary><pre class="md-src" id="handoffSrc">${esc(d.handoff.markdown)}</pre></details>
  </section>`;
}

function historyHtml(d) {
  return `<section class="card"><details><summary><strong>Event log (${d.events.length})</strong> &amp; decisions</summary>
    <h3>Decisions</h3>
    <ul class="tight">${d.decisions.map((x) => `<li><strong>${esc(x.status)}</strong> · ${esc(x.title)} — ${esc(x.summary)}${x.resolution ? ` → ${esc(x.resolution)}` : ''}</li>`).join('') || '<li class="muted">None</li>'}</ul>
    <h3>Reviews</h3>
    <ul class="tight">${d.reviews.map((r) => `<li>${esc(r.created_at)} · <strong>${esc(r.action)}</strong> by ${esc(r.decided_by)}${r.notes ? `: ${esc(r.notes)}` : ''}</li>`).join('') || '<li class="muted">None</li>'}</ul>
    <h3>Events</h3>
    <pre>${esc(d.events.map((e) => `${e.created_at}  ${e.type}  ${JSON.stringify(e.data)}`).join('\n'))}</pre>
  </details></section>`;
}

function renderDetail(d) {
  const { run, request } = d;
  let banner = '';
  if (run.status === 'failed') banner = `<div class="banner err"><strong>Failed:</strong> ${esc(run.error)}</div>`;
  else if (run.status === 'blocked') banner = `<div class="banner warn"><strong>Blocked:</strong> ${esc({ held_by_reviewer: 'On hold by Lea.', quality_failed_after_repairs: 'Draft still fails quality review after 2 automatic repairs. Your decision is needed.' }[run.blocked_reason] || run.blocked_reason)}</div>`;
  else if (run.status === 'needs_review') banner = `<div class="banner info">Waiting for your decision. This survives restarts; nothing happens until you decide.</div>`;
  else if (run.status === 'completed') banner = `<div class="banner info">Completed: approved draft v${d.result?.draft_version} saved and Maya handoff created. Not sent to anyone.</div>`;
  $('#runDetail').innerHTML = `
    <section class="card">
      <div class="detail-head">
        <div><h2 style="margin:0">${esc(request.title)}</h2>
          <div class="ids">Run ${esc(run.id)} · created ${esc(new Date(run.created_at).toLocaleString())}</div></div>
        <div><span class="status ${run.status}">${STATUS_LABEL[run.status]}</span> ${sampleBadge(request.is_sample)}</div>
      </div>
      ${banner}
      ${graphHtml(d)}
      <details><summary>Original inquiry ${sampleBadge(request.is_sample)}</summary>
        <div class="muted" style="font-size:.85rem">From: ${esc(request.contact?.name || '—')} ${request.contact?.company ? `· ${esc(request.contact.company)}` : ''} ${request.contact?.email ? `· ${esc(request.contact.email)}` : ''}</div>
        <div class="draftbody">${esc(request.body)}</div></details>
    </section>
    ${reviewHtml(d)}
    ${handoffHtml(d)}
    ${briefHtml(d)}
    ${draftsHtml(d)}
    ${stepsHtml(d)}
    ${historyHtml(d)}`;
}

async function loadDetail(force = false) {
  if (!state.runId) {
    $('#runDetail').innerHTML = '<div class="card empty">Select a run to see its graph, outputs, evidence and review controls.</div>';
    state.detailSig = '';
    return;
  }
  try {
    const d = await api(`/api/b/${state.biz}/runs/${state.runId}`);
    const sig = `${d.run.updated_at}|${d.steps.length}|${d.events.length}`;
    if (!force && sig === state.detailSig) return;
    const notes = $('#reviewNotes')?.value;
    state.detailSig = sig;
    renderDetail(d);
    if (notes && $('#reviewNotes')) $('#reviewNotes').value = notes;
  } catch (e) {
    $('#runDetail').innerHTML = `<div class="card empty">${esc(e.message)}</div>`;
    state.detailSig = '';
  }
}

// ---------------- Checkpoint ----------------
async function renderCheckpoint() {
  const cp = await api('/api/checkpoint');
  $('#cpNote').textContent = cp.app ? `Last generated ${new Date(cp.app.created_at).toLocaleString()}. ${state.status.notification_channel.note}` : `No checkpoint generated yet. ${state.status.notification_channel.note}`;
  $('#appCheckpoint').innerHTML = cp.app ? md(cp.app.markdown) : '';
  $('#supCheckpoint').innerHTML = cp.supervisor ? md(cp.supervisor.markdown) : '<p class="muted">The coding supervisor has not written a checkpoint yet (run <code>npm run supervisor -- start</code>).</p>';
}

// ---------------- Wiring ----------------
async function refresh() {
  const businesses = await api('/api/businesses');
  state.businesses = businesses;
  renderBizSelect();
  if (state.view === 'queue') {
    state.runs = await api(`/api/b/${state.biz}/runs`);
    renderFilters();
    renderRunList();
    await loadDetail();
  }
}

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 'checkpoint') {
    state.view = 'checkpoint';
  } else {
    state.view = 'queue';
    if (parts[0] && state.businesses.some((b) => b.id === parts[0])) state.biz = parts[0];
    state.runId = parts[1] === 'runs' ? parts[2] : null;
  }
  $('#viewQueue').hidden = state.view !== 'queue';
  $('#viewCheckpoint').hidden = state.view !== 'checkpoint';
  $('#tabQueue').classList.toggle('active', state.view === 'queue');
  $('#tabCheckpoint').classList.toggle('active', state.view === 'checkpoint');
  $('#tabQueue').href = `#/${state.biz}`;
  if (state.biz !== state.contextBiz) { state.contextBiz = state.biz; renderContext(); }
  if (state.view === 'checkpoint') renderCheckpoint();
  state.detailSig = '';
  refresh();
}

document.addEventListener('click', async (e) => {
  const biz = e.target.closest('[data-biz]');
  if (biz) { location.hash = `#/${biz.dataset.biz}`; return; }
  const f = e.target.closest('[data-filter]');
  if (f) { state.filter = f.dataset.filter; renderFilters(); renderRunList(); return; }
  const s = e.target.closest('[data-sample]');
  if (s) {
    s.disabled = true;
    try {
      const run = await api(`/api/b/${state.biz}/requests`, { method: 'POST', body: { sample_key: s.dataset.sample } });
      toast('Sample inquiry submitted — workflow started.');
      location.hash = `#/${state.biz}/runs/${run.id}`;
    } catch (err) { toast(err.message); } finally { s.disabled = false; }
    return;
  }
  const r = e.target.closest('[data-review]');
  if (r) {
    const action = r.dataset.review;
    const notes = $('#reviewNotes')?.value || '';
    if (action === 'request_changes' && !notes.trim()) { toast('Add a note describing the changes you want.'); $('#reviewNotes').focus(); return; }
    r.disabled = true;
    try {
      await api(`/api/b/${state.biz}/runs/${state.runId}/review`, { method: 'POST', body: { action, notes } });
      toast({ approve: 'Approved. Saving result and creating Maya handoff…', request_changes: 'Changes requested — a new attempt is drafting.', hold: 'Held. The decision stays pending.' }[action]);
      await refresh();
      await loadDetail(true);
    } catch (err) { toast(err.message); r.disabled = false; }
    return;
  }
  if (e.target.id === 'copyHandoff') {
    const text = $('#handoffSrc').textContent;
    try { await navigator.clipboard.writeText(text); toast('Handoff Markdown copied.'); } catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Handoff Markdown copied.');
    }
    return;
  }
  if (e.target.id === 'genCheckpoint') {
    try { await api('/api/checkpoint', { method: 'POST' }); toast('Checkpoint saved locally (no notification sent).'); renderCheckpoint(); } catch (err) { toast(err.message); }
  }
});

$('#intake').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const msg = $('#intakeMsg');
  try {
    const run = await api(`/api/b/${state.biz}/requests`, { method: 'POST', body: { title: fd.get('title'), body: fd.get('body'), is_sample: fd.get('is_sample') === 'on', contact: { name: fd.get('name') || undefined, email: fd.get('email') || undefined } } });
    e.target.reset();
    msg.textContent = '';
    toast('Request submitted — workflow started.');
    location.hash = `#/${state.biz}/runs/${run.id}`;
  } catch (err) { msg.textContent = err.message; }
});

window.addEventListener('hashchange', route);

(async function init() {
  state.status = await api('/api/status');
  state.businesses = await api('/api/businesses');
  state.biz = state.businesses[0]?.id;
  renderModes();
  route();
  setInterval(() => refresh().catch(() => {}), 1500);
})();
