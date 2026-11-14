---
title: "Mystery: top spenders"
part: Mysteries
concept: Diagnose before you fix | Run it, find the node that eats the time, ask why that node exists, change one thing, measure again.
---

## Mystery rounds

The rounds so far named the technique in the title. Real work doesn't. A mystery round gives you a slow
query and a target, and nothing else. Use the method from round 1:

1. **Run it** and open the plan.
2. **Find the hot node**: the longest bar.
3. **Ask why that node is there.** A Seq Scan that discards most rows wants an index. A Sort wants an
   index in that order. A node with `loops=20` runs twenty times. A function around a column hides it
   from an index.
4. **Change one thing** in Setup or in the query.
5. **Run again** and compare with the baseline plan. Repeat until the goal is met.

Sometimes the fix is in the query, sometimes in an index, often in both. The hints are there if you get
stuck, each one more specific than the last. Try without them first.

## Exercise: Top spenders on Black Friday

The marketing page shows the ten customers who spent the most on Black Friday, 28 November 2025.
It takes too long. Return the same rows at least 20× faster.

```sql baseline
SELECT customer_id, sum(total) AS spent
FROM orders
WHERE date_trunc('day', created_at) = '2025-11-28'
GROUP BY customer_id
ORDER BY spent DESC, customer_id
LIMIT 10
```

```sql solution-setup
CREATE INDEX ON orders (created_at, customer_id, total);
```

```sql solution
SELECT customer_id, sum(total) AS spent
FROM orders
WHERE created_at >= '2025-11-28' AND created_at < '2025-11-29'
GROUP BY customer_id
ORDER BY spent DESC, customer_id
LIMIT 10;
```

```meta
ordered: true
speedup: 20
```

> Hint: The hot node is a Seq Scan that throws away more than 99.9% of the rows it reads. Which condition does the throwing away?

> Hint: An index on `created_at` alone will not be used while the column sits inside `date_trunc(…)`. Round 4.

> Hint: Rewrite the filter as a range (`created_at >= '2025-11-28' AND created_at < '2025-11-29'`) and index `created_at`. Adding `customer_id` and `total` to the index lets Postgres skip the table entirely.

## Quiz

### What is the first thing to do with a slow query?

- [ ] Add an index on every column in the WHERE clause
- [x] Run it with EXPLAIN ANALYZE and find where the time goes
- [ ] Rewrite it with a CTE
- [ ] Increase work_mem

> Measure first. The plan tells you which of the many possible fixes is the relevant one.

### You added an index and the plan still shows a Seq Scan with the same filter. What should you check first?

- [ ] Whether the server needs a restart
- [x] Whether the query wraps the indexed column in a function or cast
- [ ] Whether the table has a primary key
- [ ] Whether the index is too new

> The planner can only match an index to the bare column, or to the exact expression that was indexed.
