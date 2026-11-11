---
title: Foreign Key Mistakes
part: Foreign Keys
concept: Declare the whole key | A foreign key points from child to parent, at a unique key, with matching columns in matching order and types. Clean the orphans first.
---

## Objective

Declare foreign keys that work. The syntax is short and still easy to get wrong. These are the mistakes
from the book's bonus chapter that apply to PostgreSQL, with what Postgres says about each.

## Reversing the direction

The constraint belongs on the **child** table, the one that holds the reference. `fkm_tasks.project_id`
refers to a project, so the foreign key is declared on `fkm_tasks`:

```sql
ALTER TABLE fkm_tasks ADD FOREIGN KEY (project_id) REFERENCES fkm_projects (project_id);   -- right
ALTER TABLE fkm_projects ADD FOREIGN KEY (project_id) REFERENCES fkm_tasks (project_id);   -- backwards
```

The backwards version says "a project may exist only if a task with that number does".

## Referencing a table that does not exist yet

`REFERENCES` needs the parent table to exist. Create parents before children, or create all tables
first and add the constraints afterwards with `ALTER TABLE`. Two tables that reference each other always
need the second approach.

## Referencing no key of the parent

The referenced columns must be the parent's primary key or have a unique constraint. Otherwise one child
row could match several parents.

```
ERROR: there is no unique constraint matching given keys for referenced table "fkm_releases"
```

## Separate constraints for each column of a compound key

When the parent's key is `(product_id, version)`, the child needs **one** constraint over both columns.
Two single-column constraints each reference half a key (which is not unique, so Postgres rejects them),
and even if they were accepted they would allow product 1 with a version that only product 2 has.

```sql
FOREIGN KEY (product_id, version) REFERENCES fkm_releases (product_id, version)   -- right
```

## Wrong column order

Columns are paired by position. `FOREIGN KEY (version, product_id) REFERENCES fkm_releases (product_id, version)`
compares version with product_id. Different types give an error. Same types give a constraint that
checks the wrong thing.

## Mismatched data types

Child and parent columns should have the same type. Postgres accepts comparable types (`int` referencing
`bigint`) and refuses incomparable ones:

```
ERROR: foreign key constraint cannot be implemented
DETAIL: Key columns "project_id" and "name" are of incompatible types: integer and text.
```

Even when accepted, a mismatch means casts on every check and a child that cannot hold all parent values.

## Creating orphan data

Adding a foreign key validates the existing rows. If the child already holds values with no parent, the
`ALTER TABLE` fails:

```
ERROR: insert or update on table "fkm_tasks" violates foreign key constraint
DETAIL: Key (project_id)=(4) is not present in table "fkm_projects".
```

Find the orphans with an anti-join, then delete them, repoint them, or restore the missing parents.
On a large live table, add the constraint `NOT VALID` (new rows are checked at once), clean up, and
then run `VALIDATE CONSTRAINT`.

## SET NULL on a NOT NULL column

`ON DELETE SET NULL` on a column declared `NOT NULL` is accepted at creation and fails at the first
delete of a parent, with a not-null violation. Choose `CASCADE`, `RESTRICT` or a default instead, or
make the column nullable.

## Duplicate constraint names

Constraint names share a namespace per table in Postgres (and per schema in the SQL standard). Copying a
`CONSTRAINT fk_project` line into a second constraint on the same table fails. Let Postgres generate the
name (`fkm_tasks_project_id_fkey`) or follow a convention that includes table and column.

## Exercise: Orphans block the constraint

`fkm_tasks.project_id` has no foreign key, and some tasks point at projects that no longer exist. In
Setup: move every orphan task to project `0` (Inbox), then add the foreign key to `fkm_projects`. The
query returns `task_id, project_id` for all tasks.

```sql starter-setup
-- 1. Find the tasks whose project_id has no row in fkm_projects
-- 2. UPDATE them to project 0
-- 3. ALTER TABLE fkm_tasks ADD FOREIGN KEY ...
```

```sql starter
SELECT task_id, project_id
FROM fkm_tasks
ORDER BY task_id;
```

```sql reference
SELECT t.task_id,
       CASE WHEN EXISTS (SELECT 1 FROM fkm_projects p WHERE p.project_id = t.project_id)
            THEN t.project_id ELSE 0 END
FROM fkm_tasks t
```

