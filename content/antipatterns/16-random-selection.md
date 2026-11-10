---
title: Random Selection
part: Queries
concept: Pick a key, not a shuffle | Choose a random key value and seek to it through the index; never sort the whole table just to keep one row.
---

## Objective

Fetch a **random sample row**: a rotating ad or news story, a random record for an audit, an operator
for an incoming call, test data. You want the database to hand you just that one row, not ship the
whole table to the application so it can pick.

## The antipattern: sort the data randomly

The textbook trick is to shuffle and keep the first row:

```sql
SELECT * FROM orders ORDER BY random() LIMIT 1;
```

It's short and obviously correct, and it gets slower with every row you add. A sort by a column can use
an index, because an index is a pre-sorted copy of that column. No index can hold `random()`, since its
value changes on every call. So Postgres has to read **every row**, call `random()` for each, and sort.
`EXPLAIN` shows it plainly:

```
Limit
  ->  Sort  (Sort Key: (random()))   -- top-N heapsort
        ->  Seq Scan on orders       -- all 1,000,000 rows
```

The "top-N heapsort" keeps memory small for `LIMIT 1`, but the work is still proportional to the table
size. With a few hundred rows in development, nobody notices. With a few million rows in production,
every page view pays for a full table scan.

## How to recognize it

- "Returning a random row in SQL is really slow." (It got slower as the table grew, and no tuning helps.)
- "I need more memory in the app server: I fetch all ids and pick one." (The table outgrows the app.)
- "Some rows come up far more often than others." (Random numbers are hitting the gaps between ids, see below.)

## Legitimate uses

When the set is small and **stays** small, `ORDER BY random()` is fine: picking one of 50 developers
to assign a bug, or one of the 50 US states. The cost only becomes a problem when the row count grows.

## Solution: in no particular order

Don't sort. Pick a random **position or key** first, then fetch that row through an index.

**Random key between min and max.** `min()`/`max()` on the primary key are two quick index lookups:

```sql
SELECT * FROM orders
WHERE id = (SELECT min(id) + floor(random() * (max(id) - min(id) + 1))::bigint FROM orders);
```

This only works when the ids are contiguous. If rows were deleted (or you filter, say
`status = 'cancelled'`), the random id often matches nothing.

**Next higher key.** Take the first existing key at or after the random value:

```sql
SELECT * FROM orders
WHERE id >= (SELECT min(id) + floor(random() * (max(id) - min(id)))::bigint FROM orders)
ORDER BY id
LIMIT 1;
```

That's an index seek plus a short walk, whatever the table size. The catch: a key that follows a big gap
"owns" the whole gap and wins more often. Use it when roughly random is good enough.

**Random offset.** Count the rows, pick a random number below the count, skip that many:

```sql
SELECT * FROM orders ORDER BY id OFFSET floor(random() * 1000000)::int LIMIT 1;
```

