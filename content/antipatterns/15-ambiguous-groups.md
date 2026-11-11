---
title: Ambiguous Groups
part: Queries
concept: Greatest row per group | Every selected column must have one value per group. To fetch the whole top row, use DISTINCT ON or a window function.
---

## Objective

Get the row with the greatest value in each group, along with its other columns: the most recent bug
per product *and its id*, the longest-running bug per priority *and who reported it*.

## The antipattern: referencing non-grouped columns

The first attempt is always this:

```sql
SELECT product_id, max(date_reported) AS latest, bug_id
FROM bugs JOIN bugs_products USING (bug_id)
GROUP BY product_id;
```

Each group has one `product_id` and one `max(date_reported)`, and hundreds of different `bug_id`s. Which
one should be shown? The query does not say. The author assumes the database will pick the `bug_id` from
the row that holds the maximum, and nothing in SQL promises that. With two aggregates (`max` and `min`)
it could not even be done.

This is the **Single-Value Rule**: every column in the select list must have exactly one value per group.
It is either in `GROUP BY`, inside an aggregate, or determined by the grouped columns.

Postgres enforces the rule and rejects the query:

```
ERROR: column "bugs.bug_id" must appear in the GROUP BY clause or be used in an aggregate function
```

Old MySQL configurations (and SQLite) run it and return an arbitrary `bug_id` per group. The result
looks plausible, which is worse than an error.

## Functional dependency

Postgres accepts a non-grouped column when it is **functionally dependent** on the grouping: if you
group by a table's primary key, every other column of that table has one value per group.

```sql
SELECT p.product_id, p.product_name, count(*)       -- product_name is fine: product_id is the PK
FROM products p JOIN bugs_products bp USING (product_id)
GROUP BY p.product_id;
```

## How to recognize it

- The error message above.
- On other databases: a report whose "latest" row shows a date from one row and an id from another.

## Legitimate uses

When the extra column really is the same for the whole group and you know why (the primary-key case
above), there is no ambiguity.

## Solution: say which row you mean

**DISTINCT ON** (Postgres) keeps the first row of each group in `ORDER BY` order. Short and fast:

```sql
SELECT DISTINCT ON (product_id) product_id, bug_id, date_reported
FROM bugs JOIN bugs_products USING (bug_id)
ORDER BY product_id, date_reported DESC, bug_id DESC;
```

**Window function**, portable and able to return the top *N* per group:

```sql
SELECT product_id, bug_id, date_reported
FROM (
  SELECT bp.product_id, b.bug_id, b.date_reported,
         row_number() OVER (PARTITION BY bp.product_id ORDER BY b.date_reported DESC, b.bug_id DESC) AS rn
  FROM bugs b JOIN bugs_products bp USING (bug_id)
) ranked
WHERE rn = 1;
```

Other options: a **correlated subquery** (`WHERE date_reported = (SELECT max(...) ...)`), an
**anti-join** (`LEFT JOIN` to a later row of the same group and keep rows where none exists), or
`LATERAL (… ORDER BY … LIMIT 1)`, which is the fastest form when an index matches. Always add a
tiebreaker to the ordering, or two rows that share the maximum make the result nondeterministic.

## Mini-antipattern: portable SQL

`DISTINCT ON` exists only in Postgres. Avoiding every vendor feature "in case we switch databases"
means writing slower, longer queries for a migration that rarely happens, and that would need testing
anyway. Use what your database offers, and keep the vendor-specific parts easy to find.

## Exercise: The latest bug of each product

For each product return `product_id, bug_id, date_reported` of its most recently reported bug. When
several bugs share that date, take the highest `bug_id`. The starter is the classic attempt: read the
error, then fix it.

```sql starter
SELECT product_id, max(date_reported) AS latest, bug_id
FROM bugs JOIN bugs_products USING (bug_id)
GROUP BY product_id;
```

```sql reference
SELECT DISTINCT ON (bp.product_id) bp.product_id, b.bug_id, b.date_reported
FROM bugs b JOIN bugs_products bp USING (bug_id)
ORDER BY bp.product_id, b.date_reported DESC, b.bug_id DESC
```

```sql solution
SELECT DISTINCT ON (bp.product_id) bp.product_id, b.bug_id, b.date_reported
FROM bugs b JOIN bugs_products bp USING (bug_id)
ORDER BY bp.product_id, b.date_reported DESC, b.bug_id DESC;
```

> Hint: `bug_id` has many values per product. Postgres wants to know which one.

> Hint: `SELECT DISTINCT ON (product_id) … ORDER BY product_id, date_reported DESC, bug_id DESC` keeps the first row per product.

> Hint: Mind the column order: product_id, bug_id, date_reported.

## Exercise: Top two per priority

For each priority (skip bugs without a priority), return the **two** bugs with the most `hours` as
`priority, bug_id, hours`. Ignore bugs with no hours. Break ties by the lower `bug_id`.
`DISTINCT ON` can only keep one row per group, so this needs a window function.

```sql starter
SELECT priority, max(hours) AS most_hours
FROM bugs
WHERE priority IS NOT NULL
GROUP BY priority;
```

```sql reference
SELECT priority, bug_id, hours
FROM (
  SELECT priority, bug_id, hours,
         row_number() OVER (PARTITION BY priority ORDER BY hours DESC, bug_id) AS rn
  FROM bugs
  WHERE priority IS NOT NULL AND hours IS NOT NULL
) ranked
WHERE rn <= 2
```

```sql solution
SELECT priority, bug_id, hours
FROM (
  SELECT priority, bug_id, hours,
         row_number() OVER (PARTITION BY priority ORDER BY hours DESC, bug_id) AS rn
  FROM bugs
  WHERE priority IS NOT NULL AND hours IS NOT NULL
) ranked
WHERE rn <= 2
ORDER BY priority, hours DESC;
```

> Hint: Number the rows inside each priority: `row_number() OVER (PARTITION BY priority ORDER BY hours DESC, bug_id)`.

> Hint: A window function can't be used in WHERE. Compute it in a subquery and filter `rn <= 2` outside.

## Quiz

### Why does Postgres reject `SELECT product_id, max(date_reported), bug_id … GROUP BY product_id`?

- [ ] `max` cannot be combined with other columns
- [x] `bug_id` has many values per group and the query doesn't say which one to return
- [ ] `bug_id` is a primary key
- [ ] GROUP BY needs an ORDER BY

> The Single-Value Rule: one value per group for every selected column.

### `SELECT p.product_id, p.product_name, count(*) FROM products p JOIN … GROUP BY p.product_id` is accepted. Why?

- [ ] Postgres ignores the rule for text columns
- [x] `product_id` is the primary key, so `product_name` is functionally dependent on it
- [ ] Because of the join
- [ ] It isn't accepted

> Grouping by a primary key fixes every other column of that table.

### You need the 3 most recent comments per bug. Which tool fits?

- [ ] `DISTINCT ON (bug_id)`
- [ ] `GROUP BY bug_id` with `max(comment_date)`
- [x] `row_number() OVER (PARTITION BY bug_id ORDER BY comment_date DESC)` filtered to `<= 3`
- [ ] `LIMIT 3`

> DISTINCT ON keeps one row per group. Ranking with a window function keeps as many as you ask for.
