---
title: Pseudokey Neat-Freak
part: Application Development
concept: Keys aren't row numbers | Gaps in an id are harmless. Number rows when you query them with row_number().
---

## Objective

Tidy up the data. A report lists bugs 1, 2, 4 and someone asks "where is 3?" The gap looks like lost data,
so the urge is to make the numbers contiguous again.

## The antipattern: filling in the corners

**Reusing the lowest free id** needs a self-join to find the first gap on every insert:

```sql
SELECT b1.bug_id + 1
FROM bugs b1 LEFT JOIN bugs b2 ON b2.bug_id = b1.bug_id + 1
WHERE b2.bug_id IS NULL
ORDER BY b1.bug_id LIMIT 1;
```

It's slow, and two sessions that run it at the same time pick the same number. One of them fails, the same
race as `max(id) + 1`.

**Renumbering existing rows** (`UPDATE bugs SET bug_id = 3 WHERE bug_id = 4`) is worse:

- Every child row must follow (`ON UPDATE CASCADE`, or disabling constraints and fixing them by hand).
- Ids live **outside** the database too: printed labels, emails, URLs, other systems, last quarter's report.
  Renumbering silently points all of them at different rows.
- It doesn't stay tidy. A Postgres sequence or identity column hands out values greater than the last value **it**
  issued, not greater than `max(id)`, so the next insert opens a new gap.
- Reusing a deleted id gives an innocent new row the old row's history (the banned user's id now belongs to someone else).

## How to recognize it

- "How do I get my sequence value back after a rollback?" Sequences never roll back. That's what keeps concurrent inserts from blocking each other.
- "What happened to bug 4?" or "How do I find the first unused id?"
- "What if we run out of numbers?" A `bigint` won't run out.

## Legitimate uses

None for a pseudokey: its value should mean nothing. If the numbers carry meaning to people, they're a
**natural key**, and changing natural keys is normal. Store that meaningful identifier in its own column.

## Solution: get over it

A primary key must be unique and non-null. Being consecutive was never part of the job. When people need
consecutive numbers, compute them for the result set you are showing:

```sql
SELECT row_number() OVER (ORDER BY date_reported, bug_id) AS n, bug_id, summary
FROM bugs
ORDER BY n
LIMIT 50 OFFSET 50;          -- page 2
```

If you want ids that nobody reads as a count, use `uuid` (`gen_random_uuid()`) at the cost of 16 bytes and
random index inserts. And when a manager asks for renumbering, explain the harm and the real cost; it's
a communication problem more than a technical one.

## Mini-antipattern: auto-increment per group

"Invoice numbers must restart at 1 for every customer." Storing that counter means locking the group's rows
on every insert (or one sequence per group), and renumbering after deletes. Compute it instead:

```sql
SELECT bug_id, comment_id,
       row_number() OVER (PARTITION BY bug_id ORDER BY comment_date, comment_id) AS comment_number
FROM comments;
```

## Exercise: Consecutive numbers for a report

`neat_assets` has gaps in `asset_id` (rows were deleted). The accountants want a list numbered 1, 2, 3... in
`asset_id` order. Return `n, asset_id, label` **without changing any id**.

```sql starter
SELECT asset_id AS n, asset_id, label
FROM neat_assets
ORDER BY asset_id;
```

```sql reference
SELECT row_number() OVER (ORDER BY asset_id) AS n, asset_id, label
FROM neat_assets
ORDER BY asset_id
```

```sql solution
SELECT row_number() OVER (ORDER BY asset_id) AS n, asset_id, label
FROM neat_assets
ORDER BY n;
```

```meta
ordered: true
require: row_number\s*\(\s*\)\s*over | Number the rows with row_number() OVER (...)
```

> Hint: The id is the row's identity. The display number belongs to this one result, so compute it in the query.

> Hint: `row_number() OVER (ORDER BY asset_id)` gives 1, 2, 3... with no gaps.

## Exercise: Numbering per department

Each department wants its own numbering, starting at 1, oldest purchase first. Return `department, n, asset_id`
ordered by department, then `n`.

```sql starter
SELECT department, asset_id AS n, asset_id
FROM neat_assets
ORDER BY department, n;
```

```sql reference
SELECT department, row_number() OVER (PARTITION BY department ORDER BY bought_on, asset_id) AS n, asset_id
FROM neat_assets
ORDER BY department, n
```

```sql solution
SELECT department,
       row_number() OVER (PARTITION BY department ORDER BY bought_on, asset_id) AS n,
       asset_id
FROM neat_assets
ORDER BY department, n;
```

```meta
ordered: true
require: partition\s+by | Restart the numbering per department with PARTITION BY
```

> Hint: `PARTITION BY department` restarts the count for each department.

> Hint: Order inside the window by `bought_on` (with `asset_id` as a tie-breaker so the numbering is deterministic).

## Quiz

### A transaction that inserted a row was rolled back. Why does the next row skip that id?

- [ ] Postgres has a bug in sequences
- [x] Sequence values aren't transactional, so concurrent inserts never wait for each other
- [ ] The rolled-back row still exists on disk
- [ ] `ROLLBACK` deletes the sequence

> `nextval()` is never undone. Gaps are the price of fast, non-blocking key generation.

### After renumbering the highest bug from 4 to 3, what id does the next insert get from the identity column?

- [ ] 4
- [x] 5, because the sequence remembers it already handed out 4
- [ ] 3
- [ ] It fails with a duplicate key error

> A sequence continues from its own last value, not from `max(bug_id)`.

### Where should a gap-free "row 1, 2, 3" number come from?

- [ ] The primary key
- [ ] A trigger that renumbers rows after each delete
- [x] `row_number() OVER (...)` in the query that shows the rows
- [ ] A second sequence

> Row numbers describe a result set, while keys identify rows. Compute the number when you display it.
