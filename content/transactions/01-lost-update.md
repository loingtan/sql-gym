---
title: The lost update
part: Concurrency
concept: Read-modify-write is a race | Two sessions that read a value, change it in the app and write it back will overwrite each other. Lock the row, or let the database do the arithmetic.
---

## Many users, one row

Everything so far assumed one query at a time. A real application has many sessions working at once, and
they touch the same rows. Most of the time Postgres keeps them out of each other's way. The lost update
is the simplest case where it doesn't, because the mistake is in the application's logic.

A shop account holds 100. Five deposits of 10 arrive at the same moment. Each request handler does the
obvious thing:

1. read the balance
2. add 10 in application code
3. write the new balance

All five read **100**. All five compute **110**. All five write **110**. Four deposits have vanished, no
error was raised, and every single statement did exactly what it was told.

```
worker 1: SELECT balance → 100
worker 2: SELECT balance → 100
worker 1: UPDATE … SET balance = 110
worker 2: UPDATE … SET balance = 110      ← overwrites worker 1
```

This pattern is called **read-modify-write**. A transaction (`BEGIN … COMMIT`) around it does not help
at Postgres's default isolation level: a plain `SELECT` takes no lock, so the other sessions read the
old value freely.

## Fix 1: let the database do the arithmetic

```sql
UPDATE accounts SET balance = balance + 10 WHERE id = 1;
```

One statement reads and writes under the row's lock. A second session running the same statement waits
for the first to commit, then sees the new balance and adds to that. Whenever the new value can be
computed in SQL, this is the best fix: shortest, fastest, no explicit locking.

## Fix 2: lock the row when you read it

Sometimes the application has to decide between the read and the write (check a limit, call a
pricing rule). Then say so when reading:

```sql
BEGIN;
SELECT balance FROM accounts WHERE id = 1 FOR UPDATE;   -- others now wait here
-- application logic
UPDATE accounts SET balance = … WHERE id = 1;
COMMIT;                                                   -- lock released
```

`FOR UPDATE` takes the row lock at read time. Other sessions that try to lock or update the row queue
up behind it, and each reads the fresh value when its turn comes. This is **pessimistic locking**.
Keep the transaction short, because everyone else is waiting.

A third option, **optimistic locking**, adds a `version` column: update `WHERE id = 1 AND version = 7`
and retry if no row was changed. It suits cases where conflicts are rare.

## How these exercises work

Each **worker** is a real database session. All workers run your script at the same time, on tables
that are created fresh for every run. Two extras turn SQL into a small script:

- `\wait 100` means the application is busy for 100 ms (not the database).
- When a `SELECT` returns a row, its columns become variables. After
  `SELECT balance FROM accounts …` you can write `:balance` in a later statement.

The timeline under the result shows every statement of every worker in the order it started.

## Exercise: Five deposits, one survives

Five workers each deposit `:amount` (10) into account 1, which starts at 100. The script reads the
balance, "thinks" for 100 ms and writes the sum. Run it and read the timeline. Then make the final
balance 150. Keep the `\wait 100`: the application really does need that time.

```sql init
CREATE TABLE accounts (id int PRIMARY KEY, owner text NOT NULL, balance int NOT NULL);
INSERT INTO accounts VALUES (1, 'shop', 100);
```

```sql workers
SELECT 10 AS amount FROM generate_series(1, 5)
```

```sql starter
BEGIN;
SELECT balance FROM accounts WHERE id = 1;
\wait 100
UPDATE accounts SET balance = :balance + :amount WHERE id = 1;
COMMIT;
```

```sql solution
BEGIN;
SELECT balance FROM accounts WHERE id = 1 FOR UPDATE;
\wait 100
UPDATE accounts SET balance = :balance + :amount WHERE id = 1;
COMMIT;
```

```sql check
SELECT balance FROM accounts WHERE id = 1
```

```sql expected
SELECT 150
```

```meta
kind: race
goal: errors = 0 | No worker fails
require: \\wait\s+100 | Keep the 100 ms of application work
```

> Hint: In the timeline, all five SELECTs finish before the first UPDATE starts. Every worker saw 100.

> Hint: Add `FOR UPDATE` to the SELECT. Now look at how long workers 2 to 5 spend on that SELECT.

> Hint: Or skip the read: `UPDATE accounts SET balance = balance + :amount WHERE id = 1;`

## Quiz

### Five sessions read balance 100, each adds 10 in the app and writes the result. What is the final balance?

- [ ] 150
- [x] 110
- [ ] 100
- [ ] An error is raised

> Every session computed 110 from the same stale read. The last write wins and the others are lost.

### Why doesn't wrapping the read and the write in `BEGIN … COMMIT` prevent this at the default isolation level?

- [ ] Transactions only work for INSERT
- [x] A plain SELECT takes no row lock, so other sessions read the old value at the same time
- [ ] COMMIT is too slow
- [ ] It does prevent it

> A transaction makes your own changes atomic. It does not stop others from reading a row you have only read.

### Which statement is safe without any explicit locking?

- [ ] `UPDATE accounts SET balance = 110 WHERE id = 1`
- [x] `UPDATE accounts SET balance = balance + 10 WHERE id = 1`
- [ ] `SELECT balance FROM accounts WHERE id = 1`
- [ ] `UPDATE accounts SET balance = :value_read_earlier + 10 WHERE id = 1`

> The read and the write happen inside one statement, under the row lock.
