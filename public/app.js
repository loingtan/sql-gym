// Query Gym frontend: hash-routed views over the JSON API. No build step, no framework.
const app = document.getElementById('app');
const statsEl = document.getElementById('stats');
const runBtn = document.getElementById('run');
const drawer = document.getElementById('drawer');
const menuBtn = document.getElementById('menu-btn');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = sel => document.querySelector(sel);

async function api(path, body, method) {
  const r = await fetch(path, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body && JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

// Per-browser drafts. Storage can be unavailable (private mode), so every access is guarded.
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* drafts are a convenience */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* same */ } },
};

let content;
let progress = new Map();
const unitById = id => content.units.find(u => u.id === id);
const passed = id => progress.has(id);
const unitDone = u => u.exercises.length > 0 && u.exercises.every(e => passed(e.id));
const refreshProgress = async () => { progress = new Map((await api('/api/progress')).map(p => [p.item_id, p])); };

const fmtMs = ms => ms == null ? '—' : ms < 1 ? `${ms.toFixed(3)} ms` : ms < 100 ? `${ms.toFixed(1)} ms` : ms < 10000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
const fmtX = x => x == null ? '—' : x < 10 ? `×${x.toFixed(1)}` : `×${Math.round(x).toLocaleString()}`;
const fmtN = n => Number(n ?? 0).toLocaleString();

// ---------------------------------------------------------------- top bar & navigation

function setBar({ title = 'Learn', stats = [], run = null }) {
  $('#bar-title').textContent = title;
  statsEl.innerHTML = stats.map(([label, value, cls = '']) =>
    `<div class="stat"><small>${esc(label)}</small><b class="${cls}">${esc(value)}</b></div>`).join('');
  runBtn.hidden = !run;
  runBtn.onclick = run;
}

async function busy(fn) {
  if (runBtn.getAttribute('aria-busy') === 'true') return;
  runBtn.setAttribute('aria-busy', 'true');
  try { await fn(); } finally { runBtn.removeAttribute('aria-busy'); }
}

const closeDrawer = () => { drawer.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); };
menuBtn.onclick = () => { drawer.hidden = !drawer.hidden; menuBtn.setAttribute('aria-expanded', String(!drawer.hidden)); };
document.addEventListener('click', e => { if (!drawer.hidden && !drawer.contains(e.target) && !menuBtn.contains(e.target)) closeDrawer(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeDrawer();
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !runBtn.hidden) { e.preventDefault(); runBtn.click(); }
});

