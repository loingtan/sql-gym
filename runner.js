// Runs learner SQL against Postgres. Every run happens inside a transaction that is ROLLED BACK,
// so CREATE INDEX / ALTER TABLE / INSERT in an attempt never leak into the next one.
import pg from 'pg';
import { exclusive, loadParams, runLoad } from './loadlab.js';

// Dates, times and intervals come back exactly as Postgres prints them (no JS Date / timezone shifts).
for (const oid of [1082, 1083, 1114, 1184, 1186, 1266]) pg.types.setTypeParser(oid, v => v);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:practice@localhost:5433/practice',
  max: 4,
});

const SCHEMAS = ['perf', 'bugs'];
const MAX_ROWS = 10000;   // larger results are rejected instead of loaded into memory
const RUNS = 3;           // timed EXPLAIN ANALYZE runs; the median counts

// --- SQL text helpers ---------------------------------------------------------------------------

// Index just past the comment starting at i ("--" to end of line, or a nestable /* */); i itself if none starts there.
function skipComment(sql, i) {
  if (sql.startsWith('--', i)) {
    const nl = sql.indexOf('\n', i);
    return nl < 0 ? sql.length : nl + 1;
  }
  if (!sql.startsWith('/*', i)) return i;
  let depth = 0;
  do {
    if (sql.startsWith('/*', i)) { depth++; i += 2; }
    else if (sql.startsWith('*/', i)) { depth--; i += 2; }
    else i++;
  } while (depth && i < sql.length);
  return i;
}

function stripLead(s) {
  for (let i = 0; ;) {
    const j = skipComment(s, i);
    if (j > i) i = j;
    else if (i < s.length && /\s/.test(s[i])) i++;
    else return s.slice(i);
  }
}

// Split on semicolons that are outside quotes, comments, $tag$ bodies and BEGIN ATOMIC … END function bodies.
export function splitSql(sql) {
  const out = [];
  // Index of the quote that closes a string or quoted identifier whose body starts at `from`.
  const closing = (from, quote, backslash) => {
    for (let j = from; j < sql.length; j++) {
      if (backslash && sql[j] === '\\') j++;
      else if (sql[j] === quote) { if (sql[j + 1] === quote) j++; else return j; }
    }
    return sql.length;
  };
  let start = 0, depth = 0, prev = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], past = skipComment(sql, i);
    if (past > i) i = past - 1;
    else if (c === "'" || c === '"') i = closing(i + 1, c, false);
    else if (c === '$') {
      const tag = sql.slice(i).match(/^\$([A-Za-z_]\w*)?\$/)?.[0];
      const end = tag ? sql.indexOf(tag, i + tag.length) : -1;
      if (tag) i = end < 0 ? sql.length : end + tag.length - 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const word = sql.slice(i).match(/^[\w$]+/)[0].toUpperCase();
      i += word.length - 1;
      if (word === 'E' && sql[i + 1] === "'") i = closing(i + 2, "'", true);   // E'…' strings use backslash escapes
      else if (word === 'ATOMIC' && prev === 'BEGIN') depth = 1;               // SQL-standard function body
      else if (depth && word === 'CASE') depth++;
      else if (depth && word === 'END') depth--;
      prev = word;
    } else if (c === ';' && !depth) {
      out.push(sql.slice(start, i));
      start = i + 1;
      prev = '';
    }
  }
  out.push(sql.slice(start));
  return out.filter(s => stripLead(s).trim());
}

