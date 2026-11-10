---
title: Naive Trees
part: Logical Database Design
concept: Pick a tree model | Adjacency list plus WITH RECURSIVE reaches any depth. A closure table turns subtree and ancestor queries into plain joins.
---

## Objective

Store and query a **hierarchy**: comments that reply to comments, employees and managers, product categories.
Each node has one parent, the root has none, and the leaves have no children. Besides single nodes, you need
whole **subtrees** ("this comment and every reply under it") and **ancestor chains** ("breadcrumbs up to the root").

## The antipattern: always depend on one's parent

The textbook design adds a `parent_id` column that points at another row of the same table. This is called
an **adjacency list**:

```sql
CREATE TABLE tree_comments (
  comment_id bigint PRIMARY KEY,
  bug_id     bigint NOT NULL REFERENCES bugs(bug_id),
  parent_id  bigint REFERENCES tree_comments(comment_id),
  author     bigint NOT NULL REFERENCES accounts(account_id),
  comment    text   NOT NULL
);
```

Storing the tree is fine. The antipattern is how people **query** it without recursion. Each level of the tree
costs one more self-join, and a query has a fixed number of joins:

```sql
-- Reaches 3 levels below comment 4. Level 4 and deeper are silently missing.
SELECT c1.comment_id, c2.comment_id, c3.comment_id
FROM tree_comments c1
LEFT JOIN tree_comments c2 ON c2.parent_id = c1.comment_id
LEFT JOIN tree_comments c3 ON c3.parent_id = c2.comment_id
WHERE c1.parent_id = 4;
```

Each level also lands in a new *column*, so `COUNT()` or `SUM()` over a subtree is awkward. The usual
fallback is worse: fetch every comment of the bug and build the tree in application code, throwing away
most of the rows. Deleting a subtree means finding descendants level by level and deleting bottom-up so the
foreign key stays happy (or `ON DELETE CASCADE`, if deleting replies is always what you want).

## How to recognize it

- "How many levels do we need to support?" (you are counting self-joins)
- "I dread touching the code that manages the tree." (a clever model chosen for the wrong workload)
- "A cleanup script runs nightly to remove orphaned nodes." (deletes leave the structure broken)

## Legitimate uses

The adjacency list itself is the most normal design there is: no redundancy, a real foreign key, trivial
inserts and moves (`UPDATE ... SET parent_id = 3`). If you only need parents and children, or the depth is
truly fixed and small, keep it. Don't build a general tree engine for a hierarchy that is always one level deep.

## Solution: use the right tree model

**Recursive query (keep the adjacency list).** Postgres has had `WITH RECURSIVE` since 8.4. The anchor
picks the start node; the recursive part joins children onto the rows found so far, until nothing new appears:

```sql
WITH RECURSIVE thread AS (
  SELECT comment_id, 0 AS depth, ARRAY[comment_id] AS path
  FROM tree_comments WHERE comment_id = 4
  UNION ALL
  SELECT c.comment_id, t.depth + 1, t.path || c.comment_id
  FROM thread t JOIN tree_comments c ON c.parent_id = t.comment_id
)
SELECT * FROM thread ORDER BY path;   -- array order = depth-first display order
```

Postgres 14+ can also generate the ordering for you (`SEARCH DEPTH FIRST BY comment_id SET ord`) and guard
against cycles in bad data (`CYCLE comment_id SET is_cycle USING seen`). Index `parent_id`: Postgres does not
index foreign-key columns automatically, and every recursion step looks children up by it.

**Path enumeration.** Store the ancestor chain, like a file path: `'1/4/6/7/'`. Descendants are
`path LIKE '1/4/%'`, ancestors are `'1/4/6/7/' LIKE path || '%'`. Nothing validates the string, so it shares
Jaywalking's flaws. In Postgres prefer the **`ltree`** extension: a typed label path (`1.4.6.7`) with operators
such as `path <@ '1.4'` (is a descendant of) and GiST index support.

**Nested sets.** Each node stores `nsleft`/`nsright` from a depth-first walk; descendants are the nodes whose
`nsleft` falls between the parent's two numbers. Subtree reads are fast, but an insert renumbers a large part
of the tree, finding a direct parent is a puzzle, and there is no referential integrity. Clever, maybe too clever.