Every row has exactly the same chance, but in Postgres `OFFSET n` still walks past `n` rows, and
`count(*)` is a scan too (Postgres doesn't cache row counts; `pg_class.reltuples` gives a cheap estimate).
It avoids the sort but not the reading.

**`TABLESAMPLE`** is built in: `SYSTEM (p)` samples whole pages (very fast, but rows from the same page
come together), `BERNOULLI (p)` samples rows (uniform, still reads the table). The `tsm_system_rows`
extension adds `TABLESAMPLE SYSTEM_ROWS(n)`, and `REPEATABLE (seed)` makes a sample reproducible.

```sql
SELECT * FROM orders TABLESAMPLE SYSTEM (0.01) LIMIT 1;   -- reads ~0.01% of the pages
```

**Reuse the choice.** An ad can be the same for every visitor for five minutes. Cache it in the
application and pick again on a timer, so only one request per period pays for the query.

> Postgres detail: `random()` returns `double precision`, and a literal like `0.73` is `numeric`. If the
> computed key isn't cast back to `bigint`, the comparison becomes `id::numeric >= ...` and the primary
> key index can't be used. Always end the expression with `::bigint`.

## Mini-antipattern: query for multiple random rows

The naive way to get five rows is to raise the limit: `ORDER BY random() LIMIT 5`. It's still a full scan
and sort. The fast alternatives pick one row at a time, so you can run one of them five times, or do it in
a single statement with `LATERAL`, one index seek per random number:

```sql
SELECT o.*
FROM unnest(ARRAY[random(), random(), random()]) AS r
CROSS JOIN LATERAL (
  SELECT * FROM orders
  WHERE id >= (SELECT min(id) + floor(r * (max(id) - min(id)))::bigint FROM orders)
  ORDER BY id LIMIT 1
) o;
```

The price is extra code: two random numbers can land on the same row, so if you need *distinct* rows you
must check and retry, and guard against asking for more rows than the table has. Pick between the
slow-but-simple query and the fast-but-fussier one with your row counts in mind.

## Exercise: The dice rolled 0.7301

The dashboard shows one "random cancelled order" on every page view, and it's slow: it scans all one
million orders. To make the result checkable, the application has already rolled its random number for
you: **r = 0.7301**.

Use the *next higher key* technique over cancelled orders only:

- `lo` and `hi` are the smallest and largest `id` among orders with `status = 'cancelled'`
- `target = lo + floor(0.7301 * (hi - lo))`
- return `id, customer_id, total` of the first cancelled order with `id >= target`

It must be at least 20× faster than the `ORDER BY random()` baseline.

```sql baseline
SELECT id, customer_id, total
FROM orders
WHERE status = 'cancelled'
ORDER BY random()
LIMIT 1;
```

```sql reference
SELECT id, customer_id, total
FROM orders
WHERE status = 'cancelled'
  AND id >= (SELECT min(id) + floor(0.7301 * (max(id) - min(id)))::bigint
             FROM orders WHERE status = 'cancelled')
ORDER BY id
LIMIT 1
```

```sql solution
SELECT id, customer_id, total
FROM orders
WHERE status = 'cancelled'
  AND id >= (SELECT min(id) + floor(0.7301 * (max(id) - min(id)))::bigint
             FROM orders WHERE status = 'cancelled')
ORDER BY id
LIMIT 1;
```

```meta
schema: perf
speedup: 20
```

> Hint: `min(id)` and `max(id)` are answered from the primary key index, even with the `status` filter: Postgres walks the index from one end until it finds a cancelled order.

> Hint: `WHERE id = target` usually returns nothing, because most ids aren't cancelled orders. Use `id >= target ... ORDER BY id LIMIT 1`.

> Hint: Cast the computed target with `::bigint`. Otherwise `0.7301 * ...` is `numeric`, the comparison becomes `id::numeric >= ...`, and the index can't be used.

## Exercise: Five random rows, one query

Now the dashboard wants **five** random cancelled orders. The random generator produced
**0.05, 0.27, 0.48, 0.66, 0.93**. For each number, apply the same rule as before (`lo`, `hi` over
cancelled orders, `target = lo + floor(r * (hi - lo))`, first cancelled order with `id >= target`) and
return the five rows as `id, customer_id, total`, in a single query, at least 20× faster than
`ORDER BY random() LIMIT 5`.

```sql baseline
SELECT id, customer_id, total
FROM orders
WHERE status = 'cancelled'
ORDER BY random()
LIMIT 5;
```

```sql reference
WITH b AS (
  SELECT min(id) AS lo, max(id) AS hi FROM orders WHERE status = 'cancelled'
)
SELECT o.id, o.customer_id, o.total
FROM b, unnest(ARRAY[0.05, 0.27, 0.48, 0.66, 0.93]) AS r
CROSS JOIN LATERAL (
  SELECT id, customer_id, total FROM orders
  WHERE status = 'cancelled' AND id >= b.lo + floor(r * (b.hi - b.lo))::bigint
  ORDER BY id LIMIT 1
) o
```

```sql solution
WITH b AS (
  SELECT min(id) AS lo, max(id) AS hi FROM orders WHERE status = 'cancelled'
)
SELECT o.id, o.customer_id, o.total
FROM b, unnest(ARRAY[0.05, 0.27, 0.48, 0.66, 0.93]) AS r
CROSS JOIN LATERAL (
  SELECT id, customer_id, total FROM orders
  WHERE status = 'cancelled' AND id >= b.lo + floor(r * (b.hi - b.lo))::bigint
  ORDER BY id LIMIT 1
) o;
```

```meta
schema: perf
speedup: 20
```

> Hint: `unnest(ARRAY[0.05, 0.27, ...]) AS r` turns the five numbers into five rows.

> Hint: `CROSS JOIN LATERAL (SELECT ... WHERE id >= <target computed from r> ORDER BY id LIMIT 1)` runs one small index seek per number.

> Hint: Compute `lo` and `hi` once in a CTE, and remember the `::bigint` cast on the target.

## Quiz

### Why can't an index speed up `ORDER BY random() LIMIT 1`?

- [ ] Because `LIMIT 1` disables index use
- [x] Because the sort key is a new random value per row, which no index can contain, so every row must be read and compared
- [ ] Because Postgres doesn't support indexes on `bigint` columns
- [ ] It can, if you create an index on `random()`

> An index is a pre-sorted copy of stored values. A value that changes on every call can't be stored or pre-sorted, so the database must evaluate it for all rows.

### Ids 1–1000 exist except 501–900 (deleted). With "next higher key", which row is picked far more often than the others?

- [ ] Row 500
- [x] Row 901
- [ ] Row 1000
- [ ] None: every row has the same chance

> Every random value from 501 to 901 lands on 901, the first key after the gap, so it wins about 400 times more often than a typical row.

### Which technique gives every row exactly the same chance?

- [ ] Random key between min and max, with gaps in the ids
- [ ] Next higher key
- [x] A random offset below the row count (`OFFSET floor(random() * n) LIMIT 1`)
- [ ] `TABLESAMPLE SYSTEM`

> The offset maps each random number to exactly one position, so it's uniform. The cost is that Postgres walks past `offset` rows. `TABLESAMPLE SYSTEM` picks whole pages, so rows on the same page are chosen together.

### `WHERE id >= 0.73 * (SELECT max(id) FROM orders)` runs as a full scan even though `id` is the primary key. Why?

- [ ] The subquery runs once per row
- [ ] Primary keys can't be used with `>=`
- [x] The right side is `numeric`, so `id` is cast to `numeric` and the B-tree on `id` no longer applies
- [ ] `max()` can't use an index

> Cast the computed value back to the column type (`::bigint`) so the comparison is `bigint >= bigint` and the index range scan works.
