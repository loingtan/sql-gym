---
title: "Mystery: weekly revenue"
part: Mysteries
concept: Start from the smallest set | A join is fast when it starts from the few rows the filter selects and reaches the rest through indexes.
---

## Joins start somewhere

The planner decides which table to read first and how to reach the others. With no useful indexes its
only option is to read everything and hash it together, however small the answer is. A good plan starts
from the **most selective** condition, gets a small set of rows, and follows indexes outward from there.

When you read a join plan, ask for each table: how many rows did it read, and how many of them ended up
in the result? A table that is read in full to contribute a few thousand rows is where to look.

## Exercise: Revenue by category for one week

The weekly report sums revenue per product category for orders placed in the first week of December
2025. It reads millions of rows to report on one week. Return the same rows, in the same order, at
least 4× faster.

```sql baseline
SELECT p.category, sum(i.quantity * i.unit_price) AS revenue
FROM order_items i
JOIN orders o ON o.id = i.order_id
JOIN products p ON p.id = i.product_id
WHERE o.created_at >= '2025-12-01' AND o.created_at < '2025-12-08'
GROUP BY p.category
ORDER BY revenue DESC, p.category
```

```sql solution-setup
CREATE INDEX ON orders (created_at);
CREATE INDEX ON order_items (order_id);
```

```sql solution
SELECT p.category, sum(i.quantity * i.unit_price) AS revenue
FROM order_items i
JOIN orders o ON o.id = i.order_id
JOIN products p ON p.id = i.product_id
WHERE o.created_at >= '2025-12-01' AND o.created_at < '2025-12-08'
GROUP BY p.category
ORDER BY revenue DESC, p.category;
```

```meta
ordered: true
speedup: 4
```

> Hint: Which table does the filter apply to, and how many of its rows match? Compare that with how many rows the plan reads from `order_items`.

> Hint: The week's orders are a few thousand rows. Give Postgres a fast way to find them: an index on `orders (created_at)`.

> Hint: Then a way to go from those orders to their items: an index on `order_items (order_id)`. The plan should become nested loops driven by the week's orders.

## Quiz

### A report on one week reads all 2.5 million order items. What is the most likely reason?

- [ ] The report needs every item
- [x] There is no index that leads from the week's orders to their items, so the planner hashes the whole table
- [ ] Joins always read whole tables
- [ ] The statistics are stale

> Without a path from the small set to the big table, reading everything is the only option.

### In a well-indexed join, which table should the plan usually start from?

- [ ] The largest table
- [ ] The table listed first in FROM
- [x] The table whose filter selects the fewest rows
- [ ] The table with the most columns

> Start small and follow indexes. The order in FROM does not decide this; the planner does.
