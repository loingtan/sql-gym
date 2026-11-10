---
title: Statistics and the planner
part: Foundations
concept: The planner guesses from statistics | Estimates drive every plan choice. Keep ANALYZE fresh, give the planner extended statistics for correlated columns, and verify with EXPLAIN before overriding it.
---

## Where estimates come from

The planner never looks at your data when planning. It looks at **statistics** gathered by `ANALYZE`
(run automatically by autovacuum): row counts, the most common values per column and their frequencies,
and a histogram of the rest. From these it estimates how many rows each node will produce, and from that
it picks scans, join orders and join methods.

When statistics are stale (a table that grew 10× since the last ANALYZE) or blind (correlated columns),
the estimates are wrong and the plan can be badly wrong. The fix is rarely a hint; it is better statistics.

```sql
ANALYZE orders;                 -- refresh statistics for one table
ALTER TABLE orders ALTER COLUMN status SET STATISTICS 500;   -- sample more values for a skewed column
```

## Correlated columns

Postgres assumes columns are independent. If `country = 'VN'` matches 30% of customers and a `city`
column only has Vietnamese cities for those rows, the planner estimates `country = 'VN' AND city =
'Hanoi'` as 30% × (share of Hanoi) instead of the real share. **Extended statistics** teach it the
dependency:

```sql
CREATE STATISTICS customers_country_city (dependencies) ON country, city FROM customers;
ANALYZE customers;
```

## Reading the misestimate

The plan viewer flags any node where estimated and actual rows differ 10× or more. Chase those first:
a Nested Loop planned for 5 rows that gets 50,000 is the usual cause of a query that is sometimes fast
and sometimes 100× slower.

## Testing the planner's decision

You can disable a strategy for one session to see what the alternative costs:

```sql
SET enable_seqscan = off;      -- not "never scan", just "price it very high"
EXPLAIN ANALYZE SELECT ...;
RESET enable_seqscan;
```

This is for *investigation*. If the forced plan is faster, the real fix is to find out why the planner
didn't choose it: missing statistics, wrong `random_page_cost` for SSDs, too little `work_mem`. Postgres
has no query hints in core; the `enable_*` switches are the closest thing and should not ship in
application code.

## Exercise: Forcing a plan, then earning it

The query counts products priced between 900 and 1000 (rare: prices are skewed low). In Setup, first
create the index on `price`. The baseline, without the index, does a Seq Scan. Make it 3× faster with no Seq Scan.
Then, for yourself, try the version with `SET enable_seqscan = off` *and no index* in the console and see the
Seq Scan still happen, since there is no alternative.

```sql baseline
SELECT count(*) FROM products WHERE price BETWEEN 900 AND 1000
```

```sql solution-setup
CREATE INDEX ON products (price);
```

```sql solution
SELECT count(*) FROM products WHERE price BETWEEN 900 AND 1000;
```

```meta
speedup: 3
forbid: Seq Scan on products
```

> Hint: `CREATE INDEX ON products (price);` With the index, the planner estimates ~1% of rows and prefers it on its own.

## Exercise: The planner's own numbers

Without touching the data, report the planner's row estimate for each of the five `perf` tables from the
catalog: `relname` and `reltuples::bigint`, ordered by name. This is what `ANALYZE` maintains and what
every estimate starts from.

```sql reference
SELECT c.relname, c.reltuples::bigint AS estimated_rows
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'perf' AND c.relkind = 'r'
ORDER BY c.relname
```

```sql starter
-- pg_class holds reltuples; pg_namespace holds the schema name
SELECT relname, reltuples::bigint AS estimated_rows
FROM pg_class
WHERE relname = 'orders';
```

```sql solution
SELECT c.relname, c.reltuples::bigint AS estimated_rows
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'perf' AND c.relkind = 'r'
ORDER BY c.relname;
```

```meta
ordered: true
require: pg_class | Read the estimate from pg_class
```

> Hint: Join `pg_class` to `pg_namespace` on `relnamespace = oid` and filter `nspname = 'perf'`, `relkind = 'r'` (ordinary tables).

## Quiz

### The plan says `rows=5` but the node produced 50,000. What is the first thing to try?

- [ ] Add a LIMIT
- [x] `ANALYZE` the table; if the columns are correlated, add extended statistics
- [ ] Rewrite the query with a CTE
- [ ] Set enable_nestloop = off in the application

> Bad plans come from bad estimates. Fix the information before overriding the decision.

### What does `SET enable_seqscan = off` actually do?

- [ ] Makes sequential scans impossible
- [x] Makes the planner price sequential scans very high so it prefers any alternative when one exists
- [ ] Drops the table's statistics
- [ ] Creates missing indexes

> If no index exists, the Seq Scan still happens. It's a steering wheel for experiments, not a guarantee.

### Why does the planner assume `country = 'VN' AND city = 'Hanoi'` is rarer than it really is?

- [ ] Because 'Hanoi' is not in the most-common-values list
- [x] It multiplies the two column selectivities as if they were independent; extended statistics fix this
- [ ] Because AND is slower than OR
- [ ] It doesn't; the estimate is exact

> Independence is the default assumption. `CREATE STATISTICS … (dependencies)` records that one column predicts the other.