**Closure table.** Store every ancestor/descendant pair in a separate table, including each node paired with
itself (`path_length = 0`):

```sql
CREATE TABLE tree_paths (
  ancestor    bigint NOT NULL REFERENCES tree_comments(comment_id),
  descendant  bigint NOT NULL REFERENCES tree_comments(comment_id),
  path_length int    NOT NULL,
  PRIMARY KEY (ancestor, descendant)
);

SELECT descendant FROM tree_paths WHERE ancestor = 4;                    -- whole subtree
SELECT ancestor   FROM tree_paths WHERE descendant = 7;                  -- breadcrumbs
SELECT descendant FROM tree_paths WHERE ancestor = 4 AND path_length = 1; -- direct children
```

Inserting a leaf copies the parent's ancestor rows plus a self row; moving a subtree is one delete and one
cross-join insert. Both foreign keys keep it honest. The price is extra rows, roughly nodes × average depth.

| Design | Subtree query | Insert / move | Referential integrity |
|---|---|---|---|
| Adjacency list + `WITH RECURSIVE` | easy | easy | yes |
| Path enumeration / `ltree` | easy | easy | no |
| Nested sets | easy | hard | no |
| Closure table | easy | easy | yes |

## Mini-antipattern: it works on my computer

A query that uses a newer feature (MySQL 8 `WITH`, Postgres 14 `SEARCH`/`CYCLE`, Postgres 15 `MERGE`, Postgres 16
`pg_input_is_valid`) works in development and fails in production on an older server. Run the same major version
and comparable settings in every environment; pinning the image tag (`postgres:17`) is the easy way.

## Exercise: The whole reply thread

`tree_comments` is an adjacency list. Return every comment in the subtree that starts at comment **4**
(comment 4 itself included) as `comment_id, depth`, where comment 4 has depth `0`, its replies depth `1`, and
so on. The thread is deeper than it looks.

```sql starter
-- One self-join per level. How deep is deep enough?
SELECT comment_id, 0 AS depth FROM tree_comments WHERE comment_id = 4
UNION ALL
SELECT c1.comment_id, 1 FROM tree_comments c1 WHERE c1.parent_id = 4
UNION ALL
SELECT c2.comment_id, 2
FROM tree_comments c1 JOIN tree_comments c2 ON c2.parent_id = c1.comment_id
WHERE c1.parent_id = 4
UNION ALL
SELECT c3.comment_id, 3
FROM tree_comments c1
JOIN tree_comments c2 ON c2.parent_id = c1.comment_id
JOIN tree_comments c3 ON c3.parent_id = c2.comment_id
WHERE c1.parent_id = 4;
```

```sql reference
WITH RECURSIVE t(comment_id, depth) AS (
  VALUES (4::bigint, 0)
  UNION ALL
  SELECT c.comment_id, t.depth + 1 FROM t JOIN tree_comments c ON c.parent_id = t.comment_id
)
SELECT comment_id, depth FROM t
```

```sql solution
WITH RECURSIVE thread AS (
  SELECT comment_id, 0 AS depth
  FROM tree_comments
  WHERE comment_id = 4
  UNION ALL
  SELECT c.comment_id, t.depth + 1
  FROM thread t
  JOIN tree_comments c ON c.parent_id = t.comment_id
)
SELECT comment_id, depth FROM thread;
```

```meta
require: with\s+recursive | Use WITH RECURSIVE so any depth works
```

> Hint: Shape: `WITH RECURSIVE thread AS (<anchor> UNION ALL <recursive part>) SELECT ... FROM thread`.

> Hint: The anchor selects comment 4 with depth `0`. The recursive part joins `tree_comments c` to `thread t` on `c.parent_id = t.comment_id` and returns `t.depth + 1`.

## Exercise: Build a closure table

Create a closure table `tree_paths (ancestor, descendant, path_length)` with a composite primary key and
foreign keys to `tree_comments`. Fill it with **every** ancestor/descendant pair, including each comment paired
with itself at `path_length = 0`. Then, **using `tree_paths`**, return every comment with the number of replies
anywhere below it as `comment_id, replies` (a leaf has `0`).

