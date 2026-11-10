---
title: Aggregation and precomputation
part: Queries
concept: Precompute what you read often | A report that scans millions of rows every time belongs in a materialized view, refreshed on a schedule.
---

## Aggregates have to touch every row

`SELECT product_id, sum(quantity) FROM order_items GROUP BY product_id` genuinely needs all 2.5 million
rows. An index can't make that smaller; it can only change *how* the rows are read. Two things help:

**HashAggregate vs GroupAggregate.** With enough `work_mem`, Postgres builds a hash table of groups in
one pass (`HashAggregate`). Without it, the planner sorts first and aggregates runs (`GroupAggregate`),
which is slower. `Batches: 8` or `Disk:` in the plan mean the hash spilled; raising `work_mem` for that
session is the fix.

**Index-only aggregation.** If every column the aggregate needs is in one index, the scan reads the
index instead of the wider table: fewer pages, and already sorted for `GroupAggregate`.

## When the answer doesn't change every second

A sales dashboard asks the same question every minute while the data changes slowly. A **materialized
view** stores the result:

```sql
CREATE MATERIALIZED VIEW product_sales AS
SELECT product_id, sum(quantity) AS units, sum(quantity * unit_price) AS revenue
FROM order_items
GROUP BY product_id;

CREATE UNIQUE INDEX ON product_sales (product_id);     -- needed for CONCURRENTLY, and for lookups

REFRESH MATERIALIZED VIEW CONCURRENTLY product_sales;  -- later, on a schedule; readers aren't blocked
```

Queries then read 20,000 precomputed rows instead of 2.5 million. The cost moves to the refresh, which
you control. Staleness is the trade: the view is as old as its last refresh.

Alternatives on the same spectrum: a summary table maintained by triggers (always fresh, writes slower),
or an application cache.

## Counting rows

`SELECT count(*) FROM orders` must visit every row or every index entry; Postgres keeps no live row count.
For an approximate count use `reltuples` from `pg_class` (updated by ANALYZE). For an exact count of a
subset, a partial or covering index makes an Index Only Scan possible.

## Exercise: Top 10 products by units sold

The report ranks products by units sold. The baseline aggregates all 2.5 million order items on every
call. Make it 20× faster by precomputing (a materialized view in Setup), then query the view.

```sql baseline
SELECT product_id, sum(quantity) AS units
FROM order_items
GROUP BY product_id
ORDER BY units DESC, product_id
LIMIT 10
```

```sql starter-setup
-- CREATE MATERIALIZED VIEW product_units AS ...
```

```sql starter
SELECT product_id, sum(quantity) AS units
FROM order_items
GROUP BY product_id
ORDER BY units DESC, product_id
LIMIT 10;
```

```sql solution-setup
CREATE MATERIALIZED VIEW product_units AS
SELECT product_id, sum(quantity) AS units
FROM order_items
GROUP BY product_id;
```

```sql solution
SELECT product_id, units
FROM product_units
ORDER BY units DESC, product_id
LIMIT 10;
```

```meta
ordered: true
speedup: 20
require: materialized\s+view | Create a materialized view in Setup
forbid: Seq Scan on order_items
```

> Hint: `CREATE MATERIALIZED VIEW product_units AS SELECT product_id, sum(quantity) AS units FROM order_items GROUP BY product_id;`

> Hint: Then the query reads the view: 20,000 rows, sorted, LIMIT 10. (Setup time isn't counted; a refresh would cost the same.)

## Exercise: Revenue for one week, from an index

Revenue (`sum(total)`, rounded to 2 decimals) for the first week of June 2025. Beat the baseline 3× with an index that
contains both `created_at` and `total`, so the aggregate reads the index instead of the table. Then try the
same index with a whole-year range in the console: a quarter of the table through an index is *slower*
than a parallel Seq Scan, and the planner knows it.

```sql baseline
SELECT round(sum(total), 2) AS revenue
FROM orders
WHERE created_at >= '2025-06-01' AND created_at < '2025-06-08'
```

```sql solution-setup
CREATE INDEX ON orders (created_at, total);
```

```sql solution
SELECT round(sum(total), 2) AS revenue
FROM orders
WHERE created_at >= '2025-06-01' AND created_at < '2025-06-08';
```

```meta
speedup: 3
forbid: Seq Scan on orders
```

> Hint: The query needs only `created_at` and `total`. Put both in one index and look for "Index Only Scan".

> Hint: `CREATE INDEX ON orders (created_at, total);` The range on `created_at` makes it the leading column.

## Quiz

### `HashAggregate … Batches: 16 Disk: 48000kB` in the plan means

- [ ] The result has 16 rows
- [x] The hash table didn't fit in work_mem and spilled to disk
- [ ] Postgres used 16 CPU cores
- [ ] The table is partitioned 16 ways

> Spilling turns an in-memory pass into disk I/O. More `work_mem` for that session usually fixes it.

### What is the cost of a materialized view?

- [ ] It makes writes to the base tables fail
- [x] Its data is stale until the next REFRESH, and the refresh does the full computation
- [ ] It doubles query time
- [ ] Nothing, it's free

> You trade freshness for speed. Decide how stale the dashboard may be, and schedule the refresh accordingly.

### Why can't Postgres answer `SELECT count(*) FROM orders` instantly?

- [ ] It can; it's instant
- [x] Under MVCC, different transactions see different row sets, so there is no single stored count
- [ ] count(*) is deprecated
- [ ] The table has no primary key

> Each transaction has its own view of which rows exist. A stored counter would be wrong for someone.
