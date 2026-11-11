---
title: Spaghetti Query
part: Queries
concept: One question per query | Joining two unrelated one-to-many tables multiplies their rows. Aggregate each separately, then combine.
---

## Objective

Get the answer with fewer queries. One round trip feels more elegant and faster than several, so the
natural goal becomes: do it all in one statement.

## The antipattern: solve a complex problem in one step

A manager wants, per product, the number of fixed bugs and the number of open bugs. One query, two joins:

```sql
SELECT p.product_id, count(f.bug_id) AS fixed, count(o.bug_id) AS open
FROM products p
LEFT JOIN (bugs_products bpf JOIN bugs f USING (bug_id))
       ON bpf.product_id = p.product_id AND f.status = 'FIXED'
LEFT JOIN (bugs_products bpo JOIN bugs o USING (bug_id))
       ON bpo.product_id = p.product_id AND o.status = 'NEW'
GROUP BY p.product_id;
```

Product 1 has 188 fixed and 192 new bugs. The query reports 36,096 for both. The fixed bugs and the open
bugs of a product have no relationship to each other, so joining both to the product pairs **every fixed
bug with every open bug**: 188 × 192 rows, and `count` counts them all. This is a Cartesian product
hiding inside a query that looks properly joined.

The numbers are wrong without any error. On small test data (one fixed, one open) the result is even
correct, so the bug ships. And as the tables grow, the row explosion makes the query slow as well.

Beyond wrong results, a single huge statement is hard to write, hard to change and hard to debug: there
is no intermediate result to look at.

## How to recognize it

- "Why are my sums and counts impossibly large?"
- "I've been working on this monster query all day."
- "Just add another `DISTINCT`" to make the duplicates go away.
- A query with many joins that slows down far faster than the data grows.

## Legitimate uses

A reporting tool or framework that accepts exactly one query forces your hand. Sorting a combined result
is also easier in one statement than merging in application code. Combine carefully, and check the row
counts at each step.

## Solution: divide and conquer

**One query per question.** Two simple queries are correct, readable, and usually faster than one
tangled one:

```sql
SELECT product_id, count(*) AS fixed FROM bugs_products JOIN bugs USING (bug_id)
WHERE status = 'FIXED' GROUP BY product_id;
```

**One pass with filtered aggregates**, when both numbers come from the same rows:

```sql
SELECT bp.product_id,
       count(*) FILTER (WHERE b.status = 'FIXED') AS fixed,
       count(*) FILTER (WHERE b.status = 'NEW')   AS open
FROM bugs_products bp JOIN bugs b USING (bug_id)
GROUP BY bp.product_id;
```

**Aggregate first, join second.** Reduce each one-to-many table to one row per key in a subquery or CTE,
then join the already-aggregated results. One row meets one row, and nothing multiplies.

```sql
WITH c AS (SELECT bug_id, count(*) AS comments FROM comments GROUP BY bug_id),
     t AS (SELECT bug_id, count(*) AS tags     FROM tags     GROUP BY bug_id)
SELECT b.bug_id, COALESCE(c.comments, 0), COALESCE(t.tags, 0)
FROM bugs b LEFT JOIN c USING (bug_id) LEFT JOIN t USING (bug_id);
```

`count(DISTINCT …)` can hide the duplication for counts, and it cannot rescue a `sum`. Check a join by
counting rows before and after: if a join to a "details" table changes the row count of the other
details, you have a product.

## Exercise: Fixed and open bugs per product

Return `product_id, fixed, open` for every product: the number of its bugs with status `FIXED` and with
status `NEW`. The starter is the query from the theory. Product 1 should show 188 and 192.

```sql starter
SELECT p.product_id, count(f.bug_id) AS fixed, count(o.bug_id) AS open
FROM products p
LEFT JOIN (bugs_products bpf JOIN bugs f USING (bug_id))
       ON bpf.product_id = p.product_id AND f.status = 'FIXED'
LEFT JOIN (bugs_products bpo JOIN bugs o USING (bug_id))
       ON bpo.product_id = p.product_id AND o.status = 'NEW'
GROUP BY p.product_id;
```

```sql reference
SELECT bp.product_id,
       count(*) FILTER (WHERE b.status = 'FIXED') AS fixed,
       count(*) FILTER (WHERE b.status = 'NEW') AS open
FROM bugs_products bp JOIN bugs b USING (bug_id)
GROUP BY bp.product_id
```

```sql solution
SELECT bp.product_id,
       count(*) FILTER (WHERE b.status = 'FIXED') AS fixed,
       count(*) FILTER (WHERE b.status = 'NEW') AS open
FROM bugs_products bp JOIN bugs b USING (bug_id)
GROUP BY bp.product_id
ORDER BY bp.product_id;
```

> Hint: Run the starter: 36,096 is 188 × 192. Each fixed bug is paired with each open bug.

> Hint: Both numbers come from the same rows. Join once and use `count(*) FILTER (WHERE status = …)`.

## Exercise: Comments and tags per bug

For bugs 1 to 30, return `bug_id, comments, tags`: how many comments and how many tags each bug has.
Bugs with none must show 0. Comments and tags are unrelated to each other, so joining both multiplies them.

```sql starter
SELECT b.bug_id, count(c.comment_id) AS comments, count(t.tag) AS tags
FROM bugs b
LEFT JOIN comments c ON c.bug_id = b.bug_id
LEFT JOIN tags t ON t.bug_id = b.bug_id
WHERE b.bug_id <= 30
GROUP BY b.bug_id;
```

```sql reference
SELECT b.bug_id,
       (SELECT count(*) FROM comments c WHERE c.bug_id = b.bug_id) AS comments,
       (SELECT count(*) FROM tags t WHERE t.bug_id = b.bug_id) AS tags
FROM bugs b
WHERE b.bug_id <= 30
```

```sql solution
WITH c AS (SELECT bug_id, count(*) AS comments FROM comments GROUP BY bug_id),
     t AS (SELECT bug_id, count(*) AS tags FROM tags GROUP BY bug_id)
SELECT b.bug_id, COALESCE(c.comments, 0) AS comments, COALESCE(t.tags, 0) AS tags
FROM bugs b
LEFT JOIN c USING (bug_id)
LEFT JOIN t USING (bug_id)
WHERE b.bug_id <= 30
ORDER BY b.bug_id;
```

> Hint: A bug with 4 comments and 2 tags produces 8 joined rows, so the starter reports 8 and 8.

> Hint: Aggregate each table to one row per bug first (two CTEs or two scalar subqueries), then join.

> Hint: `count(DISTINCT c.comment_id), count(DISTINCT t.tag)` also passes here. It would not work for a sum.

## Quiz

### A product has 10 fixed and 20 open bugs. The spaghetti query reports

- [ ] 10 and 20
- [ ] 30 and 30
- [x] 200 and 200
- [ ] 0 and 0

> Each of the 10 fixed bugs is paired with each of the 20 open ones: 200 rows, counted twice.

### Why does the bug often pass testing?

- [ ] Test databases have no NULLs
- [x] With zero or one row on each side, the product has the same size as the correct answer
- [ ] Test databases skip joins
- [ ] count() behaves differently on small tables

> 1 × 1 = 1. The multiplication only shows once both sides have more than one row.

### Which fix is safe for sums as well as counts?

- [ ] Adding DISTINCT inside the aggregate
- [ ] Adding more join conditions between the two detail tables
- [x] Aggregating each detail table to one row per key before joining
- [ ] Using RIGHT JOIN instead of LEFT JOIN

> Once each side has one row per key, the join cannot multiply anything.
