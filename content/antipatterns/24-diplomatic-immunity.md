---
title: Diplomatic Immunity
part: Application Development
concept: SQL is code | Version, document, test and review the schema like any other code. The catalog can check it for you.
---

## Objective

Use software engineering best practices: version control, automated tests, documentation, code review.

## The antipattern: make SQL a second-class citizen

Teams that test and review application code often treat the database as exempt:

- The schema exists only in the live database, changed by hand. Nobody can rebuild it or say what changed when.
- No one knows what a column means, its unit, why it's nullable, or whether it holds personal data.
- Tables get created "just for now" without a primary key, and foreign keys without the index that joins and
  `ON DELETE` checks need.
- One DBA is the only living documentation.

## How to recognize it

- "We use a lightweight version of the process" (we skip the database part).
- "The DBAs don't need access to the repository."
- "Which columns contain personal data? We'd have to check every table."
- "Is there a tool to diff two schemas and generate the fix?" (the environments drifted apart).
- "The schema is self-documenting."

## Legitimate uses

Throwaway code: a one-off query to test an idea, or a demo for a colleague. If you can't bring yourself to delete
it after use, it's worth committing.

## Solution: a big-tent culture of quality

**Version control.** Keep DDL, functions, triggers, seed data and DBA scripts in the same repository as the
app, applied by **migrations** (Flyway, Liquibase, Sqitch, Alembic, Rails, or numbered `.sql` files like this
project's `db/` folder). Every environment is then built from the same history.

**Documentation in the database itself.** Postgres stores comments in the catalog, so they travel with the schema:

```sql
COMMENT ON TABLE bugs IS 'One row per reported defect.';
COMMENT ON COLUMN bugs.hours IS 'Estimated effort in hours; NULL = not yet estimated.';
SELECT obj_description('bugs'::regclass, 'pg_class');      -- \d+ in psql shows them too
```

Pair that with an ER diagram and notes on relationships, triggers, functions, roles and infrastructure.

**Tests.** Check that expected tables and columns exist (and removed ones don't), that constraints reject bad
rows, that triggers and functions do what they should, and that bootstrap data is present. Tools like
pgTAP run these in SQL, and a rolled-back transaction keeps them isolated. Give each developer and branch
its own database (a container makes this cheap).

**Let the catalog review the schema.** `information_schema` (standard) and `pg_catalog` (complete) are
queryable, so lint rules become queries you can run in CI:

```sql
-- tables without a primary key
SELECT c.relname FROM pg_class c
WHERE c.relkind = 'r' AND c.relnamespace = 'bugs'::regnamespace
  AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p');
```

## Mini-antipattern: renaming things

`ALTER TABLE ... RENAME` is instant, and that's the problem: every running app server still uses the old name.
Ways to rename without downtime:

1. **Expand and contract**: create the new table or column, write to both, backfill, switch reads, stop writing to the old one, drop it.
2. **A view as an alias**: rename the table, then immediately `CREATE VIEW old_name AS SELECT * FROM new_name`. A
   simple view like that is automatically updatable in Postgres, so old code keeps working until it is migrated.

Postgres DDL is transactional, so the rename and the view can be committed together.

## Exercise: Tables without a primary key

Someone created some `di_` tables in a hurry. Using the system catalog, return the `table_name` of every table in
schema `bugs` whose name starts with `di_` and that has **no primary key**.

```sql starter
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'bugs' AND table_name LIKE 'di\_%';
```

```sql reference
SELECT c.relname::text
FROM pg_class c
WHERE c.relkind = 'r' AND c.relnamespace = 'bugs'::regnamespace AND c.relname LIKE 'di\_%'
  AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p')
```

```sql solution
SELECT t.table_name
FROM information_schema.tables t
WHERE t.table_schema = 'bugs' AND t.table_type = 'BASE TABLE' AND t.table_name LIKE 'di\_%'
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints tc
    WHERE tc.table_schema = t.table_schema AND tc.table_name = t.table_name
      AND tc.constraint_type = 'PRIMARY KEY');
```

```meta
require: (pg_constraint|table_constraints|pg_index) | Check the constraints (or indexes) in the catalog
```

> Hint: `information_schema.table_constraints` has a `constraint_type` column; look for `'PRIMARY KEY'`.

> Hint: In `pg_catalog`, primary keys are rows in `pg_constraint` with `contype = 'p'`, linked by `conrelid = pg_class.oid`.

> Hint: `_` is a wildcard in `LIKE`. Escape it (`'di\_%'`) to match a literal underscore.

## Exercise: Foreign keys without an index

Postgres indexes primary keys automatically but **not** foreign-key columns. Return `table_name, column_name` for
every single-column foreign key on a `di_` table whose column is not the **first** column of any index.

```sql starter
SELECT c.conrelid::regclass::text AS table_name, a.attname AS column_name
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
WHERE c.contype = 'f' AND c.conrelid::regclass::text LIKE 'di\_%';
```

```sql reference
SELECT c.conrelid::regclass::text AS table_name, a.attname::text AS column_name
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
WHERE c.contype = 'f' AND c.connamespace = 'bugs'::regnamespace
  AND c.conrelid::regclass::text LIKE 'di\_%'
  AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])
```

```sql solution
SELECT c.conrelid::regclass::text AS table_name, a.attname AS column_name
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
WHERE c.contype = 'f' AND c.conrelid::regclass::text LIKE 'di\_%'
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1]);
```

```meta
require: pg_index | Check pg_index for an index that starts with the FK column
```

> Hint: `pg_constraint.conkey` is an array of column numbers; for a single-column key, `conkey[1]` is the column.

> Hint: `pg_index.indkey` lists an index's column numbers starting at position 0. The index helps the FK when `indkey[0]` is that column.

## Quiz

### Where should the schema's source of truth live?

- [ ] In the production database
- [ ] In the DBA's home directory
- [x] In version control, as migrations applied to every environment
- [ ] In an ER diagram

> Version-controlled migrations let you rebuild, review and roll back schema changes like code.

### Which Postgres feature stores a column's documentation alongside the schema?

- [ ] `pg_stat_statements`
- [x] `COMMENT ON COLUMN ... IS '...'`
- [ ] `ALTER TABLE ... SET STORAGE`
- [ ] `EXPLAIN`

> Comments live in the catalog (`col_description`, `obj_description`) and show in `\d+`.

### How can you rename a busy table without breaking the old app version?

- [ ] Rename it during lunch
- [x] Rename the table and create a view with the old name, in one transaction
- [ ] Copy the table nightly
- [ ] You can't. Never rename tables

> A simple view is automatically updatable, so old code works until it's migrated to the new name.
