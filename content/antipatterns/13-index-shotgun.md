---
title: Index Shotgun
part: Physical Database Design
concept: MENTOR your indexes | Measure, Explain, Nominate, Test, Optimize, Rebuild. An index is chosen for a query you measured, not guessed.
---

## Objective

Make the database fast. Indexes are the main tool, so the question is which ones to create.

## The antipattern: indexes without a plan

Guessing takes three forms, and most schemas show all of them.

- **No indexes, or not enough.** "Indexes slow down writes" is true, and it is also the smaller cost.
  One index that turns a full scan into a seek pays for thousands of slightly slower inserts.
- **Too many indexes.** When nobody knows which index helps, people create one per column plus a few
  combinations. Each one is maintained on every write and takes space, and most are never read.
  Typical leftovers: an index on the primary key (it already has one), an index on `(status)` next to
  one on `(status, date_reported)`, and both `(a, b)` and `(b, a)` "to be safe".
- **Queries no index can serve.** An index on `(last_name, first_name)` does nothing for
  `ORDER BY first_name, last_name`, for `WHERE first_name = 'Linh'`, for `WHERE lower(last_name) = …`
  or for `LIKE '%son'`. The index exists and the query still scans.

```sql
CREATE INDEX ON shotgun_bugs (bug_id);                 -- duplicates the primary key
CREATE INDEX ON shotgun_bugs (status);                 -- prefix of the next one
CREATE INDEX ON shotgun_bugs (status, date_reported);
```

## How to recognize it

- "Here is my query. How can I make it faster?" with no plan and no timing attached.
- "I indexed every column and it is still slow."
- "I heard indexes make the database slow, so we don't use them."

## Legitimate uses

A general-purpose database whose queries you cannot predict (a hosting product, an ad-hoc reporting
store) has to be indexed on an educated guess. Guess, then measure as soon as real queries exist.

## Solution: MENTOR your indexes

- **Measure.** Find the queries that cost the most in total: `pg_stat_statements` ranks them by total
  time, and `log_min_duration_statement` logs the slow ones. A 5 ms query run a million times a day
  matters more than a 2 s report run once.
- **Explain.** Read the plan of each candidate with `EXPLAIN (ANALYZE, BUFFERS)`. Look for the scan that
  discards the most rows.
- **Nominate.** Choose the index that plan is asking for: equality columns first, then the range or sort
  column, and extra columns if an index-only scan is within reach.
- **Test.** Create it and measure again. Keep it only if the numbers improved.
- **Optimize.** Make sure the hot indexes fit in memory (`shared_buffers`, `effective_cache_size`).
- **Rebuild.** Indexes bloat after many updates and deletes. `REINDEX CONCURRENTLY` rebuilds one
  without blocking writes; autovacuum handles routine upkeep.

## Mini-antipattern: indexing every column

An index per column does not add up to the composite index a query needs. Postgres can combine single
indexes with a bitmap AND, which is slower than one index on `(status, date_reported)`, and you pay for
all of them on every write. Find the dead weight in the statistics views:

```sql
SELECT indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_stat_user_indexes
WHERE relname = 'shotgun_bugs'
ORDER BY idx_scan;          -- idx_scan = 0 after weeks of traffic: probably droppable
```

## Exercise: Find the redundant indexes

`shotgun_bugs` has nine indexes besides its primary key. An index is **redundant** when it is not unique
and its columns are a leading prefix of (or the same as) another index on the table: the longer index
can serve every query the shorter one can.

Return the name of each redundant index, one per row. Reading the list and typing the names counts.
Querying `pg_index` counts too.

```sql starter
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'bugs' AND tablename = 'shotgun_bugs'
ORDER BY indexname;
```

```sql reference
SELECT DISTINCT c.relname
FROM pg_index a
JOIN pg_index b ON b.indrelid = a.indrelid AND b.indexrelid <> a.indexrelid
JOIN pg_class c ON c.oid = a.indexrelid
WHERE a.indrelid = 'bugs.shotgun_bugs'::regclass
  AND NOT a.indisunique
  AND (b.indkey::text = a.indkey::text OR b.indkey::text LIKE a.indkey::text || ' %')
```

```sql solution
SELECT DISTINCT c.relname
FROM pg_index a
JOIN pg_index b ON b.indrelid = a.indrelid AND b.indexrelid <> a.indexrelid
JOIN pg_class c ON c.oid = a.indexrelid
WHERE a.indrelid = 'bugs.shotgun_bugs'::regclass
  AND NOT a.indisunique
  AND (b.indkey::text = a.indkey::text OR b.indkey::text LIKE a.indkey::text || ' %')
ORDER BY 1;
```

> Hint: Run the starter and compare the column lists. `(status)` is a prefix of `(status, date_reported)`.

> Hint: There are four. The primary key and the unique index are never redundant: they enforce a rule.

> Hint: By hand: `SELECT * FROM (VALUES ('first_index_name'), ('second_index_name')) AS t(name);`

## Exercise: The index exists, the query is still slow

A colleague "indexed the query" below with `(created_at, customer_id)`. It is barely faster, because the
range column comes first. Nominate the right index and test it: at least 50× faster than the unindexed baseline.

```sql baseline
SELECT id, created_at, total
FROM orders
WHERE customer_id = 4242 AND created_at >= '2024-01-01'
ORDER BY created_at
```

```sql starter-setup
CREATE INDEX ON orders (created_at, customer_id);
```

```sql solution-setup
CREATE INDEX ON orders (customer_id, created_at);
```

```sql solution
SELECT id, created_at, total
FROM orders
WHERE customer_id = 4242 AND created_at >= '2024-01-01'
ORDER BY created_at;
```

```meta
schema: perf
ordered: true
speedup: 50
```

> Hint: Run the starter and read the plan. How many index entries does it walk to find a handful of rows?

> Hint: Equality column first, range column last: `(customer_id, created_at)`. That order also returns the rows already sorted.

## Quiz

### What does the M in MENTOR tell you to do before creating any index?

- [ ] Memorize the schema
- [x] Measure which queries cost the most total time
- [ ] Migrate to a bigger server
- [ ] Mark every foreign key column

> Without measurement you optimize the query you happen to be looking at, which is rarely the one that hurts.

### A table has indexes on `(status)` and on `(status, date_reported)`. Which statement is true?

- [ ] Both are needed: the first for equality, the second for ranges
- [x] The first is redundant: the composite index serves `WHERE status = …` too
- [ ] The second is redundant
- [ ] Postgres merges them automatically

> A B-tree on `(a, b)` is sorted by `a` first, so it answers every query a B-tree on `(a)` can.

### An index on `(last_name, first_name)` exists. Which query can use it?

- [ ] `WHERE first_name = 'Linh'`
- [ ] `ORDER BY first_name, last_name`
- [x] `WHERE last_name = 'Tran' ORDER BY first_name`
- [ ] `WHERE last_name LIKE '%an'`

> The index is sorted by last name, then first name. Only queries that start from the leading column can seek into it.
