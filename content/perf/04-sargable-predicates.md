---
title: Functions in WHERE
part: Queries
concept: Sargable predicates | An index stores raw column values. Wrap the column in a function and the index is invisible; wrap the constant instead, or index the expression.
---

## The index can't see through a function

`WHERE lower(email) = 'user777@example.com'` looks harmless, but an index on `email` stores `email`,
not `lower(email)`. Postgres has no way to find `lower(email)` values in it, so it scans the table and
computes `lower()` for every row. The same happens with:

```sql
WHERE date_trunc('month', created_at) = '2025-06-01'   -- function on the column
WHERE extract(year FROM created_at) = 2025               -- same
WHERE created_at::date = '2025-06-15'                    -- a cast is a function too
WHERE total + 0 > 400                                    -- arithmetic on the column
```

A predicate the index can use is called **sargable** ("search-argument-able"). The rule: **keep the column
naked on one side** and move the work to the constant.

```sql
WHERE created_at >= '2025-06-01' AND created_at < '2025-07-01'     -- instead of date_trunc
WHERE created_at >= '2025-06-15' AND created_at < '2025-06-16'     -- instead of ::date
```

Use half-open ranges (`>= start AND < next`), never `BETWEEN` with an end of `23:59:59`, which misses the
last second.

## When you can't rewrite: index the expression

Sometimes the function is the point, as with case-insensitive email lookup. Postgres can index an
**expression**:

```sql
CREATE INDEX ON customers (lower(email));
```

The query must then use the exact same expression, `lower(email)`, for the planner to match it.
(For case-insensitive text, the `citext` type or a collation is often cleaner.)

## Exercise: Case-insensitive email lookup

About 30% of emails were stored with capital letters (`User777@Example.com`). Find the customer by email,
ignoring case, at least 10× faster than the baseline and with no Seq Scan on `customers`.

```sql baseline
SELECT id, full_name FROM customers WHERE lower(email) = 'user777@example.com'
```

```sql solution-setup
CREATE INDEX ON customers (lower(email));
```

```sql solution
SELECT id, full_name FROM customers WHERE lower(email) = 'user777@example.com';
```

```meta
speedup: 10
forbid: Seq Scan on customers
```

> Hint: An index on `email` won't be used here. Index the expression the query actually compares.

> Hint: `CREATE INDEX ON customers (lower(email));`

## Exercise: Orders on one day

Count orders created on 2025-06-15 (UTC). An index on `created_at` is already provided in the starter setup; the
query still does a Seq Scan. Make the predicate sargable: 10× faster, no Seq Scan on `orders`.

```sql starter-setup
CREATE INDEX ON orders (created_at);
```

```sql baseline
SELECT count(*) FROM orders WHERE created_at::date = '2025-06-15'
```

```sql starter
SELECT count(*) FROM orders WHERE created_at::date = '2025-06-15';
```

```sql solution-setup
CREATE INDEX ON orders (created_at);
```

```sql solution
SELECT count(*) FROM orders
WHERE created_at >= '2025-06-15' AND created_at < '2025-06-16';
```

```meta
speedup: 10
forbid: Seq Scan on orders
```

> Hint: The cast `::date` is a function on the column. Turn "equals this day" into a half-open range of timestamps.

> Hint: `created_at >= '2025-06-15' AND created_at < '2025-06-16'`. Timestamps are stored in UTC here.

## Quiz

### Why can't an index on `created_at` serve `WHERE extract(year FROM created_at) = 2025`?

- [x] The index stores timestamps, not years; the planner can't map the function's output back to a range of index entries
- [ ] `extract` is not allowed in WHERE
- [ ] Because the result is an integer
- [ ] It can, Postgres rewrites it automatically

> Postgres does not reason about what a function does. Rewrite it as `created_at >= '2025-01-01' AND created_at < '2026-01-01'`.

### Which predicate is sargable?

- [ ] `WHERE total * 1.1 > 500`
- [ ] `WHERE lower(country) = 'vn'`
- [x] `WHERE total > 500 / 1.1`
- [ ] `WHERE created_at::date = current_date`

> The column stands alone; the arithmetic is on the constant side and evaluated once.

### You created `CREATE INDEX ON customers (lower(email))`. Which query uses it?

- [ ] `WHERE email = 'a@b.c'`
- [ ] `WHERE upper(email) = 'A@B.C'`
- [x] `WHERE lower(email) = 'a@b.c'`
- [ ] All of them

> An expression index matches only the identical expression. Different expression, different (nonexistent) index.
