---
title: Polymorphic Associations
part: Logical Database Design
concept: Every FK names one table | If a column points at different tables row by row, reverse the reference or add a common parent table so a real foreign key can do the checking.
---

## Objective

Let one child table **reference several parent tables**. Comments started out belonging to bugs. Now
feature requests need comments too, and they live in their own table. You'd like a single `comments`
table for both, but a `FOREIGN KEY` names exactly one parent table, and SQL won't let a join switch
tables from row to row.

## The antipattern: a dual-purpose foreign key

Add a column that says *which* table the id belongs to, and drop the foreign key because it can't be declared:

```sql
CREATE TABLE poly_comments (
  comment_id bigint PRIMARY KEY,
  issue_type varchar(20) NOT NULL,  -- 'Bugs' or 'FeatureRequests'
  issue_id   bigint NOT NULL,       -- no REFERENCES: which table would it name?
  author     bigint NOT NULL REFERENCES accounts(account_id),
  comment    text NOT NULL
);
```

This is called a **polymorphic association**. `author` is still checked by a foreign key. `issue_id`
isn't checked at all:

- **Orphans get in.** Deleting a bug leaves its comments pointing at nothing. `('Bugs', 999)` inserts without complaint.
- **Typos get in.** `'Feature'`, `'bugs'` or `'Bugz'` are just strings. No catalog checks that the type names a real table.
- **Ids collide.** Bug 3 and feature request 3 both exist. A join that forgets the type condition
  attaches a feature's comments to the bug with the same number.
- **Every query needs one outer join per possible parent**, each with the type in the `ON` clause:

```sql
SELECT c.comment_id, coalesce(b.summary, f.summary) AS issue
FROM poly_comments c
LEFT JOIN poly_bugs b     ON c.issue_type = 'Bugs'            AND b.issue_id = c.issue_id
LEFT JOIN poly_features f ON c.issue_type = 'FeatureRequests' AND f.issue_id = c.issue_id;
```

Integrity now depends on every piece of application code getting this right every time.

## How to recognize it

- "This tagging/commenting table can attach to *any* object in the database."
- "We can't declare foreign keys in our design."
- "What's the `entity_type` column for? It tells you which table the other column points to."
- ORM declarations such as Rails' `belongs_to :commentable, polymorphic: true`.

Like EAV, this **stores metadata (a table name) as data**.

## Legitimate uses

Some ORMs generate this design and handle the integrity checks in their own code. If you are stuck with
that framework, you'll live with it. Run an orphan-finding query on a schedule, because the database
won't catch anything. Don't build it by hand in a new schema.

## Solution: simplify the relationship

**Reverse the reference.** The child can't point at many parents, but many tables can point at the
child. Create one intersection table per parent, each with real foreign keys:

```sql
CREATE TABLE bug_comments (
  issue_id   bigint NOT NULL REFERENCES poly_bugs(issue_id),
  comment_id bigint NOT NULL UNIQUE REFERENCES poly_comments(comment_id),
  PRIMARY KEY (issue_id, comment_id)
);
-- same for feature_comments → poly_features
```

`UNIQUE (comment_id)` stops a comment from belonging to two bugs. Nothing stops the same comment from
appearing in both `bug_comments` and `feature_comments`, though.

**Create a common super-table.** This is the type hierarchy the polymorphic design leaves out. `issues`
hands out the ids, `bugs` and `feature_requests` use the same id as both primary key and foreign key, and
`comments` references `issues`:

```sql
CREATE TABLE issues   (issue_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
CREATE TABLE bugs     (issue_id bigint PRIMARY KEY REFERENCES issues, summary text /* ... */);
CREATE TABLE features (issue_id bigint PRIMARY KEY REFERENCES issues, sponsor text /* ... */);
CREATE TABLE comments (comment_id bigint PRIMARY KEY,
                       issue_id   bigint NOT NULL REFERENCES issues);
```

Ids can no longer collide, and a plain `LEFT JOIN bugs USING (issue_id)` works.

**Exclusive arc (Postgres-friendly).** If there are only a few parents, give the child one nullable
foreign key per parent and require exactly one of them to be set:

