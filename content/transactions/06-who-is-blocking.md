---
title: Who is blocking whom
part: Locking
concept: Find the blocker | Waiting sessions show wait_event_type = 'Lock'. pg_blocking_pids() names who they wait for, and the culprit is often idle in transaction.
---

## "The database is hanging"

A query that normally takes a millisecond has been running for a minute. Usually nothing is slow: the
query is **waiting for a lock** that another session holds. The skill is to find that other session.

## pg_stat_activity: one row per session

```sql
SELECT pid, state, wait_event_type, wait_event, now() - xact_start AS in_transaction_for, query
FROM pg_stat_activity
WHERE datname = current_database();
```

The columns that matter here:

- **state**
  - `active`: running a statement right now. A session stuck waiting for a lock is also `active`.
  - `idle`: connected, doing nothing, no transaction open. Harmless.
  - `idle in transaction`: ran `BEGIN` and some statements, and is now doing nothing while its
    transaction stays open. **It still holds all its locks.**
- **wait_event_type**: `Lock` means the session is waiting for a lock held by someone else.
- **xact_start**: when its transaction began. Old values deserve suspicion.

## pg_blocking_pids: who am I waiting for?

```sql
SELECT waiting.pid AS waiting_pid, waiting.query AS waiting_query,
       blocker.pid AS blocker_pid, blocker.state AS blocker_state, blocker.query AS blocker_last_query
FROM pg_stat_activity waiting
JOIN pg_stat_activity blocker ON blocker.pid = ANY (pg_blocking_pids(waiting.pid))
WHERE waiting.wait_event_type = 'Lock';
```

Waiters queue up, so a blocker may itself be waiting. Follow the chain to the session that is **not**
waiting for a lock: that is the root. Very often its state is `idle in transaction`: an application
opened a transaction, changed a row, and then went off to do something else (or crashed without
closing the connection).

## What to do about it

- **Right now:** `SELECT pg_cancel_backend(pid)` cancels the session's current statement.
  `SELECT pg_terminate_backend(pid)` closes its connection, which rolls back its transaction and
  releases its locks.
- **For good:** fix the code that leaves transactions open, and set safety nets:

```sql
SET idle_in_transaction_session_timeout = '30s';   -- kill sessions that sit in an open transaction
SET lock_timeout = '2s';                           -- give up waiting for a lock instead of queueing forever
SET statement_timeout = '30s';                     -- no statement may run longer than this
```

`lock_timeout` matters most for schema changes. `ALTER TABLE` needs an exclusive lock on the table. If
it has to wait behind one long transaction, every other query on that table queues up behind the
`ALTER TABLE`, and the application stops. With a `lock_timeout` the migration fails quickly and can
be tried again.

## Exercise: Count the waiters, name the culprit

While your script runs, three other sessions are at work on `accounts`. One holds a row lock in an open
transaction for 1.2 seconds. Two more try to update the same row and get stuck. At 500 ms, your script
must record in `findings`:

- `blocked`: how many sessions are waiting for a lock
- `blocker_state`: the `state` of the session that blocks them and is not itself waiting

All sessions of this exercise have `application_name = 'qg-race'`. The starter counts the wrong thing.

```sql init
CREATE TABLE accounts (id int PRIMARY KEY, balance int NOT NULL);
INSERT INTO accounts VALUES (1, 100);
CREATE TABLE findings (blocked int, blocker_state text);
```

```sql workers
SELECT 1 AS run
```

```sql actor-holder
BEGIN;
UPDATE accounts SET balance = balance - 1 WHERE id = 1;
\wait 1200
COMMIT;
```

```sql actor-waiter
\wait 150
UPDATE accounts SET balance = balance + 1 WHERE id = 1;
```

```sql starter
\wait 500
INSERT INTO findings
SELECT count(*), 'unknown'
FROM pg_stat_activity
WHERE application_name = 'qg-race' AND state = 'active';
```

```sql solution
\wait 500
INSERT INTO findings
SELECT
  (SELECT count(*) FROM pg_stat_activity
   WHERE application_name = 'qg-race' AND wait_event_type = 'Lock'),
  (SELECT b.state
   FROM pg_stat_activity w
   JOIN pg_stat_activity b ON b.pid = ANY (pg_blocking_pids(w.pid))
   WHERE w.wait_event_type = 'Lock' AND b.wait_event_type IS DISTINCT FROM 'Lock'
   LIMIT 1);
```

```sql check
SELECT blocked, blocker_state FROM findings
```

```sql expected
SELECT 2, 'idle in transaction'
```

```meta
kind: race
actor-waiter: 2
goal: errors = 0 | Your script runs without an error
require: \\wait\s+500 | Look at the sessions at 500 ms
```

> Hint: `state = 'active'` also counts your own session. Waiting sessions have `wait_event_type = 'Lock'`.

> Hint: Join the waiters to their blockers with `b.pid = ANY (pg_blocking_pids(w.pid))`.

> Hint: A waiter can also be listed as blocking the waiter behind it. The root blocker is the one whose own `wait_event_type` is not `'Lock'`.

## Quiz

### A session is in state `idle in transaction`. What is true?

- [ ] It holds no locks
- [x] Its transaction is open and it still holds every lock it took
- [ ] It is running a slow query
- [ ] It will be closed automatically after a minute

> Nothing is running, and nothing is released either. Only a timeout setting or a human ends it.

### How do you recognise a session that is stuck waiting for a lock?

- [ ] `state = 'idle'`
- [ ] `state = 'idle in transaction'`
- [x] `state = 'active'` with `wait_event_type = 'Lock'`
- [ ] It doesn't appear in pg_stat_activity

> It is in the middle of a statement, so it is active. The wait event says what it is waiting for.

### Why set `lock_timeout` before running `ALTER TABLE` on a busy table?

- [ ] It makes the ALTER faster
- [x] If the ALTER has to wait for a long transaction, all other queries on the table queue behind it; a timeout makes it give up quickly
- [ ] ALTER TABLE does not work without it
- [ ] It prevents deadlocks

> A waiting exclusive lock request blocks everyone who arrives after it. Failing fast keeps the application running.