const isSelect = s => /^(\(|select\b|with\b|values\b|table\b)/i.test(stripLead(s));
const TX_CONTROL = /^(begin|commit|end|abort|start\s+transaction|rollback(?!\s+to\b)|prepare\s+transaction)\b/i;

function checkStatements(stmts) {
  const bad = stmts.find(s => TX_CONTROL.test(stripLead(s)));
  if (bad) throw new Error(`"${stripLead(bad).split(/\s/)[0]}" isn't allowed here: the app wraps every run in its own transaction and rolls it back.`);
}

// --- execution -----------------------------------------------------------------------------------

export async function inRollback(schema, fn) {
  if (!SCHEMAS.includes(schema)) throw new Error(`Unknown schema ${schema}`);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout = '30s'");
    await c.query(`SET LOCAL search_path = ${schema}, public`);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

const show = v => (Buffer.isBuffer(v) ? '\\x' + v.toString('hex') : v);

// Fetch through a cursor so a huge result can't exhaust memory, and the query text runs unchanged.
async function fetchRows(c, query) {
  await c.query(`DECLARE _q NO SCROLL CURSOR FOR ${query}`);
  const r = await c.query({ text: `FETCH ${MAX_ROWS + 1} FROM _q`, rowMode: 'array' });
  await c.query('CLOSE _q');
  return { columns: r.fields.map(f => f.name), rows: r.rows.map(row => row.map(show)), truncated: r.rows.length > MAX_ROWS };
}

async function explain(c, query) {
  const { rows } = await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
  return rows[0]['QUERY PLAN'][0];
}

const buffers = p => (p['Shared Hit Blocks'] ?? 0) + (p['Shared Read Blocks'] ?? 0) + (p['Temp Read Blocks'] ?? 0);

// Median of RUNS timed runs (fewer when the query is slow anyway). `warm` adds an untimed first run.
async function measure(c, query, warm) {
  if (warm) await explain(c, query);
  const runs = [];
  const t0 = Date.now();
  while (runs.length < RUNS && (runs.length === 0 || Date.now() - t0 < 3000)) runs.push(await explain(c, query));
  runs.sort((a, b) => a['Execution Time'] - b['Execution Time']);
  const p = runs[Math.floor(runs.length / 2)];
  return { ms: p['Execution Time'], planningMs: p['Planning Time'], buffers: buffers(p.Plan), runs: runs.length, plan: p };
}

const planNodes = (n, out = []) => (out.push(n), (n.Plans ?? []).forEach(k => planNodes(k, out)), out);
const nodeLabel = n => [n['Node Type'], n['Index Name'] && `using ${n['Index Name']}`, n['Relation Name'] && `on ${n['Relation Name']}`]
  .filter(Boolean).join(' ');

// --- comparing results ---------------------------------------------------------------------------

const NUM = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;
const norm = v => (v === null ? null : typeof v === 'object' ? JSON.stringify(v)
  : NUM.test(String(v)) ? String(Number(Number(v).toPrecision(12))) : String(v));
const rowKey = r => JSON.stringify(r.map(norm));

export function compareRows(expected, actual, ordered) {
  if (actual.truncated) return `Your query returned more than ${MAX_ROWS} rows.`;
  if (actual.columns.length !== expected.columns.length)
    return `Expected ${expected.columns.length} column(s) (${expected.columns.join(', ')}), got ${actual.columns.length}.`;
  const e = expected.rows.map(rowKey), a = actual.rows.map(rowKey);
  if (ordered) {
    const i = e.findIndex((k, i) => k !== a[i]);
    if (i >= 0 || a.length !== e.length)
      return a.length !== e.length ? `Expected ${e.length} row(s), got ${a.length}.` : `Row ${i + 1} differs (row order matters here).`;
    return null;
  }
  const count = new Map();
  e.forEach(k => count.set(k, (count.get(k) ?? 0) + 1));
  let extra = 0;
  a.forEach(k => (count.get(k) ? count.set(k, count.get(k) - 1) : extra++));
  const missing = [...count.values()].reduce((s, n) => s + n, 0);
  if (!missing && !extra) return null;
  return `Expected ${e.length} row(s), got ${a.length}: ${missing} expected row(s) missing, ${extra} unexpected row(s).`;
}

// --- cached reference results and baselines (keyed by SQL text, so editing a lesson refreshes them) ---

const cache = new Map();
function once(key, fn) {
  if (!cache.has(key)) cache.set(key, fn().catch(e => { cache.delete(key); throw e; }));
  return cache.get(key);
}
const reference = ex => once(`ref\n${ex.schema}\n${ex.reference}`, () => inRollback(ex.schema, c => fetchRows(c, ex.reference)));
const baseline = ex => once(`base\n${ex.schema}\n${ex.baseline}`, () => inRollback(ex.schema, c => measure(c, ex.baseline, true)));

const errorOf = (e, where) => ({ error: `${where}: ${e.message}${e.hint ? `\nHint: ${e.hint}` : ''}` });

export async function runExercise(ex, { setup = '', query = '' }) {
  if (ex.kind === 'inject') return runInject(ex, query);
  if (ex.kind === 'load') return runLoadExercise(ex, setup, query);
  const setupStmts = splitSql(setup), queryStmts = splitSql(query);
  if (queryStmts.length !== 1 || !isSelect(queryStmts[0]))
    return { error: 'The Query box must contain exactly one SELECT (or WITH … SELECT). Put CREATE INDEX, CREATE TABLE etc. in Setup.' };
  try { checkStatements(setupStmts); } catch (e) { return { error: e.message }; }
  const q = queryStmts[0];

  const [expected, base] = await Promise.all([reference(ex), ex.baseline ? baseline(ex) : null]);
  return inRollback(ex.schema, async c => {
    const t0 = Date.now();
    for (const s of setupStmts) await c.query(s).catch(e => { throw errorOf(e, 'Setup'); });
    const setupMs = Date.now() - t0;
    const got = await fetchRows(c, q).catch(e => { throw errorOf(e, 'Query'); });
    const m = await measure(c, q, false);

    const diff = compareRows(expected, got, ex.ordered);
    const labels = planNodes(m.plan.Plan).map(nodeLabel);
    const speedup = base ? base.ms / Math.max(m.ms, 0.001) : null;
    const checks = [{ label: 'Same rows as the expected result', ok: !diff, detail: diff }];
    if (ex.speedup) checks.push({ label: `At least ${ex.speedup}× faster than the baseline`, ok: speedup >= ex.speedup, detail: `${speedup.toFixed(1)}×` });
    for (const f of ex.forbid) {
      const hit = labels.find(l => l.toLowerCase().includes(f.toLowerCase()));
      checks.push({ label: `No "${f}" in the plan`, ok: !hit, detail: hit && `found: ${hit}` });
    }
    for (const r of ex.require) checks.push({ label: r.msg, ok: new RegExp(r.re, 'i').test(`${setup}\n${query}`) });

    return {
      passed: checks.every(x => x.ok),
      checks,
      ...got,
      rows: got.rows.slice(0, 200),
      rowCount: got.rows.length,
      expected: { columns: expected.columns, rows: expected.rows.slice(0, 50), rowCount: expected.rows.length },
      setupMs,
      ms: m.ms, planningMs: m.planningMs, buffers: m.buffers, runs: m.runs, plan: m.plan,
      baseline: base && { ms: base.ms, buffers: base.buffers, plan: base.plan },
      speedup,
    };
  }).catch(e => (e.error ? e : { error: e.message }));
}

// SQL-injection lab: the learner types only the *input*; the app pastes it into the template unsafely,
// and also runs the same template safely with a bind parameter for comparison. Read-only transactions.
// queryMode 'extended' makes Postgres reject stacked statements, so an input such as
// "'; COMMIT; DROP TABLE accounts; --" cannot end the transaction and make later statements stick.
const STACKED = 'This lab sends one statement per request, so stacked statements such as "…; DROP TABLE …" cannot run here. Change what the single SELECT returns instead.';

async function runInject(ex, input) {
  const unsafe = ex.template.replaceAll('{{input}}', input);
  const safe = ex.template.replace(/'\{\{input\}\}'/g, '$1');
  const run = (text, values) => inRollback(ex.schema, async c => {
    await c.query('SET TRANSACTION READ ONLY');
    const r = await c.query({ text, values, rowMode: 'array', queryMode: 'extended' });
    return { columns: r.fields.map(f => f.name), rows: r.rows.map(row => row.map(show)) };
  }).catch(e => ({ error: /multiple commands/.test(e.message) ? `${e.message}\n${STACKED}` : e.message, columns: [], rows: [] }));
  const [expected, got, safeGot] = await Promise.all([reference(ex), run(unsafe), run(safe, [input])]);
  const diff = got.error ? got.error : compareRows(expected, got, ex.ordered);
  const checks = [{ label: 'The unsafe query returned the rows you were after', ok: !diff, detail: diff }];
  return {
    passed: !diff, checks, sql: unsafe, safeSql: safe,
    ...got, rows: got.rows.slice(0, 200), rowCount: got.rows.length,
    safe: { ...safeGot, rows: safeGot.rows.slice(0, 200), rowCount: safeGot.rows.length },
    expected: { columns: expected.columns, rows: expected.rows.slice(0, 50), rowCount: expected.rows.length },
  };
}

// Load test: the learner tunes pool settings (and sometimes the request's SQL); goals are checked on the measurements.
const OPS = { '<=': (a, b) => a <= b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '>': (a, b) => a > b, '=': (a, b) => a === b };

async function runLoadExercise(ex, settings, query) {
  let p, sql = ex.request;
  const checks = [];
  try { p = loadParams(ex.params, ex.tunable, settings); } catch (e) { return { error: e.message }; }
  if (ex.editQuery) {
    const stmts = splitSql(query);
    if (stmts.length !== 1 || !isSelect(stmts[0])) return { error: 'The request must be exactly one SELECT.' };
    sql = stmts[0];
    try {
      const [expected, got] = await Promise.all([reference(ex), inRollback(ex.schema, c => fetchRows(c, sql))]);
      const diff = compareRows(expected, got, ex.ordered);
      checks.push({ label: 'Same rows as the original request', ok: !diff, detail: diff });
    } catch (e) { return errorOf(e, 'Request'); }
  }
  const load = await exclusive(() => runLoad(p, sql, ex.schema));
  const values = { ...p, ...load.metrics };
  for (const g of ex.goals) {
    const [, name, op, n] = g.expr.match(/^(\w+)\s*(<=|>=|=|<|>)\s*([\d.]+)$/) ?? [];
    if (!name || !(name in values)) throw new Error(`Bad goal in lesson ${ex.id}: ${g.expr}`);
    const v = values[name];
    checks.push({ label: g.msg, ok: OPS[op](v, Number(n)), detail: `${name} = ${Number.isInteger(v) ? v : v.toFixed(1)}` });
  }
  return { passed: checks.every(c => c.ok), checks, load: { params: p, ...load } };
}

// Free-form console: statements run one by one; with `explain`, the last one is EXPLAIN ANALYZEd.
export async function runConsole(schema, sql, wantExplain) {
  const stmts = splitSql(sql);
  if (!stmts.length) return { error: 'Nothing to run.' };
  try { checkStatements(stmts); } catch (e) { return { error: e.message }; }
  return inRollback(schema, async c => {
    const results = [];
    for (const [i, s] of stmts.entries()) {
      const last = i === stmts.length - 1;
      try {
        if (last && wantExplain) return { results, plan: await explain(c, s) };
        if (isSelect(s)) results.push({ command: 'SELECT', ...(await fetchRows(c, s)) });
        else {
          const r = await c.query({ text: s, rowMode: 'array' });
          results.push({ command: r.command, rowCount: r.rowCount, columns: r.fields?.map(f => f.name) ?? [], rows: (r.rows ?? []).slice(0, 500).map(row => row.map(show)) });
        }
      } catch (e) {
        return { results, ...errorOf(e, `Statement ${i + 1}`) };
      }
    }
    return { results };
  });
}

// --- schema browser & progress -------------------------------------------------------------------

export async function schemaInfo() {
  const { rows } = await pool.query(`
    SELECT n.nspname AS schema, c.relname AS name, greatest(c.reltuples, 0)::bigint AS rows,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
           (SELECT json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod)) ORDER BY a.attnum)
              FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
           (SELECT json_agg(pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid = c.oid) AS indexes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY($1) AND c.relkind = 'r'
    ORDER BY 1, 2`, [SCHEMAS]);
  return rows;
}

export async function savePass(id, ms = null, speedup = null) {
  await pool.query(`
    INSERT INTO app.progress (item_id, best_ms, best_speedup) VALUES ($1, $2, $3)
    ON CONFLICT (item_id) DO UPDATE
      SET best_ms = least(app.progress.best_ms, excluded.best_ms),
          best_speedup = greatest(app.progress.best_speedup, excluded.best_speedup)`, [id, ms, speedup]);
}

export const getProgress = async () => (await pool.query('SELECT * FROM app.progress ORDER BY passed_at')).rows;
export const resetProgress = () => pool.query('TRUNCATE app.progress');
