---
title: A job queue with SKIP LOCKED
part: Locking
concept: SKIP LOCKED | Workers that claim rows with FOR UPDATE SKIP LOCKED each get a different row and never wait for each other.
---

## The table as a queue

Many systems keep work to do in a table: emails to send, payments to capture, files to process. Several
workers poll it, each taking the next pending job. The requirement is strict: **every job runs exactly
once**.

The naive worker reads the next job, does the work, and marks it done:

```sql
SELECT id FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1;
-- do the work
UPDATE jobs SET status = 'done' WHERE id = …;
```

Four workers start together, and all four read **job 1**. The email goes out four times. This is the
lost update from round 1 wearing different clothes.

## FOR UPDATE: correct, but only one worker works

Lock the job when reading it:

```sql
SELECT id FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1 FOR UPDATE;
```

Worker 1 gets job 1. Workers 2 to 4 try to lock the same row and **wait** until worker 1 commits. Then
Postgres re-checks the row they waited for, finds it is no longer `pending`, and moves on to job 2,
where one of them wins and the other two wait again. Every job runs exactly once, so the result is
correct. But the workers stand in a single line: while one works, the rest wait for its lock. You have
four workers and the throughput of one.

## SKIP LOCKED: every worker takes a different job

```sql
SELECT id FROM jobs
WHERE status = 'pending'
ORDER BY id
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

`SKIP LOCKED` tells Postgres to pass over rows someone else has locked and take the next free one.
Worker 1 gets job 1, worker 2 gets job 2, and nobody waits. If a worker crashes, its transaction rolls
back, the lock disappears and the job is pending again for someone else. No cleanup process is needed.

The whole claim can be one statement:

```sql
UPDATE jobs SET status = 'running'
WHERE id = (SELECT id FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING id;
```

`NOWAIT` is the sibling option: fail with an error at once when the row is locked, for cases where
waiting is pointless and skipping is wrong.

A queue in Postgres handles thousands of jobs per second and keeps the jobs in the same transaction as
your data. Above that, or with many consumers of different kinds, a dedicated queue is the better tool.

## Exercise: Twelve jobs, four workers, exactly once

Twelve pending jobs. Four workers each run your script three times: claim a job, work for 50 ms, mark it
done and count the run. Run the starter and look at the result: three jobs done four times each, nine
never touched. Make every job run exactly once, with the four workers really working in parallel:
the whole run should take under 400 ms.

```sql init
CREATE TABLE jobs (id int PRIMARY KEY, status text NOT NULL DEFAULT 'pending', done_by int, runs int NOT NULL DEFAULT 0);
INSERT INTO jobs (id) SELECT generate_series(1, 12);
```

```sql workers
SELECT generate_series(1, 4) AS slot
```

```sql starter
BEGIN;
SELECT id AS job FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1;
\wait 50
UPDATE jobs SET status = 'done', done_by = :worker, runs = runs + 1 WHERE id = :job;
COMMIT;
```

```sql solution
BEGIN;
SELECT id AS job FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED;
\wait 50
UPDATE jobs SET status = 'done', done_by = :worker, runs = runs + 1 WHERE id = :job;
COMMIT;
```

```sql check
SELECT count(*) FILTER (WHERE status = 'done') AS done, max(runs) AS most_runs FROM jobs
```

```sql expected
SELECT 12, 1
```

```meta
kind: race
repeat: 3
goal: errors = 0 | No worker fails
goal: total_ms <= 400 | Finish in under 400 ms
require: \\wait\s+50 | Keep the 50 ms of work
```

> Hint: All four workers read job 1 because a plain SELECT locks nothing.

> Hint: Try `FOR UPDATE` alone first. The result is right, but read the timeline: three workers wait on every SELECT, and the run takes about 650 ms.

> Hint: `FOR UPDATE SKIP LOCKED` makes each worker take the next job nobody holds.

## Quiz

### Four workers claim jobs with `SELECT … LIMIT 1 FOR UPDATE` (no SKIP LOCKED). What is the problem?

- [ ] Jobs run more than once
- [ ] Jobs are skipped and never run
- [x] The result is correct, but workers wait for each other's locks, so only one works at a time
- [ ] It causes deadlocks

> Each worker queues behind the lock on the first pending job. Correct, and no faster than a single worker.

### What does `SKIP LOCKED` do?

- [ ] Ignores all locks and reads the row anyway
- [ ] Fails immediately if any row is locked
- [x] Passes over rows that are locked by others and returns the next unlocked ones
- [ ] Waits a short time, then skips

> Each worker gets a row nobody else is holding, without waiting.

### A worker crashes after claiming a job with `FOR UPDATE SKIP LOCKED` but before committing. What happens to the job?

- [ ] It is lost
- [ ] It stays locked until someone clears it by hand
- [x] The transaction rolls back, the lock is released and the job is pending again
- [ ] It is marked as failed

> The claim lived inside the transaction. No transaction, no claim.
