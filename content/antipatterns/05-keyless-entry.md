---
title: Keyless Entry
part: Logical Database Design
concept: Declare foreign keys | Let the database reject orphans and cascade key changes, instead of writing check-first code and cleanup scripts.
---

## Objective

Keep the relationships between tables correct: every `reported_by` names an account that exists, every
`status` is a value from the status lookup table. A **foreign key constraint** does exactly that. The
reasons people give for leaving it out: "updates get harder", "my design is too flexible for foreign keys",
"they slow things down", or simply not remembering the syntax.

## The antipattern: leave out the constraints

Skipping the constraint doesn't remove the work. It moves it into your code, where it's done less reliably.

**Assuming flawless code.** To keep references valid by hand, you check before every write:

```sql
SELECT account_id FROM accounts WHERE account_id = 1;   -- does the parent exist?
INSERT INTO keyless_bugs (bug_id, summary, reported_by) VALUES (13, 'Crash', 1);
```

Between the check and the write, another session can delete that account (or insert a bug for the account
you're about to delete). Closing that gap needs table locks, which kill concurrency.

**Checking for mistakes afterwards.** Then come the quality-control scripts that hunt for **orphans**, one
query per relationship:

```sql
SELECT b.bug_id, b.status
FROM keyless_bugs b
WHERE NOT EXISTS (SELECT 1 FROM keyless_status s WHERE s.status = b.status);
```

You must decide how often to run them, and when they find something you often can't repair it: an invalid
status can be reset to a default, but who really reported a bug whose `reported_by` points at nobody?

**"It's not my fault."** Other applications, scripts, ad hoc SQL in a console and next year's code all write to
the same tables. Your careful checks only cover the code paths you wrote.

**Catch-22 updates.** People who *have* foreign keys sometimes drop them because changes look impossible.
Deleting a parent requires deleting children first; renaming a key value is worse, because neither the parent
nor the child can change first:

```sql
UPDATE keyless_status SET status = 'INVALID' WHERE status = 'BOGUS';  -- ERROR: still referenced
UPDATE keyless_bugs   SET status = 'INVALID' WHERE status = 'BOGUS';  -- ERROR: no such parent
```

## How to recognize it

- "How do I find values that exist in one table and not in the other?" (an orphan hunt)
- "Is there a quick way to check that a value exists in one table as part of my insert into another?"
- "Foreign keys? I was told they slow the database down."
- The schema can't hold a foreign key at all: a strong hint of another antipattern, such as
  Entity-Attribute-Value (chapter 6) or Polymorphic Associations (chapter 7).

## Legitimate uses

- A one-off data cleanup where known orphans must be kept while someone researches them (in Postgres, prefer
  a `NOT VALID` constraint, below, over no constraint).
- Bulk loads into an empty table, where you add the constraints once the load is done.
- Engines that can't enforce foreign keys (MySQL's MyISAM, very old SQLite). Postgres always can.

Locking is a weaker argument in Postgres than you might hear: inserting a child takes a `FOR KEY SHARE` lock on
the parent row, which only conflicts with deleting the parent or changing its key.

## Solution: declare constraints

Make the database reject bad data, no matter who sends it ("poka-yoke": mistake-proofing):

```sql
CREATE TABLE keyless_bugs (
  bug_id      bigint PRIMARY KEY,
  reported_by bigint NOT NULL REFERENCES accounts(account_id)
                ON UPDATE CASCADE ON DELETE RESTRICT,
  assigned_to bigint REFERENCES accounts(account_id) ON DELETE SET NULL,
  status      varchar(20) NOT NULL DEFAULT 'NEW' REFERENCES keyless_status(status)
                ON UPDATE CASCADE ON DELETE SET DEFAULT
);
```

**Referential actions** answer the catch-22. When the parent's key changes or the parent row is deleted:

| Action | Effect on child rows |
|---|---|
| `NO ACTION` (default) / `RESTRICT` | the change is rejected while children exist |
| `CASCADE` | children follow: updated with the new key, or deleted |
| `SET NULL` / `SET DEFAULT` | the child column is reset (Postgres 15+ can name which columns) |

With `ON UPDATE CASCADE`, renaming `BOGUS` to `INVALID` is one statement against `keyless_status`, and both
tables change atomically. Another option is `DEFERRABLE INITIALLY DEFERRED`, which checks the constraint at
commit instead of after each statement.

A foreign key column that allows `NULL` isn't checked when it is `NULL`: an unassigned bug is not an orphan.

**Adding constraints to dirty data.** `ALTER TABLE ... ADD FOREIGN KEY` checks every existing row and fails on
the first orphan. Clean up first, or add the constraint `NOT VALID` (enforced for new writes immediately), fix
the old rows, then `ALTER TABLE ... VALIDATE CONSTRAINT`, which takes a weaker lock than a full add.

**Overhead? Not really.** The check is an index lookup on the parent's primary key, cheaper than the `SELECT`
you'd run by hand, with no race and no cleanup scripts. One Postgres-specific to-do: the **referencing**
column is **not** indexed automatically. Index `keyless_bugs(reported_by)` yourself if parents get deleted or
re-keyed, or every such change scans the child table.

## Exercise: Find every broken reference

`keyless_bugs` should reference `accounts` (via `reported_by` and `assigned_to`) and `keyless_status` (via
`status`), but no foreign keys were declared. List every broken reference as `bug_id, column_name`, where
`column_name` is `'reported_by'`, `'assigned_to'` or `'status'`. A bug with two broken references appears twice.
An unassigned bug (`assigned_to IS NULL`) is fine.

```sql starter
SELECT b.bug_id, 'reported_by' AS column_name
FROM keyless_bugs b
LEFT JOIN accounts a ON a.account_id = b.reported_by
WHERE a.account_id IS NULL;
```