```sql
bug_id     bigint REFERENCES poly_bugs,
feature_id bigint REFERENCES poly_features,
CHECK (num_nonnulls(bug_id, feature_id) = 1)
```

Postgres table inheritance (`INHERITS`) looks tempting, but it doesn't help: primary keys and foreign
keys don't span a parent and its children.

## Exercise: Find the orphans

`poly_comments` uses `issue_type` + `issue_id` to point at `poly_bugs` or `poly_features`. A comment is
attached only if `issue_type` is exactly `'Bugs'` or `'FeatureRequests'` **and** the matching parent row
exists. Return `comment_id, issue_type, issue_id` for every comment that is **not** attached.

The starter only catches ids that exist in neither table. Watch out for ids that exist in the *other*
table and for misspelled types.

```sql starter
SELECT comment_id, issue_type, issue_id
FROM poly_comments
WHERE issue_id NOT IN (SELECT issue_id FROM poly_bugs)
  AND issue_id NOT IN (SELECT issue_id FROM poly_features);
```

```sql reference
SELECT c.comment_id, c.issue_type, c.issue_id
FROM poly_comments c
LEFT JOIN poly_bugs b     ON c.issue_type = 'Bugs'            AND b.issue_id = c.issue_id
LEFT JOIN poly_features f ON c.issue_type = 'FeatureRequests' AND f.issue_id = c.issue_id
WHERE b.issue_id IS NULL AND f.issue_id IS NULL
```

```sql solution
SELECT c.comment_id, c.issue_type, c.issue_id
FROM poly_comments c
WHERE NOT EXISTS (SELECT 1 FROM poly_bugs b
                  WHERE c.issue_type = 'Bugs' AND b.issue_id = c.issue_id)
  AND NOT EXISTS (SELECT 1 FROM poly_features f
                  WHERE c.issue_type = 'FeatureRequests' AND f.issue_id = c.issue_id);
```

> Hint: The type must be part of the match: check `poly_bugs` only when `issue_type = 'Bugs'`, and `poly_features` only when it is `'FeatureRequests'`.

> Hint: Two `NOT EXISTS (...)` subqueries, or two `LEFT JOIN`s with the type in the `ON` clause plus `WHERE b.issue_id IS NULL AND f.issue_id IS NULL`.

> Hint: You should find four orphans, and only one of them has an id that is missing from both tables.

## Exercise: Reverse the reference

Replace the dual-purpose key with two intersection tables that the database can check:

- `bug_comments (issue_id → poly_bugs, comment_id → poly_comments)`
- `feature_comments (issue_id → poly_features, comment_id → poly_comments)`

Give each table a primary key and a `UNIQUE` comment_id. Migrate only the attached comments (the foreign
keys will reject the orphans). Then, **using the new tables**, return `issue_type, issue_id, summary,
comments` for every bug (`'Bugs'`) and every feature request (`'FeatureRequests'`). Issues without
comments show `0`.

```sql starter-setup
CREATE TABLE bug_comments (
  -- issue_id:   foreign key to poly_bugs
  -- comment_id: unique, foreign key to poly_comments
);
CREATE TABLE feature_comments (
);

-- INSERT INTO bug_comments SELECT ... FROM poly_comments c JOIN poly_bugs b ON ...
```

```sql starter
SELECT 'Bugs' AS issue_type, b.issue_id, b.summary, count(c.comment_id) AS comments
FROM poly_bugs b
LEFT JOIN poly_comments c ON c.issue_id = b.issue_id
GROUP BY b.issue_id
UNION ALL
SELECT 'FeatureRequests', f.issue_id, f.summary, count(c.comment_id)
FROM poly_features f
LEFT JOIN poly_comments c ON c.issue_id = f.issue_id
GROUP BY f.issue_id;
```

```sql reference
SELECT 'Bugs' AS issue_type, b.issue_id, b.summary, count(c.comment_id) AS comments
FROM poly_bugs b
LEFT JOIN poly_comments c ON c.issue_type = 'Bugs' AND c.issue_id = b.issue_id
GROUP BY b.issue_id
UNION ALL
SELECT 'FeatureRequests', f.issue_id, f.summary, count(c.comment_id)
FROM poly_features f
LEFT JOIN poly_comments c ON c.issue_type = 'FeatureRequests' AND c.issue_id = f.issue_id
GROUP BY f.issue_id
```

