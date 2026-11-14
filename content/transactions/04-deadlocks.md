---
title: Deadlocks
part: Locking
concept: Lock in one order | A deadlock needs two transactions taking the same locks in opposite order. Always lock rows in the same order and it cannot happen.
---

## Two transactions, each waiting for the other

An `UPDATE` locks the rows it changes until the transaction ends. Now take two transfers running at the
same time, one from account 1 to 2 and one from 2 to 1:

```
A: UPDATE accounts … WHERE id = 1     → A holds row 1
B: UPDATE accounts … WHERE id = 2     → B holds row 2
A: UPDATE accounts … WHERE id = 2     → A waits for B
B: UPDATE accounts … WHERE id = 1     → B waits for A
```

Neither can continue. Left alone they would wait forever. Postgres notices: when a session has waited
for a lock longer than `deadlock_timeout` (1 second by default), it checks for a cycle, and if it finds
one it aborts one of the transactions:

```
ERROR: deadlock detected
DETAIL: Process 123 waits for ShareLock on transaction 456; blocked by process 789. …
```

The victim's work is rolled back and the other transaction proceeds. So a deadlock costs you a second of
stalling plus a failed request, and under load it happens again and again.

## The cause is the order, not the locks

Both transfers need both rows. The trouble is that they take them in **opposite order**. If every
transaction locked the lower id first, the second one would simply wait at its first step, holding
nothing the first one needs, and no cycle could form.

```sql
BEGIN;
SELECT id FROM accounts WHERE id IN (1, 2) ORDER BY id FOR UPDATE;   -- both rows, lowest id first
UPDATE accounts SET balance = balance - 10 WHERE id = 1;
UPDATE accounts SET balance = balance + 10 WHERE id = 2;
COMMIT;
```

Rules that keep deadlocks away:

- **Lock in a consistent order** everywhere in the code base: by primary key, or parent before child.
- **Keep transactions short**, so locks are held briefly.
- **Lock everything you need up front** instead of picking locks up along the way.
- **Retry.** A deadlock error is safe to retry, since the transaction was rolled back completely. Good
  code retries a few times. Good design makes it rarely necessary.

Deadlocks also come from less obvious places: two bulk `UPDATE`s that visit rows in different orders,
or foreign keys, where inserting a child row takes a lock on its parent.

## Exercise: Opposite transfers

Four workers run transfers of 10 at the same time: two from account 1 to 2, two from 2 to 1. Each
worker gets `:src` and `:dst`. Run the starter: it stalls for a second and at least one worker dies with
"deadlock detected". Make all four transfers succeed, with no deadlock.

```sql init
CREATE TABLE accounts (id int PRIMARY KEY, balance int NOT NULL);
INSERT INTO accounts VALUES (1, 100), (2, 100);
CREATE TABLE transfers (src int, dst int);
```

```sql workers
SELECT * FROM (VALUES (1, 2), (2, 1), (1, 2), (2, 1)) AS w(src, dst)
```

```sql starter
BEGIN;
UPDATE accounts SET balance = balance - 10 WHERE id = :src;
\wait 100
UPDATE accounts SET balance = balance + 10 WHERE id = :dst;
INSERT INTO transfers VALUES (:src, :dst);
COMMIT;
```

```sql solution
BEGIN;
SELECT id FROM accounts WHERE id IN (:src, :dst) ORDER BY id FOR UPDATE;
UPDATE accounts SET balance = balance - 10 WHERE id = :src;
\wait 100
UPDATE accounts SET balance = balance + 10 WHERE id = :dst;
INSERT INTO transfers VALUES (:src, :dst);
COMMIT;
```

```sql check
SELECT (SELECT count(*) FROM transfers) AS transfers, (SELECT sum(balance) FROM accounts) AS total
```

```sql expected
SELECT 4, 200
```

```meta
kind: race
goal: deadlocks = 0 | No deadlock
goal: errors = 0 | No worker fails
require: \\wait\s+100 | Keep the 100 ms of application work
```

> Hint: Worker 1 locks row 1 and wants row 2. Worker 2 locks row 2 and wants row 1. Look at how long the second UPDATEs take in the timeline.

> Hint: Before the updates, lock both rows in id order: `SELECT id FROM accounts WHERE id IN (:src, :dst) ORDER BY id FOR UPDATE;`

## Quiz

### What does Postgres do when it detects a deadlock?

- [ ] Waits until one transaction times out
- [x] Aborts one of the transactions with an error so the other can continue
- [ ] Aborts both
- [ ] Releases all locks and lets both continue

> One victim is rolled back. Its work is gone and the application should retry it.

### Which habit prevents deadlocks between two transfers that need the same two rows?

- [ ] Using a bigger connection pool
- [ ] Running at Serializable
- [x] Always locking the rows in the same order, for example by ascending id
- [ ] Adding an index

> Without opposite lock orders there is no cycle. The second transaction just waits its turn.

### Why is a deadlock error safe to retry?

- [x] The failed transaction was rolled back completely, so nothing is half-done
- [ ] Postgres retries it for you
- [ ] The locks are kept for the retry
- [ ] It isn't safe

> Atomicity again: the victim left no trace, so running it again is a clean second attempt.
