---
title: The B-tree index
part: Indexes
concept: B-tree index | A sorted copy of one or more columns with pointers to rows. Equality and ranges become a seek instead of a scan.
---

## What an index is

A B-tree index is a separate, sorted structure holding the indexed values plus a pointer to each row.
Looking up `customer_id = 4242` in a table of 1,000,000 orders becomes a handful of page reads down a
tree instead of a scan of every page.

The price: every `INSERT`, `UPDATE` and `DELETE` must maintain the index too, and it takes disk space.
That's why indexes are a decision, not a default.

```sql
CREATE INDEX orders_customer_id_idx ON orders (customer_id);
```

The name is optional; Postgres invents `orders_customer_id_idx` for you.

## What a B-tree can serve

Because it is sorted, a B-tree answers:

- equality: `= 4242`, `IN (1, 2, 3)`
- ranges: `>`, `<`, `BETWEEN`, `created_at >= '2025-03-01' AND created_at < '2025-04-01'`
- prefix pattern matching: `LIKE 'abc%'` (not `'%abc'`, see the full-text round)
- `ORDER BY` on the indexed column, and `MIN`/`MAX`
- `IS NULL`

It cannot help with `lower(email) = ...` (the index stores `email`, not `lower(email)`) or with
`LIKE '%text%'`. Those get their own rounds.

## Why Postgres sometimes ignores your index

If a filter matches a large share of the table, reading the table in order is cheaper than jumping around
through an index. `WHERE status = 'delivered'` matches 78% of orders: no index will be used, and that is
correct. Indexes pay off for **selective** conditions, roughly under a few percent of rows.

## Foreign keys are not indexed

Postgres creates an index for a `PRIMARY KEY` and `UNIQUE`, but **not** for a `FOREIGN KEY`. `orders.customer_id`
references `customers`, and it has no index. Every "orders of this customer" query and every delete of a
customer scans a million rows. This is the most common missing index in real schemas.

## Exercise: Orders of one customer

Return every order of customer 4242 (all columns) at least 10× faster than the baseline. Your query may
stay exactly the same; the fix goes in Setup.

```sql baseline
SELECT * FROM orders WHERE customer_id = 4242
```

```sql solution-setup
CREATE INDEX ON orders (customer_id);
```

```sql solution
SELECT * FROM orders WHERE customer_id = 4242;
```

```meta
speedup: 10
forbid: Seq Scan on orders
```

> Hint: Run it first and look at the plan: a Seq Scan removes 999,987 rows by filter.

> Hint: `CREATE INDEX ON orders (customer_id);` in Setup. Rerun and compare the plans.

## Exercise: A week of orders

Count orders created in the week starting 2025-03-01, at least 10× faster, with no Seq Scan on `orders`.

```sql baseline
SELECT count(*) FROM orders
WHERE created_at >= '2025-03-01' AND created_at < '2025-03-08'
```

```sql solution-setup
CREATE INDEX ON orders (created_at);
```

```sql solution
SELECT count(*) FROM orders
WHERE created_at >= '2025-03-01' AND created_at < '2025-03-08';
```

```meta
speedup: 10
forbid: Seq Scan on orders
```

> Hint: A range on one column is still a B-tree job.

> Hint: Look for `Index Only Scan` in your plan: the count needs no column but `created_at`, so the index alone answers it.

## Quiz

### Which condition can a B-tree index on `email` NOT accelerate?

- [ ] `email = 'a@b.c'`
- [ ] `email LIKE 'user42%'`
- [x] `email LIKE '%@example.com'`
- [ ] `email > 'm'`

> A B-tree is sorted by the leading characters. A pattern that begins with `%` has no prefix to seek to.

### Why does Postgres create an index for a PRIMARY KEY but not for a FOREIGN KEY?

- [ ] It does create one; you just don't see it in the catalog
- [x] A primary key must be unique, which needs an index to enforce; a foreign key only needs the *referenced* side indexed
- [ ] Foreign key indexes would make inserts too slow
- [ ] It is a known bug

> Uniqueness is enforced by the index. The FK check looks up the parent's primary key, which is already indexed. Whether the child column deserves an index is left to you.

### `WHERE status = 'delivered'` matches 78% of the table. An index on status exists. What will the planner do?

- [x] Seq Scan, because reading most of the table through an index is slower than reading it in order
- [ ] Index Scan, because an index always wins
- [ ] Refuse to run without a LIMIT
- [ ] Bitmap Heap Scan on every row

> An index is a detour. It pays only when it lets you skip most of the table.