```sql starter-setup
CREATE TABLE tree_paths (
  -- ancestor    ... REFERENCES tree_comments(comment_id)
  -- descendant  ... REFERENCES tree_comments(comment_id)
  -- path_length ...
  -- PRIMARY KEY (...)
);

-- INSERT INTO tree_paths ... WITH RECURSIVE ...
```

```sql starter
-- Counts direct replies only.
SELECT c.comment_id, count(r.comment_id) AS replies
FROM tree_comments c
LEFT JOIN tree_comments r ON r.parent_id = c.comment_id
GROUP BY c.comment_id;
```

```sql reference
WITH RECURSIVE p(ancestor, descendant) AS (
  SELECT comment_id, comment_id FROM tree_comments
  UNION ALL
  SELECT p.ancestor, c.comment_id FROM p JOIN tree_comments c ON c.parent_id = p.descendant
)
SELECT ancestor, count(*) - 1 FROM p GROUP BY ancestor
```

```sql solution-setup
CREATE TABLE tree_paths (
  ancestor    bigint NOT NULL REFERENCES tree_comments(comment_id),
  descendant  bigint NOT NULL REFERENCES tree_comments(comment_id),
  path_length int    NOT NULL,
  PRIMARY KEY (ancestor, descendant)
);

INSERT INTO tree_paths (ancestor, descendant, path_length)
WITH RECURSIVE p AS (
  SELECT comment_id AS ancestor, comment_id AS descendant, 0 AS path_length
  FROM tree_comments
  UNION ALL
  SELECT p.ancestor, c.comment_id, p.path_length + 1
  FROM p JOIN tree_comments c ON c.parent_id = p.descendant
)
SELECT ancestor, descendant, path_length FROM p;
```

```sql solution
SELECT ancestor AS comment_id, count(*) FILTER (WHERE path_length > 0) AS replies
FROM tree_paths
GROUP BY ancestor;
```

```meta
require: (from|join)\s+tree_paths\b | Answer the question from the tree_paths closure table
```

> Hint: Seed the recursion with one self row per comment (`ancestor = descendant = comment_id`, length 0). Each step keeps the `ancestor` and moves `descendant` down one level via `c.parent_id = p.descendant`.

> Hint: `INSERT INTO tree_paths (...) WITH RECURSIVE p AS (...) SELECT ... FROM p;` is valid Postgres.

> Hint: Every comment has exactly one self row, so the reply count is `count(*) - 1`, or `count(*) FILTER (WHERE path_length > 0)`.

## Quiz

### Why can't a query with a fixed number of self-joins return a whole subtree from an adjacency list?

- [ ] Because self-joins aren't allowed on a table with a foreign key to itself
- [x] Each join reaches exactly one more level, and the tree can be deeper than the joins you wrote
- [ ] Because `LEFT JOIN` drops rows whose `parent_id` is NULL
- [ ] Because Postgres limits a query to four joins

> One join per level means the depth is baked into the SQL. A recursive CTE keeps joining until no new rows appear.

### In a closure table, how do you get the direct children of comment 4?

- [ ] `WHERE descendant = 4 AND path_length = 1`
- [x] `WHERE ancestor = 4 AND path_length = 1`
- [ ] `WHERE ancestor = 4 AND descendant <> 4`
- [ ] You can't without a recursive query

> Comment 4 is the ancestor, and a path length of 1 means one step down. `descendant <> 4` would return the whole subtree.

### Which tree designs can't enforce referential integrity with foreign keys?

- [ ] Adjacency list and closure table
- [x] Path enumeration and nested sets
- [ ] Closure table only
- [ ] All of them can

> A path string (or `ltree` value) and a pair of nested-set numbers aren't references a foreign key can check. `parent_id` and the closure table's two columns are.

### You keep `parent_id` and query with `WITH RECURSIVE`. Which index matters most for subtree queries?

- [ ] The primary key on `comment_id` alone is enough
- [x] An index on `parent_id`, which every recursion step uses to find children
- [ ] A GIN index on `comment`
- [ ] No index helps a recursive query

> Each step looks up "rows whose parent is one of these ids". Postgres doesn't index foreign-key columns for you.
