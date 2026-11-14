---
title: Connection leaks
part: Pool failures
concept: Always give it back | A connection borrowed and never returned is gone until restart. Release in a finally block, on every path.
---

## The pool that slowly dies

A service runs fine for hours after each deploy, then requests start timing out waiting for a
connection. Restarting fixes it, for a few hours. The database is idle the whole time. This is the
signature of a **connection leak**: code borrows a connection and, on some path, never returns it.

The pool counts that connection as in use forever. Each leak shrinks the usable pool by one. When the
last one is gone, every request waits for the timeout and fails.

## Where leaks come from

Almost always an error path:

```js
async function handler(req) {
  const client = await pool.connect();          // borrow
  const res = await client.query(sql, params);  // throws on a bad input…
  client.release();                             // …and this line never runs
  return res.rows;
}
```

It works in every test, because tests rarely exercise the failing input. In production one request in a
thousand throws, and the pool drains a little each time.

Other sources: an early `return` before the release, a forgotten release in a rarely used branch, and
code that takes a connection for a transaction and loses track of it across callbacks.

## The fix: release on every path

```js
const client = await pool.connect();
try {
  return (await client.query(sql, params)).rows;
} finally {
  client.release();      // runs on success, on error and on early return
}
```

Better still, don't hold the connection yourself. `pool.query(sql)` borrows, runs and returns in one
call. Most languages have the same idea built in: `try-with-resources` in Java, `with` in Python,
`defer` in Go, a transaction helper that takes a callback.

## How to spot one

- "Connections in use" climbs in steps and never comes down, while traffic is flat.
- In `pg_stat_activity` the leaked sessions are `idle` (or `idle in transaction`) with an old
  `state_change`, and their last `query` points at the code path that leaked.
- Many pools can report it: HikariCP's `leakDetectionThreshold` logs a stack trace for any connection
  held longer than a limit.

Raising the pool size only makes the service survive longer between restarts.

## Exercise: One request in ten leaks

50 requests per second for two seconds, on a pool of 5. Every tenth request fails with a division by
zero (that is expected, and the ten errors will remain). The handler is written without `finally`,
which the experiment models as `release: on_success`. Run it and watch the yellow line in the chart
climb one step at a time. Then fix the handler.

```sql request
SELECT 10 / (:n % 10)
```

```sql starter-setup
release: on_success    # on_success = release only when the query worked, always = release in a finally
```

```sql solution-setup
release: always
```

```meta
kind: load
tunable: release
pool_max: 5
rate: 50
duration_s: 2
timeout_ms: 500
goal: leaked = 0 | No connection is leaked
goal: timeouts = 0 | No request times out waiting for a connection
```

> Hint: Count the steps in the chart. After the fifth failed request the pool has nothing left to lend.

> Hint: `release: always` is the `finally` block: the connection goes back whether the query worked or not.

## Quiz

### A service times out waiting for connections a few hours after every restart, while the database is idle. What is the most likely cause?

- [ ] The database is too small
- [x] A connection leak: some code path borrows a connection and never returns it
- [ ] Too many indexes
- [ ] The pool timeout is too long

> Slow decay that a restart cures, with no load on the database, is how a leak looks from outside.

### Why do leaks usually hide in error paths?

- [ ] Errors close the connection
- [x] The release call sits after the query, so an exception skips it, and tests rarely trigger that path
- [ ] Pools ignore errors
- [ ] They don't; leaks are random

> The happy path releases. The path nobody tested doesn't.

### What is the most reliable way to prevent leaks?

- [ ] A larger pool
- [ ] A shorter idle timeout
- [x] Release in a `finally` block, or use helpers such as `pool.query` that return the connection for you
- [ ] Restarting the service every night

> Make the release structurally impossible to skip.