```sql reference
SELECT bug_id, 'reported_by' FROM keyless_bugs WHERE reported_by NOT IN (SELECT account_id FROM accounts)
UNION ALL
SELECT bug_id, 'assigned_to' FROM keyless_bugs WHERE assigned_to NOT IN (SELECT account_id FROM accounts)
UNION ALL
SELECT bug_id, 'status' FROM keyless_bugs WHERE status NOT IN (SELECT status FROM keyless_status)
```

```sql solution
SELECT b.bug_id, 'reported_by' AS column_name
FROM keyless_bugs b
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.account_id = b.reported_by)
UNION ALL
SELECT b.bug_id, 'assigned_to'
FROM keyless_bugs b
WHERE b.assigned_to IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.account_id = b.assigned_to)
UNION ALL
SELECT b.bug_id, 'status'
FROM keyless_bugs b
WHERE NOT EXISTS (SELECT 1 FROM keyless_status s WHERE s.status = b.status);
```

> Hint: One orphan check per relationship, glued together with `UNION ALL`. This is exactly the script the foreign keys would make unnecessary.

> Hint: With `LEFT JOIN ... WHERE a.account_id IS NULL`, an unassigned bug looks like an orphan too. Add `b.assigned_to IS NOT NULL`, or use `NOT EXISTS`.

> Hint: String keys are compared exactly: `'Fixed'` is not `'FIXED'`.

## Exercise: Rename a status with ON UPDATE CASCADE

Put a foreign key on `keyless_bugs.status` referencing `keyless_status`, declared `ON UPDATE CASCADE`. It
can't be added while orphans exist, so first reset every orphaned status to the column's default. Then rename
the status `BOGUS` to `INVALID` with a single `UPDATE` on **`keyless_status`** and let the cascade fix the bugs.
Finally return `status, bugs` (count per status) from `keyless_bugs`.

```sql starter-setup
-- 1. Reset orphaned statuses to the default
-- UPDATE keyless_bugs SET status = ... WHERE ...;

-- 2. ALTER TABLE keyless_bugs ADD FOREIGN KEY (status) REFERENCES ... ;

-- 3. One UPDATE on keyless_status
UPDATE keyless_bugs SET status = 'INVALID' WHERE status = 'BOGUS';
```

```sql starter
SELECT status, count(*) AS bugs
FROM keyless_bugs
GROUP BY status;
```

```sql reference
SELECT CASE WHEN b.status = 'BOGUS' THEN 'INVALID' WHEN s.status IS NULL THEN 'NEW' ELSE b.status END, count(*)
FROM keyless_bugs b
LEFT JOIN keyless_status s USING (status)
GROUP BY 1
```

```sql solution-setup
UPDATE keyless_bugs SET status = DEFAULT
WHERE status NOT IN (SELECT status FROM keyless_status);

ALTER TABLE keyless_bugs
  ADD FOREIGN KEY (status) REFERENCES keyless_status (status)
  ON UPDATE CASCADE;

UPDATE keyless_status SET status = 'INVALID' WHERE status = 'BOGUS';
```

```sql solution
SELECT status, count(*) AS bugs
FROM keyless_bugs
GROUP BY status;
```

```meta
require: references\s+keyless_status | Add a foreign key that references keyless_status
require: on\s+update\s+cascade | Declare it ON UPDATE CASCADE
```

> Hint: `UPDATE keyless_bugs SET status = DEFAULT WHERE status NOT IN (SELECT status FROM keyless_status)` resets the orphans (`BANANA`, `Fixed`).

> Hint: `ALTER TABLE keyless_bugs ADD FOREIGN KEY (status) REFERENCES keyless_status (status) ON UPDATE CASCADE;`

> Hint: Without the cascade, renaming the parent fails with "still referenced". With it, the one `UPDATE keyless_status ...` rewrites the matching bugs too.

## Quiz

### Your code checks that the account exists, then inserts the bug. Why isn't that as good as a foreign key?

- [ ] The `SELECT` is slower than an insert
- [x] Another session can delete the account between your check and your insert
- [ ] Foreign keys also validate the bug's summary
- [ ] It is just as good if every developer remembers to do it

> Check-then-act races with concurrent sessions, and it only protects the code paths that remember to do it. The constraint is checked inside the database for every writer.

### What does `ON UPDATE CASCADE` on `keyless_bugs.status` do when you rename a status in `keyless_status`?

- [ ] It rejects the rename while bugs use that status
- [ ] It sets those bugs' status to NULL
- [x] It rewrites those bugs' status to the new value in the same statement
- [ ] It deletes those bugs

> The child rows follow the parent's key, atomically. Without an action, the default `NO ACTION` would reject the rename.

### Which Postgres statement is true about foreign keys?

- [ ] Postgres automatically indexes the referencing (child) column
- [x] Postgres requires a unique index on the referenced column, but you must index the referencing column yourself
- [ ] Foreign keys are only enforced at the end of the transaction
- [ ] A foreign key column can't be NULL

> The parent side must be a primary key or unique. The child side has no automatic index, so deletes of parents can scan the child table.

### The table has known orphans you can't fix yet. What's the Postgres way to start enforcing the relationship?

- [ ] Leave the foreign key out until the data is clean
- [x] `ADD CONSTRAINT ... FOREIGN KEY ... NOT VALID`, then `VALIDATE CONSTRAINT` after the cleanup
- [ ] Add a trigger that deletes orphans every night
- [ ] Use `ON DELETE CASCADE` so the orphans disappear

> `NOT VALID` skips the check of existing rows but enforces the constraint for every new insert and update right away.
