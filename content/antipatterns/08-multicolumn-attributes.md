---
title: Multicolumn Attributes
part: Logical Database Design
concept: Dependent table | Values with the same meaning go in one column over many rows, not in tag1, tag2, tag3.
---

## Objective

Store a **multivalue attribute** again, this time one-to-many: a bug can carry several tags (`crash`,
`printing`, `performance`). The tags aren't mutually exclusive, so a single `tag` column isn't enough.

## The antipattern: create multiple columns

After Jaywalking (chapter 2), you know better than to pack values into one string, so you put one value per
column instead:

```sql
CREATE TABLE multi_bugs (
  bug_id  bigint PRIMARY KEY,
  summary varchar(80) NOT NULL,
  tag1    varchar(20),
  tag2    varchar(20),
  tag3    varchar(20)
);
```

Unused slots are `NULL`. Everything you'd do with one column now has to be done three times:

- **Searching** has to check every column, and `OR` binds looser than `AND`, so a missing pair of parentheses
  silently changes the result:

```sql
SELECT * FROM multi_bugs
WHERE 'performance' IN (tag1, tag2, tag3)
  AND 'printing'    IN (tag1, tag2, tag3);
```

- **Adding a tag** means finding a free slot. Either read the row first and write it back (a race with
  other sessions), or write a `CASE`/`COALESCE` expression that repeats the tag six times. If all slots are
  full, the update quietly does nothing.
- **Removing a tag** needs `tag1 = NULLIF(tag1, 'x'), tag2 = NULLIF(tag2, 'x'), ...` and leaves gaps.
- **Uniqueness** isn't enforced. `('printing', 'performance', 'performance')` is accepted.
- **Aggregating** ("bugs per tag") means unpivoting the columns first. In Postgres the neatest way is
  `CROSS JOIN LATERAL (VALUES (tag1), (tag2), (tag3)) AS t(tag)`.
- **Growing the set** needs `ALTER TABLE ... ADD COLUMN tag4`, and then every query that lists the tag
  columns has to be found and edited. The ones you miss give wrong answers without any error.

## How to recognize it

- A UI or spec that allows "up to N" values for no real reason.
- "What's the maximum number of tags we'll ever need?"
- "How do I search for one value across several columns?"

This antipattern and Jaywalking solve the same problem in two wrong ways: one crams the values into a
single field, the other spreads them across numbered columns.

## Legitimate uses

Separate columns are right when each one has a **different meaning**, even if the type is the same.
`reported_by`, `assigned_to` and `verified_by` all reference `accounts`, but each has its own role and is
usually queried on its own. The occasional "everyone involved in this bug" query is a fair price.

## Solution: create a dependent table

Store one value per row in a child table with a foreign key to the parent:

```sql
CREATE TABLE multi_tags (
  bug_id bigint NOT NULL REFERENCES multi_bugs(bug_id),
  tag    varchar(20) NOT NULL,
  PRIMARY KEY (bug_id, tag)
);

-- bugs with both tags: one join per required tag, or GROUP BY ... HAVING
SELECT bug_id FROM multi_tags
WHERE tag IN ('performance', 'printing')
GROUP BY bug_id HAVING count(*) = 2;
```

Search is `WHERE tag = ...`. Adding and removing are one `INSERT` or `DELETE`. The primary key rejects
duplicates, and there's no limit on the number of tags. Bugs per tag is a plain `GROUP BY tag`.

## Mini-antipattern: storing prices

Normalization says to store each fact once, so `orders.price` might look redundant next to
`merchandise.price`. It isn't. The order row records **what this customer paid on that day, after
discounts**. The merchandise row is **today's list price**. They are two different facts, and computing
past revenue from today's price is the actual bug.

The same applies to many intersection tables. A team roster per season and an actor's credited name per
film both describe the relationship *at that moment*, so the value belongs in the association row.

## Exercise: Bugs per tag

Using `multi_bugs` (tags in `tag1`, `tag2`, `tag3`), return `tag, bugs`: the number of **distinct** bugs
carrying each tag. Ignore empty slots. Note that bug 8 has `performance` twice.

```sql starter
SELECT tag1 AS tag, count(*) AS bugs
FROM multi_bugs
GROUP BY tag1;
```

```sql reference
SELECT tag, count(DISTINCT bug_id) AS bugs
FROM (SELECT bug_id, tag1 AS tag FROM multi_bugs
      UNION ALL SELECT bug_id, tag2 FROM multi_bugs
      UNION ALL SELECT bug_id, tag3 FROM multi_bugs) t
WHERE tag IS NOT NULL
GROUP BY tag
```

```sql solution
SELECT t.tag, count(DISTINCT b.bug_id) AS bugs
FROM multi_bugs b
CROSS JOIN LATERAL (VALUES (b.tag1), (b.tag2), (b.tag3)) AS t(tag)
WHERE t.tag IS NOT NULL
GROUP BY t.tag;
```

> Hint: First turn the three columns into rows ("unpivot"): `UNION ALL` of three selects, or `CROSS JOIN LATERAL (VALUES (tag1), (tag2), (tag3)) AS t(tag)`.