```sql solution-setup
UPDATE fkm_tasks t
SET project_id = 0
WHERE NOT EXISTS (SELECT 1 FROM fkm_projects p WHERE p.project_id = t.project_id);

ALTER TABLE fkm_tasks
  ADD FOREIGN KEY (project_id) REFERENCES fkm_projects (project_id);
```

```sql solution
SELECT task_id, project_id
FROM fkm_tasks
ORDER BY task_id;
```

```meta
require: references\s+fkm_projects | Add a foreign key that references fkm_projects
```

> Hint: Try the `ALTER TABLE … ADD FOREIGN KEY` first and read the error: it names an orphan value.

> Hint: Orphans: `SELECT * FROM fkm_tasks t WHERE NOT EXISTS (SELECT 1 FROM fkm_projects p WHERE p.project_id = t.project_id);`

> Hint: Put the UPDATE before the ALTER TABLE. Statements in Setup run in order.

## Exercise: A compound key needs one constraint

`fkm_releases` has the primary key `(product_id, version)`. Give `fkm_build_log` a single foreign key
over both columns with `ON UPDATE CASCADE`. Then, still in Setup, rename release `1.1` of product 2 to
`1.1.1` in `fkm_releases` and let the cascade update the builds. The query returns
`build_id, product_id, version, status` for all builds.

```sql starter-setup
-- ALTER TABLE fkm_build_log ADD FOREIGN KEY (...) REFERENCES fkm_releases (...) ON UPDATE CASCADE;
-- UPDATE fkm_releases SET version = '1.1.1' WHERE ...;
```

```sql starter
SELECT build_id, product_id, version, status
FROM fkm_build_log
ORDER BY build_id;
```

```sql reference
SELECT build_id, product_id,
       CASE WHEN product_id = 2 AND version = '1.1' THEN '1.1.1' ELSE version END,
       status
FROM fkm_build_log
```

```sql solution-setup
ALTER TABLE fkm_build_log
  ADD FOREIGN KEY (product_id, version)
  REFERENCES fkm_releases (product_id, version)
  ON UPDATE CASCADE;

UPDATE fkm_releases SET version = '1.1.1' WHERE product_id = 2 AND version = '1.1';
```

```sql solution
SELECT build_id, product_id, version, status
FROM fkm_build_log
ORDER BY build_id;
```

```meta
require: foreign\s+key\s*\(\s*product_id\s*,\s*version\s*\) | One foreign key over (product_id, version)
require: on\s+update\s+cascade | Declare ON UPDATE CASCADE
require: update\s+fkm_releases | Rename the release in fkm_releases and let the cascade do the rest
```

> Hint: Two constraints, one per column, are rejected: neither column alone is unique in `fkm_releases`.

> Hint: `FOREIGN KEY (product_id, version) REFERENCES fkm_releases (product_id, version) ON UPDATE CASCADE`

> Hint: Product 1 also has a version 1.1. Its builds must stay untouched, which only the compound key guarantees.

## Quiz

### `tasks.project_id` refers to `projects`. On which table is the foreign key declared?

- [x] `tasks`, the child that holds the reference
- [ ] `projects`, the parent
- [ ] Both
- [ ] Either, the direction doesn't matter

> The constraint restricts the rows of the table it is declared on: a task may exist only if its project does.

### Why does Postgres reject `FOREIGN KEY (product_id) REFERENCES fkm_releases (product_id)`?

- [ ] The types differ
- [x] `product_id` alone is not unique in `fkm_releases`, so a child row could match several parents
- [ ] The table has too many rows
- [ ] Foreign keys cannot reference primary keys

> A foreign key must reference a whole primary key or unique constraint.

### Adding a foreign key fails with "Key (project_id)=(4) is not present in table". What now?

- [ ] Drop the parent table
- [ ] Disable constraint checking permanently
- [x] Find the orphan rows and delete, repoint or re-parent them, then add the constraint again
- [ ] Change the column type

> The constraint is telling you the data is already inconsistent. Fix the data, then let the database keep it fixed.

### `ON DELETE SET NULL` on a column declared `NOT NULL`

- [ ] Is rejected when the constraint is created
- [x] Is accepted, then fails when a referenced parent row is deleted
- [ ] Silently deletes the child row
- [ ] Sets the column to 0

> The two declarations contradict each other, and Postgres only notices when the action fires.
