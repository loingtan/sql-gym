---
title: Partial indexes
part: Indexes
concept: Partial index | Index only the rows a query cares about. Tiny index, fast writes elsewhere, and a filter the index enforces for you.
---

## Index the 2%, not the 100%

Only 2% of orders are `pending`, yet "show me pending orders" is the query the ops dashboard runs all
day. An index on `status` would carry a million entries, 98% of them useless for that query. A
**partial index** stores only the rows that match a `WHERE` clause:

```sql
CREATE INDEX orders_pending_idx ON orders (created_at) WHERE status = 'pending';
```

That index has about 20,000 entries, sorted by `created_at`. Inserting a delivered order does not touch
it at all. For a query to use it, the query's `WHERE` must *imply* the index predicate: it needs
`status = 'pending'` in it.

The same trick serves "rare" columns: `twitter` is empty for 97% of customers, so an index
`WHERE twitter <> ''` is tiny and makes "customers with a Twitter handle" instant.

## Partial unique indexes

A partial index can also be unique: "only one active subscription per customer" is
`CREATE UNIQUE INDEX ON subscriptions (customer_id) WHERE status = 'active'`. A plain unique constraint
can't express that.

## The trade-off

Every index is a bet on a query shape. A partial index is a narrower bet: faster and cheaper, but useless
for any query that doesn't repeat its predicate. Make the bet when the subset is small *and* queried often.

## Exercise: Pending orders, oldest first

The ops queue shows the 50 oldest pending orders. Beat the baseline by 10× with a **partial** index, and
compare the index size in your head: 1,000,000 vs about 20,000 entries.

```sql baseline
SELECT id, customer_id, created_at, total
FROM orders
WHERE status = 'pending'
ORDER BY created_at
LIMIT 50
```

```sql solution-setup
CREATE INDEX ON orders (created_at) WHERE status = 'pending';
```

```sql solution
SELECT id, customer_id, created_at, total
FROM orders
WHERE status = 'pending'
ORDER BY created_at
LIMIT 50;
```

```meta
ordered: true
speedup: 10
forbid: Seq Scan on orders
forbid: Sort
require: create\s+index[^;]*\bwhere\b | Use a partial index (CREATE INDEX … WHERE …)
```

> Hint: The index should contain only pending orders, sorted by `created_at`, so `ORDER BY … LIMIT 50` reads just 50 entries.

> Hint: `CREATE INDEX ON orders (created_at) WHERE status = 'pending';` The query's WHERE must mention `status = 'pending'` exactly.

## Exercise: Customers on Twitter

Count customers whose `twitter` handle is not empty, 10× faster, using a partial index. The baseline reads
200,000 rows to find 6,000.

```sql baseline
SELECT count(*) FROM customers WHERE twitter <> ''
```

```sql solution-setup
CREATE INDEX ON customers (twitter) WHERE twitter <> '';
```

```sql solution
SELECT count(*) FROM customers WHERE twitter <> '';
```

```meta
speedup: 10
forbid: Seq Scan on customers
require: create\s+index[^;]*\bwhere\b | Use a partial index (CREATE INDEX … WHERE …)
```

> Hint: `CREATE INDEX ON customers (twitter) WHERE twitter <> '';` The count then comes from a 6,000-entry index.

## Quiz

### A partial index `ON orders (created_at) WHERE status = 'pending'` exists. Which query can use it?

- [ ] `SELECT * FROM orders WHERE created_at > '2025-01-01'`
- [x] `SELECT * FROM orders WHERE status = 'pending' AND created_at > '2025-01-01'`
- [ ] `SELECT * FROM orders WHERE status IN ('pending', 'shipped')`
- [ ] `SELECT * FROM orders ORDER BY created_at`

> The planner must prove the query only needs rows the index contains. Only a WHERE that implies `status = 'pending'` qualifies.

### What is the main benefit of a partial index over a full one, besides lookup speed?

- [ ] It can index two tables
- [x] It is much smaller and is not updated when non-matching rows change
- [ ] It never needs VACUUM
- [ ] It works for LIKE '%x%'

> A write to a delivered order skips the pending index entirely. Less I/O, less bloat.

### "At most one active subscription per customer" is best enforced by

- [ ] A CHECK constraint on status
- [ ] A trigger
- [x] A partial unique index on (customer_id) WHERE status = 'active'
- [ ] A unique constraint on (customer_id, status)

> The unique constraint on (customer_id, status) would forbid two *cancelled* subscriptions too. The partial unique index targets exactly the rule.
