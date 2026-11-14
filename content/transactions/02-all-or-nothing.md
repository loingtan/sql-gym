---
title: All or nothing
part: Concurrency
concept: Atomicity | A transaction's statements all take effect or none do. Wrap every multi-step change in BEGIN … COMMIT.
---

## The A in ACID

A transfer is two statements: add to one account, take from another. If the second fails after the
first succeeded, money has been created from nothing. A **transaction** groups statements so that they
succeed or fail **as one unit**:

```sql
BEGIN;
UPDATE accounts SET balance = balance + 60 WHERE id = 2;
UPDATE accounts SET balance = balance - 60 WHERE id = 1;
COMMIT;
```

- `COMMIT` makes all the changes permanent and visible to others, at once.
- `ROLLBACK` discards them all.
- If a statement fails inside the transaction, Postgres marks the transaction as aborted. Nothing more
  can be done in it, and ending it (even with `COMMIT`) rolls everything back.
- If the connection drops or the server crashes before `COMMIT`, it is rolled back too.

Without `BEGIN`, every statement is its own tiny transaction and commits immediately (**autocommit**).
That is the trap: the first `UPDATE` is permanent before the second one runs.

## What the four letters mean

- **Atomicity**: all or nothing. This round.
- **Consistency**: constraints hold at the end of every transaction. A `CHECK (balance >= 0)` cannot be
  bypassed by any path through the code.
- **Isolation**: concurrent transactions don't see each other's half-finished work. Next round.
- **Durability**: once `COMMIT` returns, the change survives a crash.

## Constraints are your last line of defence

The application should check that the sender has enough money. Checks in code race with each other
(round 1), so declare the rule in the table as well. When the constraint fires inside a transaction, the
whole transfer disappears cleanly. When it fires in autocommit mode, whatever ran before it stays.

## Keep transactions short

A transaction holds its row locks until it ends. Do the slow work (calling an API, rendering, waiting
for a user) before `BEGIN` or after `COMMIT`, never in between.

## Exercise: The transfer that creates money

Alice and Bob each have 100, and `balance` can never go below 0. Three workers each transfer 60 from
Alice to Bob at the same moment. Only one transfer can succeed, so the right final state is
Alice 40, Bob 160. The other two workers are **expected** to fail with a constraint error. Run the
starter, look at Bob, and fix the script.

```sql init
CREATE TABLE accounts (id int PRIMARY KEY, owner text NOT NULL, balance int NOT NULL CHECK (balance >= 0));
INSERT INTO accounts VALUES (1, 'alice', 100), (2, 'bob', 100);
```

```sql workers
SELECT 60 AS amount FROM generate_series(1, 3)
```

```sql starter
UPDATE accounts SET balance = balance + :amount WHERE id = 2;
UPDATE accounts SET balance = balance - :amount WHERE id = 1;
```

```sql solution
BEGIN;
UPDATE accounts SET balance = balance + :amount WHERE id = 2;
UPDATE accounts SET balance = balance - :amount WHERE id = 1;
COMMIT;
```

```sql check
SELECT id, balance FROM accounts ORDER BY id
```

```sql expected
VALUES (1, 40), (2, 160)
```

```meta
kind: race
```

> Hint: In the starter every UPDATE commits on its own. Bob is credited three times, and two of the debits then fail.

> Hint: Put `BEGIN;` before and `COMMIT;` after. When the debit fails, the credit in the same transaction is undone.

## Quiz

### In autocommit mode, statement 1 succeeds and statement 2 fails. What is stored?

- [ ] Nothing
- [x] The effect of statement 1 only
- [ ] Both
- [ ] It depends on the constraint

> Each statement was its own transaction. The first one committed before the second started.

### Inside a transaction a statement fails with a constraint error. You then send `COMMIT`. What happens?

- [ ] The earlier statements are committed
- [x] The whole transaction is rolled back
- [ ] The failed statement is retried
- [ ] Postgres waits for you to fix the data

> After an error the transaction is aborted. Ending it discards everything.

### Where should a slow call to a payment API go?

- [ ] Between BEGIN and the first UPDATE
- [ ] Between the two UPDATEs
- [x] Before BEGIN or after COMMIT
- [ ] It doesn't matter

> Locks are held until the transaction ends. Don't hold them while waiting on something outside the database.