> Hint: Drop the `NULL` slots with `WHERE tag IS NOT NULL`, and use `count(DISTINCT bug_id)` so bug 8 counts once for `performance`.

## Exercise: Move tags into a dependent table

The starter looks for bugs tagged both `performance` and `printing`, but the parentheses are wrong.
Fix the design instead: create `multi_tags (bug_id, tag)` with a foreign key to `multi_bugs` and a primary
key on both columns, and migrate every non-empty tag into it. Then, **using `multi_tags`**, return
`bug_id, summary` of the bugs tagged both `performance` and `printing`.

```sql starter-setup
CREATE TABLE multi_tags (
  -- bug_id ... REFERENCES multi_bugs(bug_id)
  -- tag    ...
  -- PRIMARY KEY (...)
);

-- INSERT INTO multi_tags SELECT ... FROM multi_bugs CROSS JOIN LATERAL (VALUES ...) ...
```

```sql starter
SELECT bug_id, summary
FROM multi_bugs
WHERE tag1 = 'performance' OR tag2 = 'performance' OR tag3 = 'performance'
  AND (tag1 = 'printing' OR tag2 = 'printing' OR tag3 = 'printing');
```

```sql reference
SELECT bug_id, summary
FROM multi_bugs
WHERE 'performance' IN (tag1, tag2, tag3)
  AND 'printing' IN (tag1, tag2, tag3)
```

```sql solution-setup
CREATE TABLE multi_tags (
  bug_id bigint NOT NULL REFERENCES multi_bugs(bug_id),
  tag    varchar(20) NOT NULL,
  PRIMARY KEY (bug_id, tag)
);

INSERT INTO multi_tags (bug_id, tag)
SELECT DISTINCT b.bug_id, t.tag
FROM multi_bugs b
CROSS JOIN LATERAL (VALUES (b.tag1), (b.tag2), (b.tag3)) AS t(tag)
WHERE t.tag IS NOT NULL;
```

```sql solution
SELECT b.bug_id, b.summary
FROM multi_bugs b
JOIN multi_tags t1 ON t1.bug_id = b.bug_id AND t1.tag = 'performance'
JOIN multi_tags t2 ON t2.bug_id = b.bug_id AND t2.tag = 'printing';
```

```meta
require: (join|from)\s+multi_tags | Answer the question from the new multi_tags table
```

> Hint: Without `DISTINCT` in the migration, bug 8's two `performance` tags hit the primary key. That's the constraint doing the job the three columns never did.

> Hint: Join `multi_tags` twice (once per required tag), or filter `tag IN (...)` and keep the bugs with `HAVING count(*) = 2`.

## Exercise: Revenue from the price paid

`multi_merchandise.price` is **today's** unit price. `multi_orders.price` is what the customer actually
paid for that order line, after any discount. Return `merch_id, name, revenue`, the total actually
earned per item, for every item that has orders.

```sql starter
SELECT m.merch_id, m.name, sum(o.quantity * m.price) AS revenue
FROM multi_merchandise m
JOIN multi_orders o USING (merch_id)
GROUP BY m.merch_id;
```

```sql reference
SELECT m.merch_id, m.name, sum(o.price) AS revenue
FROM multi_merchandise m
JOIN multi_orders o ON o.merch_id = m.merch_id
GROUP BY m.merch_id, m.name
```

```sql solution
SELECT m.merch_id, m.name, sum(o.price) AS revenue
FROM multi_merchandise m
JOIN multi_orders o USING (merch_id)
GROUP BY m.merch_id;
```

> Hint: Today's price × quantity says what the orders *would* cost now. The order row already stores what was paid.

> Hint: `multi_orders.price` is the whole line's price, so don't multiply it by `quantity` again.

## Quiz

### What does `WHERE a = 1 OR b = 1 AND c = 2` mean in SQL?

- [ ] `(a = 1 OR b = 1) AND c = 2`
- [x] `a = 1 OR (b = 1 AND c = 2)`
- [ ] It is a syntax error without parentheses
- [ ] It depends on the column order in the table

> `AND` binds tighter than `OR`. Multicolumn searches are full of `OR`s, so this is an easy way to get wrong rows without any error.

### Which problem does the dependent table `multi_tags (bug_id, tag, PRIMARY KEY (bug_id, tag))` solve?

- [ ] Tags can now be longer than 20 characters
- [x] The same tag can't be applied to a bug twice, and there's no maximum number of tags
- [ ] Bugs without tags are no longer stored
- [ ] Searching for a tag no longer needs an index

> The primary key rejects duplicates, and each extra tag is another row, so nothing caps the count.

### When are several similar columns (`reported_by`, `assigned_to`, `verified_by`) a sound design?

- [ ] Never. They should always be a dependent table
- [ ] When there are at most three of them
- [x] When each column has a distinct role and is usually queried on its own
- [ ] When they all reference the same table

> They share a type, but they are different attributes, so they aren't a repeating group.

### Is `orders.price` redundant when `merchandise.price` exists?

- [ ] Yes. It breaks normalization and should be dropped
- [x] No. It records what was paid at that time, which is a different fact from today's list price
- [ ] Yes, unless it's stored as `float`
- [ ] No, but only if the two values are always equal

> Prices change, and discounts apply. The order row stores the historical fact about that sale.
