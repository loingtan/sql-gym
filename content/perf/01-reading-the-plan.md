---
title: Reading the plan
part: Foundations
concept: EXPLAIN ANALYZE | The plan is a tree; read it bottom-up and look only at the node where the time goes.
---

## Why the plan is the only window

SQL is declarative: you say *what*, Postgres decides *how*. The one place it shows you the *how*
is the execution plan. Every optimization on this track starts there, so this round is about reading it.

- `EXPLAIN query` shows the plan the planner *intends* to use, with its cost estimates. It does not run the query.
- `EXPLAIN ANALYZE query` runs the query and adds what *actually* happened: real time, real row counts.
- `EXPLAIN (ANALYZE, BUFFERS)` also shows how many 8 kB pages were touched, and whether they came from
  cache (`hit`) or disk (`read`).

Prefer `ANALYZE` while learning. Never use it on a `DELETE`/`UPDATE` you don't want executed, and never
on a query that doesn't finish in production.

## The anatomy of a node

```
Seq Scan on orders  (cost=0.00..21725.00 rows=97400 width=8) (actual time=0.010..27.515 rows=100205 loops=1)
  Filter: (status = 'cancelled'::text)
  Rows Removed by Filter: 899795
```

| Piece | Meaning |
|---|---|
| `Seq Scan on orders` | the operation: read every row of `orders` |
| `cost=0.00..21725.00` | planner's *estimate*, in arbitrary units: cost to return the first row .. all rows |
| `rows=97400` (first group) | *estimated* rows this node produces |
| `width=8` | estimated average row size in bytes |
| `actual time=0.010..27.515` | milliseconds to the first row .. the last row, per loop |
| `rows=100205` (second group) | *actual* rows produced, per loop |
| `loops=1` | how many times this node ran. Multiply time and rows by it. |
| `Rows Removed by Filter` | work that was done and thrown away |

A plan is an **inverted tree**: indented nodes run first and feed the node above them. Times are
cumulative, so a parent's time includes its children. The app shows a bar next to each node with the
share of time spent in *that node itself*, so the hot spot is visible at a glance.

## The three questions

1. **Where does the time go?** Find the node with the biggest self-time. Ignore the rest.
2. **Is the estimate close to the actual?** When `rows=` estimated and actual differ by 10× or more, the
   planner was working from bad information (stale statistics, correlated columns) and may have chosen
   the wrong join or scan. `ANALYZE table` refreshes statistics.
3. **How much was thrown away?** A big `Rows Removed by Filter` next to a `Seq Scan` is the classic
   sign of a missing index.

## Node types you will meet

- **Seq Scan**: reads the whole table. Right for small tables or when you need most rows; wrong when you need a few.
- **Index Scan**: walks the index to find matching entries, then fetches each row from the table.
- **Index Only Scan**: answers from the index alone, no table visits (needs a recently VACUUMed table).
- **Bitmap Index Scan + Bitmap Heap Scan**: collects matching pages from one or more indexes first, then reads them in physical order. Good for medium selectivity.
- **Nested Loop**: for each outer row, probe the inner side. Great with an index on the inner side and few outer rows.
- **Hash Join**: builds a hash table of the smaller side, probes with the bigger. Great for large unsorted inputs.
- **Merge Join**: both sides sorted, zipped together.
- **Sort**, **HashAggregate / GroupAggregate**, **Limit**, **Gather** (parallel workers).

## Exercise: Find the hot node

The query below counts cancelled orders per customer and returns the top 10. It is a free pass:
run it as-is, open **Your plan**, and answer the quiz afterwards. The check only asks for the right rows.

```sql baseline
SELECT customer_id, count(*) AS cancelled
FROM orders
WHERE status = 'cancelled'
GROUP BY customer_id
ORDER BY cancelled DESC, customer_id
LIMIT 10
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
```

> Hint: Just run it. Then look at which node has the long bar, and how many rows the filter removed.

## Quiz

### In `(actual time=0.010..27.515 rows=100205 loops=1)`, what is 27.515?

- [ ] The estimated cost in milliseconds
- [x] Milliseconds until this node produced its last row, including its children
- [ ] Milliseconds spent in this node alone
- [ ] The number of rows per millisecond

> Actual times are cumulative: a node can't finish before the nodes feeding it. Subtract the children to get the node's own time.

### A node shows `rows=4` estimated but `rows=40000` actual. What does that tell you?

- [x] The planner's statistics are off, so it may have picked a bad join strategy
- [ ] The query returned too many rows and should use LIMIT
- [ ] The index is corrupt
- [ ] Nothing, estimates are always approximate

> A 10,000× misestimate means the planner reasoned about a different world. A Nested Loop chosen for 4 rows is a disaster at 40,000.

### `Rows Removed by Filter: 899795` on a Seq Scan means

- [ ] The table has 899,795 rows
- [x] Postgres read 899,795 rows it didn't need; an index on the filter column could skip them
- [ ] The query has a bug
- [ ] The rows were deleted

> Scanning rows just to discard them is the single most common performance problem, and the easiest one to fix.
