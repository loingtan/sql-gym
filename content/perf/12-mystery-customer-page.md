---
title: "Mystery: the customer page"
part: Mysteries
concept: Loops multiply | A cheap-looking subquery that runs once per row is the whole cost. Read loops= before anything else.
---

## One page, two problems

A slow query often has more than one cause. Fixing the first makes the second visible, and the plan
changes shape between attempts. That is normal. Fix the hottest node, run again, and look at the new
plan with fresh eyes instead of assuming the job is done.

Pay attention to `loops=` in this round. A node's time and row count are **per loop**. A node that takes
90 ms with `loops=20` costs 1.8 seconds.

## Exercise: A customer's latest orders

The account page lists a customer's 20 most recent orders, each with its number of items. For customer
777 it takes far too long. Return the same rows, in the same order, at least 50× faster.

```sql baseline
SELECT o.id, o.created_at, o.total,
       (SELECT count(*) FROM order_items i WHERE i.order_id = o.id) AS items
FROM orders o
WHERE o.customer_id = 777
ORDER BY o.created_at DESC, o.id DESC
LIMIT 20
```

```sql solution-setup
CREATE INDEX ON orders (customer_id, created_at, id);
CREATE INDEX ON order_items (order_id);
```

```sql solution
SELECT o.id, o.created_at, o.total,
       (SELECT count(*) FROM order_items i WHERE i.order_id = o.id) AS items
FROM orders o
WHERE o.customer_id = 777
ORDER BY o.created_at DESC, o.id DESC
LIMIT 20;
```

```meta
ordered: true
speedup: 50
```

> Hint: Find the node with `loops=20`. What does it scan each time, and how many rows does it throw away per loop?

> Hint: The subquery looks up items by `order_id`, a foreign key with no index. That is the big one.

> Hint: Then the outer part: finding one customer's orders and sorting them. One index on `(customer_id, created_at, id)` does both.

## Quiz

### A plan node shows `actual time=0.01..85.0 rows=3 loops=20`. Roughly how much time does it account for?

- [ ] 85 ms
- [ ] 4 ms
- [x] 1,700 ms
- [ ] 20 ms

> Times are per loop: 85 ms × 20.

### Why can a correlated subquery in the SELECT list be expensive?

- [ ] It always scans the whole outer table
- [x] It runs once for every row the outer query returns
- [ ] It cannot use indexes
- [ ] It disables parallel query

> With an index each run is a quick probe. Without one, each run is a full scan.
