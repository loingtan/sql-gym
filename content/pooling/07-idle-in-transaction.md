---
title: Idle in transaction
part: Pool failures
concept: Don't wait with a transaction open | Slow work between BEGIN and COMMIT holds a connection and its locks while doing nothing. Do it before or after.
---

## Holding a connection to do nothing

Round 3 said that connection demand is arrival rate × the time each request **holds** a connection. That
hold time is not only query time. Look at this checkout handler:

```js
const client = await pool.connect();
await client.query('BEGIN');
await client.query('INSERT INTO checkouts …');
const payment = await paymentApi.charge(card);      // 200 ms, somewhere on the internet
await client.query('UPDATE checkouts SET paid = true …');
await client.query('COMMIT');
client.release();
```

The two statements take a millisecond each. The connection is held for over 200 ms, and for nearly all
of that time the database session is **idle in transaction**: a transaction is open, and nothing is
running.

Three costs:

- **Pool demand multiplies.** At 40 requests per second, 2 ms of real work needs a fraction of one
  connection. Held for 200 ms, the same traffic needs 8.
- **Locks are held.** Rows the transaction touched stay locked until `COMMIT`. Anyone who needs them
  waits (Transactions & Locking, round 6).
- **Cleanup stalls.** An open transaction keeps old row versions alive, so `VACUUM` cannot remove them
  and tables bloat.

And if the payment API hangs for 30 seconds, every connection in the pool ends up parked in this state
and the whole service stops, though the database is healthy.

## The fix: shrink the transaction to the database work

Do the slow outside work **before** you take a connection, or **after** you have committed and given it
back:

```js
const payment = await paymentApi.charge(card);      // no connection held
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('INSERT INTO checkouts …');
  await client.query('UPDATE checkouts SET paid = true …');
  await client.query('COMMIT');
} finally { client.release(); }
```

When the order matters (reserve stock, charge, confirm), use two short transactions with a status
column: insert as `pending` and commit, call the API, then update to `paid` in a second transaction. A
crash in between leaves a `pending` row you can find and resolve, instead of an open transaction.

## The safety net

```sql
ALTER ROLE app_user SET idle_in_transaction_session_timeout = '10s';
```

Postgres then terminates any session that sits idle inside a transaction for longer than that. The
request fails, and the locks and the connection come back. Monitor it too:

```sql
SELECT pid, now() - state_change AS idle_for, query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY idle_for DESC;
```

## Exercise: Move the API call out of the transaction

40 checkouts per second for two seconds, on a pool of 4. Each request opens a transaction, inserts a
row, calls the payment API (`\wait 200`, the application waiting, not the database), marks the row paid
and commits. A monitor counts how many sessions are idle in transaction during the run. Rearrange the
script so the pool copes. Keep the 200 ms call and all four SQL statements.

Lines with `\wait` before the first SQL statement or after the last one run without a connection.

```sql init
CREATE TABLE checkouts (request int PRIMARY KEY, paid boolean NOT NULL DEFAULT false);
```

```sql request
BEGIN;
INSERT INTO checkouts (request) VALUES (:n);
\wait 200
UPDATE checkouts SET paid = true WHERE request = :n;
COMMIT;
```

```sql solution
\wait 200
BEGIN;
INSERT INTO checkouts (request) VALUES (:n);
UPDATE checkouts SET paid = true WHERE request = :n;
COMMIT;
```

```meta
kind: load
edit-query: true
script: true
pool_max: 4
rate: 40
duration_s: 2
timeout_ms: 500
watch_idle: true
goal: failed = 0 | No request fails
goal: idle_in_tx_avg <= 2 | On average fewer than 2 sessions sit idle in transaction
goal: wait_p95 <= 20 | 95% of requests wait under 20 ms for a connection
require: \\wait\s+200 | Keep the 200 ms payment call
require: begin[\s\S]*insert[\s\S]*update[\s\S]*commit | Keep the transaction with its INSERT and UPDATE
```

> Hint: Look at "Time holding it" and "Idle in transaction, average". The pool's four connections all sit waiting for the payment API.

> Hint: Move the `\wait 200` line above `BEGIN`. The request still takes 200 ms, and it holds a connection for about 2.

## Quiz

### What does the state `idle in transaction` mean?

- [ ] The session is connected and has no transaction open
- [ ] The session is running a slow query
- [x] A transaction is open and the session is not running anything
- [ ] The session is waiting for a lock

> The application sent BEGIN and some statements, then went quiet without COMMIT or ROLLBACK.

### A handler holds a connection for 200 ms, of which 2 ms is SQL. At 40 requests per second, how many connections does it need on average?

- [ ] 0.08
- [ ] 2
- [x] 8
- [ ] 40

> Little's Law uses hold time, not query time: 40 × 0.2 = 8.

### Which setting makes Postgres end sessions that sit in an open transaction for too long?

- [ ] `statement_timeout`
- [ ] `lock_timeout`
- [x] `idle_in_transaction_session_timeout`
- [ ] `max_connections`

> statement_timeout only limits running statements. An idle transaction is not running one.
