// Race lab for "kind: race" exercises: several real sessions run a script at the same time.
// Scripts commit for real, so they run as the restricted role qg_lab, which owns only the scratch schema "lab".
import pg from 'pg';
import { performance } from 'node:perf_hooks';

const ADMIN = process.env.DATABASE_URL ?? 'postgres://postgres:practice@localhost:5433/practice';
const labUrl = new URL(ADMIN);
labUrl.username = 'qg_lab';
labUrl.password = 'lab';
export const LAB = { connectionString: labUrl.href, options: '-c search_path=lab,public', statement_timeout: 8000 };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Recreate the scratch schema and run the lesson's init SQL in it.
export async function prepareLab(init) {
  const admin = new pg.Client(ADMIN);
  await admin.connect();
  try {
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'qg_lab') THEN CREATE ROLE qg_lab LOGIN PASSWORD 'lab'; END IF;
    END $$`);
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'qg_lab'");
    await admin.query('DROP SCHEMA IF EXISTS lab CASCADE; CREATE SCHEMA lab AUTHORIZATION qg_lab');
  } finally { await admin.end(); }
  if (!init) return;
  const c = new pg.Client(LAB);
  await c.connect();
  try { await c.query(init); } finally { await c.end(); }
}

// Replace :name with the variable's value as a SQL literal. "::type" casts are left alone.
const literal = v => (v === null || v === undefined ? 'NULL'
  : typeof v === 'number' || typeof v === 'boolean' || /^-?\d+(\.\d+)?$/.test(v) ? String(v)
  : `'${String(v).replaceAll("'", "''")}'`);
export const substitute = (sql, vars) => sql.replace(/(?<![:\w]):([A-Za-z_]\w*)/g, (m, k) => (k in vars ? literal(vars[k]) : m));

// cast: [{ name, steps, vars, repeat, actor }]. Steps are { sql } or { wait: ms } (the app doing something else).
// A SELECT's first row becomes variables for later statements, like an app reading a value and using it.
export async function runRace({ init, workers, script, actors = [], repeat = 1, check, expected }) {
  await prepareLab(init);
  const admin = new pg.Client(LAB);
  await admin.connect();
  const clients = [];
  try {
    const rows = workers ? (await admin.query(workers)).rows.slice(0, 12) : [{}];
    const cast = [
      ...rows.map((vars, i) => ({ name: `worker ${i + 1}`, steps: script, vars: { ...vars, worker: i + 1 }, repeat })),
      ...actors.flatMap(a => Array.from({ length: a.count }, (_, i) =>
        ({ name: a.count > 1 ? `${a.name} ${i + 1}` : a.name, steps: a.steps, vars: { worker: i + 1 }, repeat: 1, actor: true }))),
    ];
    for (const _ of cast) {
      const c = new pg.Client({ ...LAB, application_name: 'qg-race' });
      c.on('error', () => {});
      await c.connect();
      clients.push(c);
    }
    const events = [], errors = [];
    const t0 = performance.now();
    await Promise.all(cast.map(async (w, i) => {
      const c = clients[i];
      for (let r = 0; r < w.repeat; r++) {
        const vars = { ...w.vars };
        for (const step of w.steps) {
          if (step.wait) { await sleep(step.wait); continue; }
          const sql = substitute(step.sql, vars).trim(), t = performance.now() - t0;
          try {
            const res = await c.query(sql);
            events.push({ t, who: w.name, sql, ms: performance.now() - t0 - t });
            if (res.command === 'SELECT') for (const f of res.fields) {
              if (/^[a-z_]\w*$/i.test(f.name) && f.name !== 'pg_sleep') vars[f.name] = res.rows[0]?.[f.name] ?? null;
            }
          } catch (e) {
            events.push({ t, who: w.name, sql, ms: performance.now() - t0 - t, error: e.message });
            if (!w.actor) errors.push({ who: w.name, message: e.message, code: e.code });
            await c.query('ROLLBACK').catch(() => {});
            break;
          }
        }
      }
    }));
    const total_ms = performance.now() - t0;
    const fetch = async sql => {
      const r = await admin.query({ text: sql, rowMode: 'array' });
      return { columns: r.fields.map(f => f.name), rows: r.rows };
    };
    const count = code => errors.filter(e => e.code === code).length;
    return {
      check: await fetch(check), expected: await fetch(expected),
      events: events.sort((a, b) => a.t - b.t).slice(0, 300), errors,
      metrics: { workers: rows.length, total_ms, errors: errors.length, deadlocks: count('40P01'), serialization_failures: count('40001') },
    };
  } finally {
    await Promise.all([admin, ...clients].map(c => c.end().catch(() => {})));
  }
}