```sql solution-setup
CREATE TABLE bug_comments (
  issue_id   bigint NOT NULL REFERENCES poly_bugs(issue_id),
  comment_id bigint NOT NULL UNIQUE REFERENCES poly_comments(comment_id),
  PRIMARY KEY (issue_id, comment_id)
);
CREATE TABLE feature_comments (
  issue_id   bigint NOT NULL REFERENCES poly_features(issue_id),
  comment_id bigint NOT NULL UNIQUE REFERENCES poly_comments(comment_id),
  PRIMARY KEY (issue_id, comment_id)
);

INSERT INTO bug_comments (issue_id, comment_id)
SELECT c.issue_id, c.comment_id
FROM poly_comments c JOIN poly_bugs b ON b.issue_id = c.issue_id
WHERE c.issue_type = 'Bugs';

INSERT INTO feature_comments (issue_id, comment_id)
SELECT c.issue_id, c.comment_id
FROM poly_comments c JOIN poly_features f ON f.issue_id = c.issue_id
WHERE c.issue_type = 'FeatureRequests';
```

```sql solution
SELECT 'Bugs' AS issue_type, b.issue_id, b.summary, count(bc.comment_id) AS comments
FROM poly_bugs b
LEFT JOIN bug_comments bc USING (issue_id)
GROUP BY b.issue_id
UNION ALL
SELECT 'FeatureRequests', f.issue_id, f.summary, count(fc.comment_id)
FROM poly_features f
LEFT JOIN feature_comments fc USING (issue_id)
GROUP BY f.issue_id;
```

```meta
require: references\s+poly_comments | Give the intersection tables a foreign key to poly_comments
require: join\s+bug_comments | Count bug comments from bug_comments
require: join\s+feature_comments | Count feature comments from feature_comments
```

> Hint: Try inserting *all* `'Bugs'` comments into `bug_comments` first. The foreign key rejects comment 8, the orphan nothing caught before. Join to the parent table so only attached comments are copied.

> Hint: `GROUP BY b.issue_id` is enough to select `b.summary` as well. Postgres knows `summary` depends on the primary key.

> Hint: `count(bc.comment_id)` (not `count(*)`) gives `0` for an issue with no rows in the intersection table.

## Quiz

### Why can't `poly_comments.issue_id` have a foreign key?

- [ ] Because `issue_id` is a `bigint`
- [x] Because a foreign key references exactly one table, and this column points at a different table depending on the row
- [ ] Because Postgres doesn't allow foreign keys on columns that aren't unique
- [ ] Because the parent tables have no primary keys

> A foreign key names one referenced table for the whole column. A value that means "a bug on this row, a feature request on that row" can't be expressed as a constraint.

### Bug 3 and feature request 3 both exist. What goes wrong with `JOIN poly_bugs b ON b.issue_id = c.issue_id`?

- [ ] Nothing, because ids are unique within each table
- [ ] The query fails with an ambiguous column error
- [x] Comments on feature request 3 are attached to bug 3 as well
- [ ] Postgres automatically adds the `issue_type` condition

> Without `c.issue_type = 'Bugs'` in the join, any comment whose `issue_id` happens to be 3 matches bug 3, whichever table it was meant for.

### In the "common super-table" solution, what does `comments.issue_id` reference?

- [ ] Both `bugs` and `feature_requests`, through two foreign keys on the same column
- [x] The `issues` table, whose ids the subtype tables reuse as their own primary keys
- [ ] Nothing. The `issue_type` column replaces the foreign key
- [ ] A view that `UNION`s bugs and feature requests

> The super-table hands out every issue id. Each subtype's primary key is also a foreign key to `issues`, so one real foreign key from `comments` covers all subtypes.

### What does `CHECK (num_nonnulls(bug_id, feature_id) = 1)` enforce in an exclusive-arc design?

- [ ] That the referenced bug or feature exists
- [x] That each comment belongs to exactly one parent: one column set, the other NULL
- [ ] That `bug_id` and `feature_id` are equal
- [ ] That at least one comment exists per bug

> The two foreign keys check existence. The CHECK makes sure exactly one of them is used on each row.
