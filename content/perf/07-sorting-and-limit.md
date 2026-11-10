---
title: Sorting, LIMIT and pagination
part: Queries
concept: Keyset pagination | An index in ORDER BY order turns "sort a million rows, keep 20" into "read 20". Paginate by last-seen key, not by OFFSET.
---

## A sort you never see

`ORDER BY created_at DESC LIMIT 20` on a million rows means: read everything, sort it (or keep a top-20
heap), return 20. The plan shows `Sort` with `Sort Method: top-N heapsort` under the `Limit`.

A B-tree is already sorted. With an index on `created_at`, the same query becomes
`Index Scan Backward` reading exactly 20 entries. No sort node at all. This is the biggest cheap win on
any "latest N" query: feeds, logs, inboxes.

For `ORDER BY a, b` the index must be on `(a, b)` in that order. Mixed directions (`a ASC, b DESC`) need
the index declared with matching directions: `(a, b DESC)`.

## OFFSET is a lie

`LIMIT 20 OFFSET 100000` for page 5,001 still reads and discards 100,000 rows. Each page gets slower than
the last, and rows inserted between requests shift pages so items are skipped or repeated.

**Keyset pagination** remembers the last row seen and asks for what comes after it:

```sql
SELECT * FROM orders
WHERE (created_at, id) < ('2025-06-15 10:00+00', 812345)   -- last row of the previous page
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

With an index on `(created_at, id)` every page costs the same: seek, read 20. The tuple comparison
`(a, b) < (x, y)` is row-wise and index-friendly. Include a unique tiebreaker (`id`) so equal timestamps
don't lose rows between pages.

## Exercise: The latest 20 orders

Return the 20 most recent orders at least 10× faster, with no `Sort` node in the plan.

```sql baseline
SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT 20
```

```sql solution-setup
CREATE INDEX ON orders (created_at, id);
```

```sql solution
SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT 20;
```

```meta
ordered: true
speedup: 10
forbid: Sort
forbid: Seq Scan on orders
```

> Hint: The ORDER BY is on two columns. The index needs both, in that order.

> Hint: `CREATE INDEX ON orders (created_at, id);` Postgres can walk it backward for DESC.

## Exercise: Deep page, keyset style

The baseline fetches "page 2,001" of the newest-first order list with OFFSET 40000. The last row of page 2,000 was
`created_at = '2025-11-02 15:24:10.465034+00', id = 960025`. Return the same 20 rows using keyset
pagination (no `OFFSET`), 10× faster, with the composite index.

```sql starter-setup
CREATE INDEX ON orders (created_at, id);
```

```sql baseline
SELECT id, customer_id, created_at, total
FROM orders
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET 40000
```

```sql starter
SELECT id, customer_id, created_at, total
FROM orders
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET 40000;
```

```sql solution-setup
CREATE INDEX ON orders (created_at, id);
```

```sql solution
SELECT id, customer_id, created_at, total
FROM orders
WHERE (created_at, id) < ('2025-11-02 15:24:10.465034+00', 960025)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

```meta
ordered: true
speedup: 10
forbid: Seq Scan on orders
require: ^(?![\s\S]*\boffset\b) | No OFFSET
```

> Hint: Replace OFFSET with a WHERE on the last-seen key: `WHERE (created_at, id) < (…, …)`.

> Hint: Row comparison `(created_at, id) < ('2025-11-02 15:24:10.465034+00', 960025)` with the same ORDER BY.

## Quiz

### `ORDER BY created_at DESC LIMIT 20` with an index on `created_at`. What does the plan look like?

- [ ] Seq Scan → Sort → Limit
- [x] Index Scan Backward → Limit, reading 20 index entries
- [ ] Hash Aggregate
- [ ] Bitmap Heap Scan over the whole table

> The index is already in order. Walking it backward yields the newest rows first, and LIMIT stops after 20.

### Why does `OFFSET 100000` get slower as the number grows?

- [x] Postgres still has to produce and discard the first 100,000 rows
- [ ] Integers above 65,536 are slow
- [ ] OFFSET disables indexes
- [ ] It doesn't; OFFSET is O(1)

> There is no way to jump to "row 100,001" in a B-tree without counting past the first 100,000.

### Why include `id` in the keyset condition `(created_at, id) < (…)`?

- [ ] To make the SQL valid
- [x] Several orders can share a timestamp; a unique tiebreaker guarantees no row is skipped or repeated across pages
- [ ] Because `id` is the primary key and must always be selected
- [ ] To speed up the sort

> Pagination keys must be unique as a whole, or the boundary between pages is ambiguous.