const routes = [
  [/^#\/track\/(perf|ap)$/, trackPage],
  [/^#\/u\/([\w-]+)(?:\/(ex\/\d+|quiz))?$/, unitPage],
  [/^#\/console$/, consolePage],
  [/^#\/progress(?:\/(concepts))?$/, progressPage],
  [/.*/, homePage],
];

function render() {
  closeDrawer();
  app.onclick = null;
  const hash = location.hash || '#/';
  for (const a of drawer.querySelectorAll('a')) {
    const here = a.hash === '#/' ? hash === '#/' : hash.startsWith(a.hash);
    if (here) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  for (const [re, view] of routes) {
    const m = hash.match(re);
    if (m) { window.scrollTo(0, 0); return view(...m.slice(1)); }
  }
}
window.addEventListener('hashchange', render);

// ---------------------------------------------------------------- shared pieces

function table({ columns, rows, rowCount }) {
  if (!columns?.length) return '<p class="note-line">No result set.</p>';
  const cell = v => v === null ? '<td class="null">null</td>' : `<td>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td>`;
  return `<div class="table-wrap"><table class="grid">
    <thead><tr>${columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map(cell).join('')}</tr>`).join('')}</tbody></table></div>
    ${rowCount > rows.length ? `<p class="note-line">Showing ${rows.length} of ${fmtN(rowCount)} rows.</p>` : ''}`;
}

const DETAILS = ['Index Cond', 'Recheck Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'Filter', 'Rows Removed by Filter',
  'Rows Removed by Index Recheck', 'Rows Removed by Join Filter', 'Sort Key', 'Presorted Key', 'Sort Method', 'Group Key',
  'Heap Fetches', 'Workers Launched', 'Subplan Name', 'CTE Name'];

// Name a plan node the way psql prints it ("Hash Left Join", "Index Scan Backward using …").
function opName(n) {
  let s = n['Node Type'];
  if (s === 'Aggregate' && n.Strategy) s = { Hashed: 'HashAggregate', Sorted: 'GroupAggregate', Mixed: 'MixedAggregate' }[n.Strategy] ?? s;
  if (n['Partial Mode'] && n['Partial Mode'] !== 'Simple') s = `${n['Partial Mode']} ${s}`;
  if (n['Parallel Aware']) s = `Parallel ${s}`;
  const jt = n['Join Type'];
  if (jt && jt !== 'Inner') s = s === 'Nested Loop' ? `${s} ${jt} Join` : s.replace(' Join', ` ${jt} Join`);
  if (n['Scan Direction'] === 'Backward') s = s.replace('Scan', 'Scan Backward');
  return s;
}

function planView(p) {
  const nodes = [];
  (function walk(n, d) {
    const kids = n.Plans ?? [];
    const total = n['Actual Total Time'] * n['Actual Loops'];
    const self = Math.max(0, total - kids.reduce((s, k) => s + k['Actual Total Time'] * k['Actual Loops'], 0));
    nodes.push({ n, d, self });
    kids.forEach(k => walk(k, d + 1));
  })(p.Plan, 0);
  const sum = nodes.reduce((s, x) => s + x.self, 0) || 1;
  const hot = nodes.reduce((a, b) => (b.self > a.self ? b : a));
  const buf = n => {
    const parts = [['hit', n['Shared Hit Blocks']], ['read', n['Shared Read Blocks']], ['written', n['Shared Written Blocks']]].filter(([, v]) => v);
    return parts.length ? `Buffers: shared ${parts.map(([k, v]) => `${k}=${v}`).join(' ')}` : '';
  };
  const rows = nodes.map(({ n, d, self }) => {
    const name = opName(n);
    const cls = /Seq Scan/.test(name) ? 'scan-seq' : /Index (Only )?Scan|Bitmap Index Scan/.test(name) ? 'scan-idx' : '';
    const target = `${n['Index Name'] ? ` using ${n['Index Name']}` : ''}${n['Relation Name'] ? ` on ${n['Relation Name']}${n.Alias && n.Alias !== n['Relation Name'] ? ` ${n.Alias}` : ''}` : ''}`;
    const est = n['Plan Rows'], act = n['Actual Rows'];
    const off = Math.max(est, act) / Math.max(1, Math.min(est, act));
    const flag = n['Actual Loops'] && off >= 10 && Math.max(est, act) >= 100 ? `<span class="flag">rows estimate off ×${Math.round(off)}</span>` : '';
    const actual = n['Actual Loops'] === 0 ? '(never executed)'
      : `(actual time=${n['Actual Startup Time'].toFixed(3)}..${n['Actual Total Time'].toFixed(3)} rows=${act} loops=${n['Actual Loops']})`;
    const details = DETAILS.filter(k => n[k] != null).map(k => `${k}: ${Array.isArray(n[k]) ? n[k].join(', ') : n[k]}`);
    if (buf(n)) details.push(buf(n));
    return `<div class="node ${n === hot.n && nodes.length > 1 ? 'hot' : ''}" style="--d:${d}">
      <div class="heat" title="${(self / sum * 100).toFixed(0)}% of the time"><i style="width:${(self / sum * 100).toFixed(1)}%"></i></div>
      <div class="body"><div class="line">${d ? '-> ' : ''}<span class="op ${cls}">${esc(name)}</span>${esc(target)} <span class="est">(cost=${n['Startup Cost'].toFixed(2)}..${n['Total Cost'].toFixed(2)} rows=${est} width=${n['Plan Width']})</span> ${actual}${flag}</div>
      ${details.length ? `<div class="detail">${esc(details.join('\n'))}</div>` : ''}</div></div>`;
  }).join('');
  const total = (p.Plan['Shared Hit Blocks'] ?? 0) + (p.Plan['Shared Read Blocks'] ?? 0);
  return `<div class="plan-meta"><span>Planning <b>${fmtMs(p['Planning Time'])}</b></span><span>Execution <b>${fmtMs(p['Execution Time'])}</b></span><span>Buffers <b>${fmtN(total)}</b> × 8 kB</span></div>
    <div class="plan">${rows}</div>
    <div class="legend"><span><i style="background:var(--mark)"></i>bar = share of time spent in that step itself</span><span><i style="background:var(--warn)"></i>full table scan</span><span><i style="background:var(--ok)"></i>index access</span></div>`;
}

// Panes switched by buttons; wirePanes() handles clicks through event delegation.
const paneTabs = (panes, active) => `<nav class="tabs subtabs" role="tablist">${panes.map(([k, label]) =>
  `<button role="tab" data-pane="${k}" aria-selected="${k === active}">${esc(label)}</button>`).join('')}</nav>
  ${panes.map(([k, , html]) => `<div data-panel="${k}" ${k === active ? '' : 'hidden'}>${html}</div>`).join('')}`;

function wirePanes(root) {
  root.onclick = e => {
    const b = e.target.closest('[data-pane]');
    if (!b) return;
    root.querySelectorAll('[data-pane]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    root.querySelectorAll('[data-panel]').forEach(x => { x.hidden = x.dataset.panel !== b.dataset.pane; });
  };
}

const autosize = el => { el.rows = Math.min(24, Math.max(3, el.value.split('\n').length + 1)); };

// ---------------------------------------------------------------- home

function homePage() {
  const tally = track => {
    const ex = content.units.filter(u => u.track === track).flatMap(u => u.exercises);
    return [ex.filter(e => passed(e.id)).length, ex.length, content.units.filter(u => u.track === track).length];
  };
  const [pd, pt, pn] = tally('perf'), [ad, at, an] = tally('ap');
  setBar({ stats: [['SOLVED', `${pd + ad}/${pt + at}`], ['CONCEPTS', `${content.units.filter(unitDone).length}/${content.units.length}`]] });
  const next = content.units.flatMap(u => u.exercises).find(e => !passed(e.id));
  const card = (track, title, text, done, total) => `
    <a class="island track-card" href="#/track/${track}">
      <h2>${title}</h2><p>${text}</p>
      <div class="meter"><i style="width:${total ? (done / total) * 100 : 0}%"></i></div>
      <div class="meter-label"><span>${done} of ${total} exercises solved</span></div>
    </a>`;
  app.innerHTML = `
    <section class="page">
      <div class="hero">
        <div>
          <h1 class="title-hand">Query Gym</h1>
          <p>Practice SQL on a real Postgres with millions of rows. Read the plan, make slow queries fast, and unlearn the antipatterns from Bill Karwin's book.</p>
        </div>
        <div class="island chalk" aria-hidden="true">
          <div class="slow">Seq Scan on orders (actual time=0.02..84.21 rows=21480)</div>
          <div class="arrow">CREATE INDEX ON orders (created_at);</div>
          <div class="fast">Index Scan using orders_created_at_idx (actual time=0.03..0.20)</div>
          <span class="note">×420</span>
        </div>
      </div>
      <div class="tracks">
        ${card('perf', 'Performance Lab', `${pn} rounds on 1M orders and 2.5M order items with no secondary indexes. Find the slow step in the plan, fix it, beat the baseline.`, pd, pt)}
        ${card('ap', 'Antipatterns', `${an} chapters of SQL Antipatterns. Read the theory, then fix the query or the schema on the book's bug-tracker database.`, ad, at)}
      </div>
      <div class="home-actions">
        ${next ? `<a class="run small" href="#/u/${next.unitId}/ex/${next.n}">Continue: ${esc(next.title)}</a>` : ''}
        <a class="btn" href="#/console">Open the SQL console</a>
        <a class="btn" href="#/progress">See progress</a>
      </div>
    </section>`;
}

// ---------------------------------------------------------------- track list

const TRACK_INTRO = {
  perf: 'Big tables, no secondary indexes and a stopwatch. Each round explains one idea, then hands you a slow query: return the same rows, many times faster.',
  ap: 'Each chapter follows the book: the goal, the antipattern, how to spot it, when it is fine, and the fix. Then you practice on the bug-tracker database.',
};

function trackPage(track) {
  const t = content.tracks[track];
  const units = content.units.filter(u => u.track === track);
  const ex = units.flatMap(u => u.exercises);
  setBar({ title: t.title, stats: [['SOLVED', `${ex.filter(e => passed(e.id)).length}/${ex.length}`], ['CONCEPTS', `${units.filter(unitDone).length}/${units.length}`]] });
  // Part headings only when parts are contiguous runs (the book); otherwise one flat list in round order.
  const parts = units.map(u => u.part);
  const contiguous = new Set(parts).size === parts.filter((p, i) => i === 0 || p !== parts[i - 1]).length;
  const groups = new Map();
  units.forEach(u => { const k = contiguous ? u.part : ''; groups.set(k, [...(groups.get(k) ?? []), u]); });
  const row = u => `<li><a class="island unit-row" href="#/u/${u.id}">
      <span class="num">${u.number}</span>
      <div><h3>${esc(u.title)}</h3>${u.concept ? `<p>${esc(u.concept.title)}</p>` : ''}</div>
      <span class="dots" title="${u.exercises.filter(e => passed(e.id)).length} of ${u.exercises.length} exercises solved">
        ${u.exercises.map(e => `<i class="dot ${passed(e.id) ? 'on' : ''}"></i>`).join('')}
        ${u.quiz.length ? `<i class="dot quiz ${passed(`quiz:${u.id}`) ? 'on' : ''}" title="quiz"></i>` : ''}
      </span></a></li>`;
  app.innerHTML = `<section class="page"><div class="reading">
    <a class="back" href="#/">Home</a>
    <h1>${esc(t.title)}</h1>
    <p class="muted">${TRACK_INTRO[track]}</p>
    ${units.length ? '' : '<p class="muted">No lessons yet. Add markdown files to <code>content/</code>.</p>'}
    ${[...groups].map(([part, us]) => `${part ? `<h2 class="part-title">${esc(part)}</h2>` : ''}<ul class="units">${us.map(row).join('')}</ul>`).join('')}
  </div></section>`;
}

// ---------------------------------------------------------------- unit: theory / exercise / quiz

function unitPage(id, sub) {
  const u = unitById(id);
  if (!u) return notFound();
  const exN = sub?.startsWith('ex/') ? Number(sub.slice(3)) : null;
  const ex = exN ? u.exercises[exN - 1] : null;
  if (exN && !ex) return notFound();
  const tab = ex ? `ex/${exN}` : sub === 'quiz' ? 'quiz' : 'theory';
  const label = u.track === 'perf' ? 'ROUND' : 'CHAPTER';
  const tabs = [
    ['theory', 'Theory', false],
    ...u.exercises.map((e, i) => [`ex/${i + 1}`, u.exercises.length > 1 ? `Exercise ${i + 1}` : 'Exercise', passed(e.id)]),
    ...(u.quiz.length ? [['quiz', 'Quiz', passed(`quiz:${u.id}`)]] : []),
  ];
  const head = `<a class="back" href="#/track/${u.track}">${esc(content.tracks[u.track].title)}${u.part ? ` / ${esc(u.part)}` : ''}</a>
    <h1 class="unit-title">${u.number}. ${esc(u.title)}</h1>
    <nav class="tabs" role="tablist">${tabs.map(([k, text, done]) =>
      `<a role="tab" href="#/u/${u.id}${k === 'theory' ? '' : `/${k}`}" aria-selected="${k === tab}" class="${done ? 'done' : ''}">${text}</a>`).join('')}</nav>`;

  if (ex) return exerciseView(u, ex, head, label);
  setBar({ title: content.tracks[u.track].title, stats: [[label, u.number], ['SOLVED', `${u.exercises.filter(e => passed(e.id)).length}/${u.exercises.length}`]] });
  if (tab === 'quiz') return quizView(u, head);
  app.innerHTML = `<section class="page"><div class="reading">${head}
    <article class="prose">${u.theoryHtml}</article>
    ${u.exercises.length ? `<div class="next-step"><a class="run small" href="#/u/${u.id}/ex/1">Start the exercise</a></div>` : ''}
  </div></section>`;
}

function exerciseView(u, ex, head, label) {
  const key = `qg:draft:${ex.id}`;
  const draft = store.get(key) ?? { setup: ex.starter.setup, query: ex.starter.query };
  const inject = ex.kind === 'inject';
  const best = progress.get(ex.id);
  const stats = r => ex.baseline
    ? [[label, `${u.number}.${ex.n}`], ['BASELINE', fmtMs(r?.baseline?.ms)], ['YOURS', fmtMs(r?.ms)],
       r ? ['SPEEDUP', fmtX(r.speedup), r.passed ? 'big' : ''] : ['BEST', best?.best_speedup ? fmtX(best.best_speedup) : '—', best ? 'ok' : '']]
    : [[label, `${u.number}.${ex.n}`], ['TIME', fmtMs(r?.ms)], ['ROWS', r && !r.error ? fmtN(r.rowCount) : '—'], ['STATUS', passed(ex.id) ? 'solved' : 'open', passed(ex.id) ? 'ok' : '']];
  const goals = [
    inject ? 'Make the unsafe query return the target rows' : 'Return the same rows as the expected result',
    ex.speedup && `Be at least ${ex.speedup}× faster than the baseline`,
    ...ex.forbid.map(f => `No ${f} in the plan`),
    ...ex.require.map(r => r.msg),
    ex.ordered && 'Row order matters',
  ].filter(Boolean);

  const editors = inject ? `
      <div class="island ed"><div class="ed-head"><span>What the user types into the form</span></div>
        <input class="code" id="query" spellcheck="false" autocomplete="off" value="${esc(draft.query)}" aria-label="Form input"></div>
      <div class="island ed"><div class="ed-head"><span>The query the app builds from it</span><small>plain string concatenation</small></div>
        <pre class="sql-preview" id="preview"></pre></div>`
    : `
      <details class="island ed" open>
        <summary><span>Setup</span><small>Optional. Runs before the query: CREATE INDEX, CREATE TABLE, INSERT…</small></summary>
        <textarea class="code" id="setup" spellcheck="false" aria-label="Setup SQL">${esc(draft.setup)}</textarea>
      </details>
      <div class="island ed"><div class="ed-head"><span>Query</span><small>One SELECT. It is checked and timed.</small></div>
        <textarea class="code" id="query" spellcheck="false" aria-label="Query SQL">${esc(draft.query)}</textarea></div>`;

  app.innerHTML = `<section class="page wide">${head}
    <div class="workbench">
      <aside class="island brief">
        <h2>${esc(ex.title)}</h2>
        <div class="prose">${ex.taskHtml}</div>
        <ul class="goal">${goals.map(g => `<li>${esc(g)}</li>`).join('')}</ul>
        <div id="hints"></div>
        <div class="brief-actions">
          ${ex.hints.length ? `<button class="btn" id="hint-btn">Show a hint</button>` : ''}
          <button class="btn ghost" id="sol-btn">Show solution</button>
          <button class="btn ghost" id="reset-btn">Reset editor</button>
        </div>
      </aside>
      <div class="bench">
        ${editors}
        <p class="kbd-hint">Run with the yellow button or ⌘/Ctrl + Enter. Each run happens in a transaction that is rolled back, so nothing you create sticks around.</p>
        <section class="island out" id="out" aria-live="polite"><p class="out-empty">Run your query to see the rows, the plan and the timing${ex.baseline ? ' against the baseline' : ''}.</p></section>
      </div>
    </div></section>`;

  const setupEl = $('#setup'), queryEl = $('#query'), out = $('#out');
  const save = () => store.set(key, { setup: setupEl?.value ?? '', query: queryEl.value });
  const preview = () => {
    if (!inject) return;
    $('#preview').innerHTML = ex.template.split('{{input}}').map(esc).join(`<mark>${esc(queryEl.value)}</mark>`);
  };
  for (const el of [setupEl, queryEl].filter(Boolean)) {
    if (el.tagName === 'TEXTAREA') autosize(el);
    el.addEventListener('input', () => { if (el.tagName === 'TEXTAREA') autosize(el); save(); preview(); });
  }
  preview();

  let shown = 0;
  $('#hint-btn')?.addEventListener('click', e => {
    $('#hints').insertAdjacentHTML('beforeend', `<div class="hint">${ex.hints[shown++]}</div>`);
    if (shown >= ex.hints.length) e.currentTarget.remove();
    else e.currentTarget.textContent = 'Show another hint';
  });
  $('#sol-btn').addEventListener('click', () => {
    if (!confirm('Load the solution into the editor? Your current draft will be replaced.')) return;
    if (setupEl) { setupEl.value = ex.solution.setup; autosize(setupEl); }
    queryEl.value = ex.solution.query;
    if (queryEl.tagName === 'TEXTAREA') autosize(queryEl);
    save(); preview();
  });
  $('#reset-btn').addEventListener('click', () => {
    if (!confirm('Reset the editor to the starting code?')) return;
    store.del(key);
    render();
  });

  const run = () => busy(async () => {
    out.innerHTML = '<p class="out-empty hand">Running on Postgres…</p>';
    let r;
    try {
      r = await api('/api/run', { id: ex.id, setup: setupEl?.value ?? '', query: queryEl.value });
    } catch (e) {
      out.innerHTML = `<div class="error">${esc(e.message)}</div>`;
      return;
    }
    if (r.passed) {
      await refreshProgress();
      document.querySelector('.tabs [aria-selected="true"]')?.classList.add('done');
    }
    out.innerHTML = resultView(u, ex, r);
    wirePanes(out);
    setBar({ title: content.tracks[u.track].title, stats: stats(r), run });
  });
  setBar({ title: content.tracks[u.track].title, stats: stats(null), run });
}

function resultView(u, ex, r) {
  if (r.error) return `<div class="error">${esc(r.error)}</div>`;
  const verdict = `<div class="verdict">
    <span class="stamp ${r.passed ? 'pass' : ''}">${r.passed ? 'Passed' : 'Not yet'}</span>
    <ul class="checks">${r.checks.map(c => `<li class="${c.ok ? 'ok' : ''}">${esc(c.label)}${c.detail ? `<small>${esc(c.detail)}</small>` : ''}</li>`).join('')}</ul>
  </div>`;
  const unlocked = r.passed && unitDone(u) && u.concept
    ? `<p class="note-line">Concept card unlocked: <a href="#/progress/concepts">${esc(u.concept.title)}</a></p>` : '';
  const exp = r.expected;

  if (ex.kind === 'inject') {
    const safe = r.safe.error ? `<div class="error">${esc(r.safe.error)}</div>` : table(r.safe);
    return verdict + unlocked + paneTabs([
      ['unsafe', `Unsafe query (${fmtN(r.rowCount)} rows)`, r.error ? '' : `<pre class="sql-preview">${esc(r.sql)}</pre>${table(r)}`],
      ['safe', `With a bind parameter (${fmtN(r.safe.rowCount)})`, `<pre class="sql-preview">${esc(r.safeSql)}</pre><p class="note-line">The same input sent as a parameter is just a string value.</p>${safe}`],
      ['expected', `Target rows (${fmtN(exp.rowCount)})`, table(exp)],
    ], 'unsafe');
  }

  const race = r.baseline ? (() => {
    const max = Math.max(r.baseline.ms, r.ms) || 1;
    const lane = (cls, name, ms, b) => `<div class="lane ${cls}"><span>${name}</span><div class="track"><i style="width:${(ms / max) * 100}%"></i></div><b>${fmtMs(ms)} <small>${fmtN(b)} buffers</small></b></div>`;
    return `<div class="race">${lane('', 'Baseline', r.baseline.ms, r.baseline.buffers)}${lane('you', 'Yours', r.ms, r.buffers)}</div>`;
  })() : '';
  const rowsOk = r.checks[0]?.ok;
  const panes = [
    ['plan', 'Your plan', planView(r.plan)],
    ['rows', `Your rows (${fmtN(r.rowCount)})`, table(r)],
    ['expected', `Expected (${fmtN(exp.rowCount)})`, table(exp)],
  ];
  if (r.baseline) panes.push(['base', 'Baseline plan', planView(r.baseline.plan)]);
  const setupNote = r.setupMs > 50 ? `<p class="note-line">Setup took ${fmtMs(r.setupMs)} (not counted in the timing).</p>` : '';
  return verdict + unlocked + race + setupNote + paneTabs(panes, rowsOk ? 'plan' : 'rows');
}

function quizView(u, head) {
  const right = new Map();
  app.innerHTML = `<section class="page"><div class="reading">${head}
    <div id="quiz-status"></div>
    ${u.quiz.map((q, i) => `
      <div class="question" data-q="${i}">
        <h3>${q.qHtml}</h3>
        ${q.bodyHtml ? `<div class="prose">${q.bodyHtml}</div>` : ''}
        <div class="options">${q.options.map((o, j) => `<button class="option" data-o="${j}">${o.html}</button>`).join('')}</div>
        <div class="why" hidden>${q.why}</div>
      </div>`).join('')}
  </div></section>`;
  app.onclick = async e => {
    const b = e.target.closest('.option');
    if (!b) return;
    const qEl = b.closest('.question'), i = Number(qEl.dataset.q), q = u.quiz[i];
    const ok = q.options[Number(b.dataset.o)].correct;
    qEl.querySelectorAll('.option').forEach(x => x.classList.remove('right', 'wrong'));
    b.classList.add(ok ? 'right' : 'wrong');
    qEl.querySelector('.why').hidden = false;
    right.set(i, ok);
    if (u.quiz.every((_, k) => right.get(k))) {
      await api('/api/progress', { id: `quiz:${u.id}` });
      await refreshProgress();
      document.querySelector('.tabs [aria-selected="true"]')?.classList.add('done');
      $('#quiz-status').innerHTML = `<div class="island quiz-done"><span class="hand">All correct.</span> ${u.exercises.every(x => passed(x.id)) ? 'This chapter is done.' : 'Now try the exercise if you haven\'t yet.'}</div>`;
    }
  };
}

// ---------------------------------------------------------------- console

async function consolePage() {
  const draft = store.get('qg:console') ?? { schema: 'perf', sql: 'SELECT status, count(*)\nFROM orders\nGROUP BY status\nORDER BY 2 DESC;' };
  app.innerHTML = `<div class="console">
    <aside class="island schema" id="schema"><p class="muted">Loading tables…</p></aside>
    <section>
      <div class="console-head">
        <h1>SQL console</h1>
        <label>Schema <select id="schema-sel">
          <option value="perf">perf: big tables</option>
          <option value="bugs">bugs: the book's database</option>
        </select></label>
        <button class="btn" id="explain-btn">Explain analyze</button>
      </div>
      <div class="island ed"><div class="ed-head"><span>SQL</span><small>Statements run in order inside one transaction that is rolled back.</small></div>
        <textarea class="code" id="sql" spellcheck="false" aria-label="SQL">${esc(draft.sql)}</textarea></div>
      <div id="console-out"></div>
    </section></div>`;
  const sel = $('#schema-sel'), sqlEl = $('#sql'), out = $('#console-out');
  sel.value = draft.schema;
  autosize(sqlEl);
  const save = () => store.set('qg:console', { schema: sel.value, sql: sqlEl.value });
  sqlEl.addEventListener('input', () => { autosize(sqlEl); save(); });

  let tables = [];
  const drawSchema = () => {
    $('#schema').innerHTML = `<h3>${sel.value}</h3>` + tables.filter(t => t.schema === sel.value).map(t => `
      <details><summary><span>${esc(t.name)}</span><small>${fmtN(t.rows)} rows</small></summary>
        <ul>${t.columns.map(c => `<li>${esc(c.name)} <span class="type">${esc(c.type)}</span></li>`).join('')}</ul>
        <ul>${(t.indexes ?? []).map(i => `<li class="idx">${esc(i.replace(/ USING btree/, '').replace(/^CREATE (UNIQUE )?INDEX /, '$1'))}</li>`).join('')}</ul>
      </details>`).join('');
  };
  sel.addEventListener('change', () => { save(); drawSchema(); setBar({ title: 'Console', stats: [['SCHEMA', sel.value]], run: () => go(false) }); });
  api('/api/schema').then(t => { tables = t; drawSchema(); }).catch(e => { $('#schema').innerHTML = `<div class="error">${esc(e.message)}</div>`; });

  const go = explain => busy(async () => {
    out.innerHTML = '<p class="out-empty hand">Running…</p>';
    try {
      const r = await api('/api/console', { schema: sel.value, sql: sqlEl.value, explain });
      out.innerHTML = (r.results ?? []).map((x, i) => `<div class="result-block"><h4>${i + 1}. ${esc(x.command)}${x.rowCount != null && x.command !== 'SELECT' ? ` (${fmtN(x.rowCount)} rows affected)` : ''}</h4>${x.columns.length ? table({ ...x, rowCount: x.rows.length + (x.truncated ? 1 : 0) }) : ''}</div>`).join('')
        + (r.plan ? `<div class="island out result-block">${planView(r.plan)}</div>` : '')
        + (r.error ? `<div class="error result-block">${esc(r.error)}</div>` : '');
    } catch (e) {
      out.innerHTML = `<div class="error">${esc(e.message)}</div>`;
    }
  });
  $('#explain-btn').addEventListener('click', () => go(true));
  setBar({ title: 'Console', stats: [['SCHEMA', sel.value]], run: () => go(false) });
}

// ---------------------------------------------------------------- progress

function progressPage(tab) {
  const concepts = tab === 'concepts';
  const all = content.units.flatMap(u => u.exercises.map(e => ({ u, e })));
  setBar({ title: 'Progress', stats: [['SOLVED', `${all.filter(x => passed(x.e.id)).length}/${all.length}`], ['CONCEPTS', `${content.units.filter(unitDone).length}/${content.units.length}`]] });
  const date = s => new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const rounds = Object.keys(content.tracks).map(track => `
    <h2 class="part-title">${esc(content.tracks[track].title)}</h2>
    <table class="rounds"><thead><tr><th></th><th>Exercise</th><th>Best time</th><th>Speedup</th><th>Solved</th></tr></thead><tbody>
    ${all.filter(x => x.u.track === track).map(({ u, e }) => {
      const p = progress.get(e.id);
      return `<tr><td class="${p ? 'ok' : 'muted'}">${p ? '✓' : '○'}</td>
        <td><a href="#/u/${u.id}/ex/${e.n}">${u.number}.${e.n} ${esc(e.title)}</a></td>
        <td class="num">${p?.best_ms != null ? fmtMs(p.best_ms) : ''}</td>
        <td class="num">${p?.best_speedup ? fmtX(p.best_speedup) : ''}</td>
        <td class="num">${p ? date(p.passed_at) : ''}</td></tr>`;
    }).join('')}</tbody></table>`).join('');
  const cards = content.units.filter(u => u.concept).map(u => unitDone(u)
    ? `<div class="island concept"><h3>${esc(u.concept.title)}</h3><p>${esc(u.concept.text)}</p><a href="#/u/${u.id}">${esc(u.title)}</a></div>`
    : `<div class="island concept locked"><h3>?</h3><p>Solve every exercise in “${esc(u.title)}” to unlock this card.</p></div>`).join('');
  app.innerHTML = `<section class="page"><div class="reading" style="max-width:${concepts ? 1040 : 760}px">
    <h1>Progress</h1>
    <nav class="tabs" role="tablist">
      <a role="tab" href="#/progress" aria-selected="${!concepts}">Rounds</a>
      <a role="tab" href="#/progress/concepts" aria-selected="${concepts}">Concepts</a>
    </nav>
    ${concepts ? `<p class="muted">More cards come as you pass rounds.</p><div class="concepts">${cards}</div>`
      : `${rounds}<p style="margin-top:32px"><button class="btn danger" id="reset-progress">Reset progress</button></p>`}
  </div></section>`;
  $('#reset-progress')?.addEventListener('click', async () => {
    if (!confirm('Erase all solved exercises and quizzes?')) return;
    await api('/api/progress', null, 'DELETE');
    await refreshProgress();
    render();
  });
}

function notFound() {
  setBar({});
  app.innerHTML = `<section class="page reading"><h1>Nothing here</h1><p><a href="#/">Back to the start</a></p></section>`;
}

// ---------------------------------------------------------------- boot

try {
  [content] = await Promise.all([api('/api/content'), refreshProgress()]);
  render();
} catch (e) {
  app.innerHTML = `<section class="page reading"><h1>Can't reach the database</h1>
    <p class="muted">${esc(e.message)}</p>
    <p>Start it with <code>docker compose up</code> (the first start seeds about 4 million rows), then reload this page.</p></section>`;
}
