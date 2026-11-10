---
title: Joins and their indexes
part: Queries
concept: Join strategies | Nested Loop needs an index on the inner side; Hash Join needs memory; the planner picks by row estimates, so give it good ones.
---

## Three ways to join

Postgres has exactly three join algorithms, and reading which one it chose tells you most of the story.

**Nested Loop**: for every row from the outer side, look up matches on the inner side. Cost is
outer rows × cost of one inner lookup. Wonderful when the outer side is small and the inner lookup is an
index probe. Catastrophic when the inner side is a Seq Scan: that is a full table read *per outer row*
(`loops=50000` in the plan is the tell).

**Hash Join**: read the smaller side once into an in-memory hash table keyed on the join column, then
stream the larger side through it. Cost is roughly linear in both sizes. Needs `work_mem`; if the hash
spills (`Batches: 4`), it gets slow.

**Merge Join**: sort both sides on the join key (or read them through an index in order), then zip.
Good when both inputs are already sorted.

The planner chooses by estimated row counts. If the estimate is wrong, the choice is wrong, which is
why the "estimate off ×N" flag in the plan matters so much.

## The index a join wants

For `orders JOIN customers ON orders.customer_id = customers.id` filtered to a few customers, the ideal
plan is: find the customers (small), then Nested Loop into `orders` through an index on
`orders.customer_id`. Without that index there is no fast inner lookup, and the planner must hash all
million orders instead.

Rule of thumb: **index the foreign key column on the many side** of every join you run often.

## Anti-joins and semi-joins

`NOT EXISTS (...)` is an anti-join, `EXISTS (...)` / `IN (subquery)` a semi-join. They use the same three
algorithms. Prefer `NOT EXISTS` to `NOT IN` on nullable columns: `NOT IN` with a NULL returns no rows at all.

## Exercise: Icelanders who never ordered

List customers from Iceland (`country = 'IS'`) who have no orders. The baseline hashes a million orders to
answer a question about 947 customers. Beat it 5× with no Seq Scan on `orders`.

```sql baseline
SELECT c.id, c.full_name
FROM customers c
WHERE c.country = 'IS'
  AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)
```

```sql solution-setup
CREATE INDEX ON orders (customer_id);
CREATE INDEX ON customers (country);
```

```sql solution
SELECT c.id, c.full_name
FROM customers c
WHERE c.country = 'IS'
  AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);
```

```meta
speedup: 5
forbid: Seq Scan on orders
```

> Hint: Look at the baseline plan: `Hash Anti Join` over a Seq Scan of `orders`. Give the inner side an index so a Nested Loop becomes possible.

> Hint: `CREATE INDEX ON orders (customer_id);` and, for the outer side, `CREATE INDEX ON customers (country);`.

## Exercise: Who bought product 19999

Return the orders (all columns) containing product 19999. The baseline scans all 2.5 million order items. 10× faster,
no Seq Scan on `order_items`.

```sql baseline
SELECT o.*
FROM orders o
WHERE o.id IN (SELECT order_id FROM order_items WHERE product_id = 19999)
```

```sql solution-setup
CREATE INDEX ON order_items (product_id);
```

```sql solution
SELECT o.*
FROM orders o
WHERE o.id IN (SELECT order_id FROM order_items WHERE product_id = 19999);
```

```meta
speedup: 10
forbid: Seq Scan on order_items
```

> Hint: `order_items.product_id` is a foreign key with no index. That's the inner lookup the join needs.

> Hint: After the index, the plan should be: Index Scan on order_items → Nested Loop → Index Scan using orders_pkey.

## Quiz

### A plan shows `Nested Loop` with an inner `Seq Scan on orders … loops=5000`. What's happening?

- [x] The orders table is read in full 5,000 times; an index on the join column would turn each into a probe
- [ ] Postgres is using 5,000 parallel workers
- [ ] The query returns 5,000 rows, which is fine
- [ ] Nothing wrong, Nested Loop is the fastest join

> `loops` multiplies everything. A Seq Scan inside a loop is the worst shape a plan can take.

### When is a Hash Join the right choice?

- [ ] Only when both sides are tiny
- [x] When both inputs are large and unsorted, and the smaller one fits in memory
- [ ] Never, Nested Loop is always better with an index
- [ ] Only for LEFT JOINs

> Hashing reads each side once. For two big inputs with no useful index, nothing beats it.

### `WHERE id NOT IN (SELECT customer_id FROM orders)` returns zero rows although orphans exist. Why?

- [ ] The subquery is too big
- [x] `customer_id` has a NULL somewhere; `x NOT IN (…, NULL)` is never true
- [ ] NOT IN only works with literals
- [ ] The index is missing

> Three-valued logic: comparing against NULL yields unknown, and unknown is not true. Use `NOT EXISTS`.
