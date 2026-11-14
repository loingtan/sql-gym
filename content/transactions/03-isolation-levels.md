---
title: Isolation levels
part: Concurrency
concept: Snapshots | Read Committed sees a new snapshot per statement. Repeatable Read keeps one snapshot for the whole transaction.
---

## What may one transaction see of another?

Postgres never lets you read another transaction's uncommitted changes. What it lets you see of
*committed* changes, while your own transaction is still running, depends on the **isolation level**.

Postgres implements isolation with **MVCC** (multi-version concurrency control): an update writes a new
version of the row and keeps the old one for anyone still looking at it. Readers never block writers
and writers never block readers. A **snapshot** decides which versions you see.

## Read Committed (the default)

Every **statement** gets a fresh snapshot. Two statements in the same transaction can therefore see
different data if someone committed in between:

```sql
BEGIN;
SELECT sum(balance) FROM accounts;   -- 600
-- another session commits a deposit of 500
SELECT sum(balance) FROM accounts;   -- 1100
COMMIT;
```

This is a **non-repeatable read**. For a single request it rarely matters. For a report that runs
several queries and expects them to add up, it produces numbers that never existed together.

## Repeatable Read

The snapshot is taken at the first statement and kept until the transaction ends. Every query sees the
database as of that moment:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ;
```

The price shows up when you write. If you try to update a row that someone else changed after your
snapshot, Postgres refuses with `ERROR: could not serialize access due to concurrent update`, and the
application has to retry the transaction. For read-only work such as reports and exports there is no
such cost, and `pg_dump` uses it for exactly this reason.

## Serializable

The strictest level: the result is guaranteed to be the same as if the transactions had run one after
another in some order. Postgres detects dangerous patterns (such as **write skew**, where two
transactions each read what the other is about to change) and aborts one with a serialization failure.
Use it when correctness rules span several rows and you are prepared to retry.

| Level | Snapshot | You may see | You must handle |
|---|---|---|---|
| Read Committed | per statement | different data in each statement | lost updates (round 1) |
| Repeatable Read | per transaction | one consistent picture | serialization errors on write |
| Serializable | per transaction | as if run one at a time | serialization errors, more often |

`READ UNCOMMITTED` exists in the syntax and behaves like Read Committed in Postgres.

## Exercise: The report that doesn't add up

A report reads the total of all balances at the start, does 300 ms of other work, reads the total again
and stores both numbers. Meanwhile another session deposits 500. The two totals must be equal: the
report should describe one moment in time. Change one line.

```sql init
CREATE TABLE accounts (id int PRIMARY KEY, balance int NOT NULL);
INSERT INTO accounts VALUES (1, 100), (2, 200), (3, 300);
CREATE TABLE report (total_at_start int, total_at_end int);
```

```sql workers
SELECT 1 AS run
```

```sql actor-depositor
\wait 100
UPDATE accounts SET balance = balance + 500 WHERE id = 2;
```

```sql starter
BEGIN;
SELECT sum(balance) AS total_at_start FROM accounts;
\wait 300
SELECT sum(balance) AS total_at_end FROM accounts;
INSERT INTO report VALUES (:total_at_start, :total_at_end);
COMMIT;
```

```sql solution
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT sum(balance) AS total_at_start FROM accounts;
\wait 300
SELECT sum(balance) AS total_at_end FROM accounts;
INSERT INTO report VALUES (:total_at_start, :total_at_end);
COMMIT;
```

```sql check
SELECT total_at_start = total_at_end AS same_moment FROM report
```

```sql expected
SELECT true
```

```meta
kind: race
goal: errors = 0 | No worker fails
require: \\wait\s+300 | Keep the 300 ms of other work
```

> Hint: The timeline shows the depositor's UPDATE landing between your two SELECTs. Each SELECT took its own snapshot.

> Hint: `BEGIN ISOLATION LEVEL REPEATABLE READ;` keeps one snapshot for the whole transaction.

## Quiz

### At Read Committed, when is a snapshot taken?

- [ ] Once per connection
- [ ] Once per transaction
- [x] At the start of every statement
- [ ] Never, it reads the latest data directly

> Each statement sees everything committed before it began, including commits made during your own transaction.

### A Repeatable Read transaction updates a row that another session changed and committed after the snapshot. What happens?

- [ ] The update silently overwrites the other change
- [ ] The update waits forever
- [x] It fails with "could not serialize access due to concurrent update" and must be retried
- [ ] The row is skipped

> The transaction's picture of that row is out of date. Postgres refuses the write instead of losing the other update.

### Do readers block writers in Postgres?

- [ ] Yes, always
- [x] No. Writers create new row versions and readers keep seeing the version in their snapshot
- [ ] Only at Repeatable Read
- [ ] Only for large tables

> That is what MVCC buys: reads and writes don't wait for each other.
