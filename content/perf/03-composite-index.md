---
title: Composite indexes
part: Indexes
concept: Column order | A multi-column index is sorted by the first column, then the second. Equality columns first, the range column last.
---

## Two columns, one index

`WHERE status = 'pending' AND created_at >= ... AND created_at < ...` can use an index on `status`,
or one on `created_at`, but each still has to filter on the other condition afterwards. A **composite**
index on both columns finds exactly the matching rows:

```sql
CREATE INDEX ON orders (status, created_at);
```

Think of it as a phone book sorted by last name, then first name. You can find all the Nguyens (first
column alone), or all the Nguyens named Linh (both). You cannot efficiently find everyone named Linh
(second column alone), because Linhs are scattered through the book.

## The ordering rule

Put columns compared with **equality** first, and the column with a **range** last. The index
`(status, created_at)` lets Postgres jump to `status = 'pending'` and then walk the range of
`created_at` in order. The reverse, `(created_at, status)`, walks the whole date range and checks
status for each entry: it works, but it reads many more index entries.

An index on `(a, b)` also serves queries on `a` alone, so you rarely need both `(a)` and `(a, b)`.

## Index-only scans

If every column the query needs is **in the index**, Postgres never visits the table. That is an
*Index Only Scan*, and it is why `count(*)` with an indexed filter is so fast. The visibility map must
be fresh (`VACUUM`) or Postgres falls back to checking the table (`Heap Fetches` in the plan).

## Exercise: Pending orders in June

Return all pending orders from June 2025 at least 10× faster than the baseline, with no Seq Scan on `orders`.

```sql baseline
SELECT * FROM orders
WHERE status = 'pending'
  AND created_at >= '2025-06-01' AND created_at < '2025-07-01'
```

```sql solution-setup
CREATE INDEX ON orders (status, created_at);
```

```sql solution
SELECT * FROM orders
WHERE status = 'pending'
  AND created_at >= '2025-06-01' AND created_at < '2025-07-01';
```

```meta
speedup: 10
forbid: Seq Scan on orders
require: create\s+index[^;]*\(\s*status\s*,\s*created_at | Index (status, created_at): equality column first, range column last
```

> Hint: One index with both columns. Which goes first?

> Hint: Try `(created_at, status)` too and compare the `Index Cond` and the buffers in both plans.

## Exercise: Cancelled, per customer

Which 10 customers have cancelled the most orders? Beat the baseline by 2× without a Seq Scan on `orders`.
The trick is to make the whole query answerable from an index.

```sql baseline
SELECT customer_id, count(*) AS cancelled
FROM orders
WHERE status = 'cancelled'
GROUP BY customer_id
ORDER BY cancelled DESC, customer_id
LIMIT 10
```

```sql solution-setup
CREATE INDEX ON orders (status, customer_id);
```

```sql solution
SELECT customer_id, count(*) AS cancelled
FROM orders
WHERE status = 'cancelled'
GROUP BY customer_id
ORDER BY cancelled DESC, customer_id
LIMIT 10;
```

```meta
ordered: true
speedup: 2
forbid: Seq Scan on orders
```

> Hint: The query only touches `status` and `customer_id`. If both are in one index, Postgres can do an Index Only Scan.

> Hint: `CREATE INDEX ON orders (status, customer_id);` Then check the plan for "Index Only Scan" and "Heap Fetches: 0".

## Quiz

### Index `(status, created_at)` exists. Which query can use it well?

- [ ] `WHERE created_at > '2025-01-01'`
- [x] `WHERE status = 'shipped'`
- [ ] `WHERE created_at > '2025-01-01' ORDER BY status`
- [ ] None without a second index

> The leading column alone is always usable. The second column alone is not: its values are scattered across every status.

### Why does a range column go last in a composite index?

- [x] After the equality columns pin a spot, the range is one contiguous walk; a range first would spread the equality matches across many places
- [ ] Postgres only allows one range column and it must be last
- [ ] Ranges are slower to compare
- [ ] It doesn't matter

> Index entries are sorted column by column. Equality first keeps every matching row together.

### What makes an Index Only Scan possible?

- [ ] Any index on the filtered column
- [x] Every column the query reads is in the index, and the visibility map is up to date
- [ ] A `LIMIT` clause
- [ ] A unique index

> If the index has everything the query needs, the table doesn't have to be touched. VACUUM keeps the visibility map that makes this safe.
