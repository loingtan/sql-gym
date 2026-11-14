// Load lab for "kind: load" exercises: real connections, a real pg.Pool, real waiting.
// An experiment sends requests at Postgres and reports waits, timeouts and refused connections.
import pg from 'pg';
import { performance } from 'node:perf_hooks';
import { substitute } from './racelab.js';

const URL_ = process.env.DATABASE_URL ?? 'postgres://postgres:practice@localhost:5433/practice';

const DEFAULTS = { mode: 'pool', pool_max: 10, timeout_ms: 1000, instances: 1, rate: 50, duration_s: 2, arrivals: 'steady', requests: 0, warm: 'false', release: 'always', watch_idle: 'false' };
const LIMITS = { pool_max: [1, 40], timeout_ms: [50, 5000], instances: [1, 8], rate: [1, 300], duration_s: [0.5, 4], requests: [0, 500] };
const CHOICES = { mode: ['pool', 'connect'], arrivals: ['steady', 'random'], warm: ['true', 'false'], release: ['always', 'on_success'], watch_idle: ['true', 'false'] };
export const LOAD_KEYS = Object.keys(DEFAULTS);

// Lesson defaults, overridden by the learner's "key: value" lines for the keys the lesson allows.
export function loadParams(lesson, tunable, text) {
  const mine = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^(\w+)\s*[:=]\s*(\S+)$/);
    if (!m) throw new Error(`Can't read the setting "${line}". Write it as "name: value".`);
    if (!tunable.includes(m[1])) throw new Error(`"${m[1]}" is fixed in this round. You can change: ${tunable.join(', ') || 'only the request'}.`);
    mine[m[1]] = m[2];
  }
  const p = {};
  for (const k of LOAD_KEYS) {
    const v = String(mine[k] ?? lesson[k] ?? DEFAULTS[k]);
    if (CHOICES[k]) {
      if (!CHOICES[k].includes(v)) throw new Error(`${k} must be one of: ${CHOICES[k].join(', ')}.`);
      p[k] = v;
    } else {
      const n = Number(v), [lo, hi] = LIMITS[k];
      if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${k} must be a number from ${lo} to ${hi}.`);
      p[k] = n;
    }
  }
  return p;
}

// One experiment at a time: they compete for the same connection slots and CPU.
let chain = Promise.resolve();
export function exclusive(fn) {
  const r = chain.then(fn, fn);
  chain = r.catch(() => {});
  return r;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (xs, q) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))] : 0);
const avg = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

// Seeded generator, so "random" arrivals are the same on every run.
function rng(seed) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function arrivalTimes(p, k) {
  const out = [], rand = rng(42 + k);
  for (let t = 0; t < p.duration_s * 1000;) {
    out.push(t);
    t += p.arrivals === 'random' ? (-Math.log(1 - rand()) / p.rate) * 1000 : 1000 / p.rate;
  }
  return out;
}

export const mainConn = schema => ({ connectionString: URL_, options: `-c search_path=${schema},public` });

// steps: { sql } or { wait: ms }. Waits before the first / after the last statement happen without a connection;
// waits in between hold it. ":n" in the SQL is the request number.
export async function runLoad(p, steps, connOpts) {
  const conn = { ...connOpts, application_name: 'qg-load', statement_timeout: 10000 };
  const first = steps.findIndex(s => s.sql), last = steps.findLastIndex(s => s.sql);
  const pause = async part => { for (const s of part) await sleep(s.wait); };
  const leaked = [], idle = [];
  const waits = [], latency = [], service = [], samples = [];
  let timeouts = 0, refused = 0, errors = 0, firstError = null, connections = 0, inUse = 0, waiting = 0, peak = 0, sent = 0;
  const fail = e => {
    if (/timeout exceeded when trying to connect/.test(e.message)) timeouts++;
    else if (/too many clients|remaining connection slots/.test(e.message)) refused++;
    else errors++;
    firstError ??= e.message;
  };
  // A request: get a connection (borrow from the pool, or open a new one), run the SQL, give it back.
  const request = (acquire, giveBack) => async () => {
    const n = ++sent;
    await pause(steps.slice(0, first));
    const start = performance.now();
    waiting++;
    let c;
    try { c = await acquire(); } catch (e) { waiting--; return fail(e); }
    const got = performance.now();
    waiting--; inUse++; peak = Math.max(peak, inUse);
    waits.push(got - start);
    try {
      for (const s of steps.slice(first, last + 1)) await (s.wait ? sleep(s.wait) : c.query(substitute(s.sql, { n })));
      service.push(performance.now() - got);
      latency.push(performance.now() - start);
    } catch (e) {
      fail(e);
      // release: on_success models a handler without try/finally: an error path never returns the connection.
      if (p.release === 'on_success' && p.mode === 'pool') return leaked.push(c);
      await c.query('ROLLBACK').catch(() => {});
    }
    inUse--;
    await giveBack(c);
    await pause(steps.slice(last + 1));
  };

  const pools = p.mode === 'pool' ? Array.from({ length: p.instances }, () => {
    const pool = new pg.Pool({ ...conn, max: p.pool_max, connectionTimeoutMillis: p.timeout_ms, idleTimeoutMillis: 30000 });
    pool.on('connect', () => connections++);
    pool.on('error', () => {});
    return pool;
  }) : [];
  const viaConnect = request(async () => {
    const c = new pg.Client(conn);
    c.on('error', () => {});
    await c.connect();
    connections++;
    return c;
  }, c => c.end().catch(() => {}));
  const senders = p.mode === 'pool' ? pools.map(pool => request(() => pool.connect(), c => c.release())) : Array(p.instances).fill(viaConnect);

  try {
    // warm: every instance opens its whole pool at startup (what a pool with min = max does).
    if (p.warm === 'true') for (const pool of pools) {
      const cs = await Promise.all(Array.from({ length: p.pool_max }, () => pool.connect().catch(e => (fail(e), null))));
      cs.forEach(c => c?.release());
    }
    const t0 = performance.now();
    // watch_idle: a monitor session counts our sessions that sit "idle in transaction".
    const monitor = p.watch_idle === 'true' ? new pg.Client(URL_) : null;
    await monitor?.connect();
    let asking = false;
    const sampler = setInterval(() => {
      samples.push([Math.round(performance.now() - t0), inUse, waiting]);
      if (!monitor || asking) return;
      asking = true;
      monitor.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'qg-load' AND state = 'idle in transaction'")
        .then(r => idle.push(r.rows[0].n), () => {}).finally(() => { asking = false; });
    }, 50);
    if (p.requests) for (let i = 0; i < p.requests; i++) await senders[0]();
    else await Promise.all(senders.flatMap((send, k) => arrivalTimes(p, k).map(t => sleep(t).then(send))));
    clearInterval(sampler);
    await monitor?.end().catch(() => {});
    const total_ms = performance.now() - t0;
    const service_ms = avg(service);
    return {
      metrics: {
        sent, completed: latency.length, timeouts, refused, errors, failed: timeouts + refused + errors,
        total_ms, throughput: latency.length / (total_ms / 1000),
        wait_p50: pct(waits, 0.5), wait_p95: pct(waits, 0.95), latency_p50: pct(latency, 0.5), latency_p95: pct(latency, 0.95),
        leaked: leaked.length, idle_in_tx_avg: avg(idle), idle_in_tx_peak: Math.max(0, ...idle),
        service_ms, peak_in_use: peak, connections, total_pool: p.mode === 'pool' ? p.pool_max * p.instances : 0,
        // Little's Law: connections needed on average = arrival rate x time each request holds one
        demand: p.requests ? 1 : p.rate * p.instances * (service_ms / 1000),
      },
      samples, firstError,
    };
  } finally {
    leaked.forEach(c => c.release(true));
    await Promise.all(pools.map(pool => pool.end().catch(() => {})));
  }
}
