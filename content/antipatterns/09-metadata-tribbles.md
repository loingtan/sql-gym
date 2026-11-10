---
title: Metadata Tribbles
part: Logical Database Design
concept: Don't let data spawn metadata | One table per year (or one column per year) is a value hidden in a name. Use one table and let declarative partitioning split it physically.
---

## Objective

Keep queries fast as a table **grows year after year**. Smaller tables are faster to scan, so it's
tempting to make every table small, whatever that takes.

## The antipattern: clone tables or columns

Split one logical table into copies named after a data value:

```sql
CREATE TABLE tribble_bugs_2021 (bug_id bigint PRIMARY KEY, date_reported date, status varchar(20), ...);
CREATE TABLE tribble_bugs_2022 (LIKE tribble_bugs_2021 INCLUDING ALL);
CREATE TABLE tribble_bugs_2023 (LIKE tribble_bugs_2021 INCLUDING ALL);
-- ... and a new one every January, like tribbles multiplying
```

Or the column variant, where every year adds a column: `bugs_fixed_2021`, `bugs_fixed_2022`, ...
Either way, a **data value has become part of a table or column name**, and now:

- **New data needs new schema.** On 1 January inserts fail until someone remembers to create the new table.
- **Nothing keeps rows in the right table.** A 2022 bug filed into `_2021` is accepted. You can add
  `CHECK (date_reported >= '2021-01-01' AND date_reported < '2022-01-01')` to each clone, and then
  maintain that by hand too.
- **Correcting a value can mean moving the row.** Changing a bug's date from 2022-01-03 to 2021-12-27
  becomes an `INSERT` into one table plus a `DELETE` from the other.
- **Uniqueness across clones** needs a shared sequence. Each clone's primary key only covers that clone.
- **Every cross-year query is a `UNION ALL`** that has to be edited each year. Plain `UNION` also removes
  duplicate rows, which silently breaks counts.
- **Schema drift.** `ALTER TABLE tribble_bugs_2024 ADD COLUMN hours` changes one clone, and `SELECT *` across clones stops lining up.
- **No foreign keys** can point at "the bugs table", because there isn't one.

```sql
SELECT status, count(*) FROM (
  SELECT status FROM tribble_bugs_2021 UNION ALL
  SELECT status FROM tribble_bugs_2022 UNION ALL
  SELECT status FROM tribble_bugs_2023            -- forgot 2024 again?
) b GROUP BY status;
```

## How to recognize it

- "We need to create a table (or column) **per** year / customer / region..."
- "What's the maximum number of tables Postgres supports?"
- "Inserts started failing this morning. We forgot to create this year's table."
- "How do I pass a table name as a parameter?" (You'd need dynamic SQL with `format('%I', ...)`.)

## Legitimate uses

**Archiving** data that is no longer queried together with current data, such as moving closed years out
of the hot table. **Sharding** whole tenants into separate databases can also make sense at large scale,
for moving, backing up and restoring one customer independently. Both are operational decisions, not a
way to speed up queries.

## Solution: partition and normalize

**Horizontal partitioning.** Postgres (10+) has *declarative partitioning*: one logical table, many
physical partitions, and the database routes every row:

```sql
CREATE TABLE tribble_bugs (
  bug_id        bigint NOT NULL,
  date_reported date   NOT NULL,
  status        varchar(20) NOT NULL,
  PRIMARY KEY (bug_id, date_reported)          -- must include the partition key
) PARTITION BY RANGE (date_reported);

CREATE TABLE tribble_bugs_y2021 PARTITION OF tribble_bugs
  FOR VALUES FROM ('2021-01-01') TO ('2022-01-01');
CREATE TABLE tribble_bugs_other PARTITION OF tribble_bugs DEFAULT;   -- catches anything unmatched
```

Queries name only `tribble_bugs`. A `WHERE date_reported >= '2023-01-01' AND date_reported < '2024-01-01'`
is answered by **partition pruning**, so only the 2023 partition is scanned (check with `EXPLAIN`). An
`UPDATE` that changes `date_reported` **moves the row** to the right partition (Postgres 11+).
`ALTER TABLE` on the parent changes every partition. `DETACH PARTITION` turns an old year into a
standalone table for archiving.

Postgres caveats:

- Unique constraints and primary keys must include the partition key.
- `PARTITION BY HASH (bug_id)` spreads rows evenly when there is no natural range.
- Partitions still have to be created ahead of time. Use a `DEFAULT` partition or a scheduled job (the
  `pg_partman` extension does this) so the new year never fails inserts.
- Partitioning pays off on **big** tables. For a few thousand rows, an index is the answer.

**Vertical partitioning.** Move bulky, rarely read columns (an installer `bytea`, long text) into a
1:1 table whose primary key is also the foreign key. Postgres already does part of this for you:
values over about 2 kB are moved out of line (TOAST) automatically. Selecting only the columns you need
still matters.

**Metadata tribble columns** are fixed like Multicolumn Attributes: a dependent table with one row per
year, `(project_id, year, bugs_fixed, PRIMARY KEY (project_id, year))`.

## Exercise: Count across the clones

Bugs are split into `tribble_bugs_2021` ... `tribble_bugs_2024`. Return `status, bugs`: how many bugs
have each status **across all years**. The starter has two bugs in it, and `SELECT *` won't help either:
someone added an `hours` column to `tribble_bugs_2024` only.

```sql starter
SELECT b.status, count(*) AS bugs
FROM (
  SELECT status FROM tribble_bugs_2021
  UNION
  SELECT status FROM tribble_bugs_2022
  UNION
  SELECT status FROM tribble_bugs_2023
) AS b
GROUP BY b.status;
```

```sql reference
SELECT status, count(*) AS bugs
FROM bugs
GROUP BY status
```

```sql solution
SELECT b.status, count(*) AS bugs
FROM (
  SELECT status FROM tribble_bugs_2021
  UNION ALL SELECT status FROM tribble_bugs_2022
  UNION ALL SELECT status FROM tribble_bugs_2023
  UNION ALL SELECT status FROM tribble_bugs_2024
) AS b
GROUP BY b.status;
```

> Hint: `UNION` removes duplicate rows. Selecting only `status` makes almost every row a duplicate. Use `UNION ALL`.

> Hint: Count the tables in the schema browser. Is every year in the query?

> Hint: The reference answer is just `SELECT status, count(*) FROM bugs GROUP BY status`, which is what one table gives you for free.

## Exercise: One partitioned table

Replace the clones with a partitioned table:

1. Create `tribble_bugs` with the clones' columns (`bug_id, date_reported, summary, status, reported_by`)
   plus `hours numeric(9,2)`, partitioned by range on `date_reported`.
2. Create one partition per year named `tribble_bugs_y2021` ... `tribble_bugs_y2025`.
3. Copy every row from the four clones into it. Some early 2022 bugs were misfiled in the 2021 clone,
   and 2025 bugs ended up in the 2024 clone.
4. Support says bug **1224** was actually reported on **2021-12-27**. Fix it with one `UPDATE` on `tribble_bugs`.

Then return `partition, bugs`, the number of rows in each partition, by grouping on `tableoid::regclass::text`.

```sql starter-setup
-- 1. tribble_bugs: same columns as the clones + hours, partitioned by range on date_reported
-- 2. one partition per year: tribble_bugs_y2021 ... tribble_bugs_y2025
-- 3. copy the rows from tribble_bugs_2021 ... tribble_bugs_2024
-- 4. correct the date of bug 1224
```

```sql starter
SELECT 'tribble_bugs_2021' AS partition, count(*) AS bugs FROM tribble_bugs_2021
UNION ALL SELECT 'tribble_bugs_2022', count(*) FROM tribble_bugs_2022
UNION ALL SELECT 'tribble_bugs_2023', count(*) FROM tribble_bugs_2023
UNION ALL SELECT 'tribble_bugs_2024', count(*) FROM tribble_bugs_2024;
```

```sql reference
SELECT 'tribble_bugs_y' || extract(year FROM CASE WHEN bug_id = 1224 THEN date '2021-12-27' ELSE date_reported END) AS partition,
       count(*) AS bugs
FROM (SELECT bug_id, date_reported FROM tribble_bugs_2021
      UNION ALL SELECT bug_id, date_reported FROM tribble_bugs_2022
      UNION ALL SELECT bug_id, date_reported FROM tribble_bugs_2023
      UNION ALL SELECT bug_id, date_reported FROM tribble_bugs_2024) b
GROUP BY 1
```

```sql solution-setup
CREATE TABLE tribble_bugs (
  bug_id        bigint NOT NULL,
  date_reported date NOT NULL,
  summary       varchar(80),
  status        varchar(20) NOT NULL,
  reported_by   bigint NOT NULL,
  hours         numeric(9,2),
  PRIMARY KEY (bug_id, date_reported)
) PARTITION BY RANGE (date_reported);

CREATE TABLE tribble_bugs_y2021 PARTITION OF tribble_bugs FOR VALUES FROM ('2021-01-01') TO ('2022-01-01');
CREATE TABLE tribble_bugs_y2022 PARTITION OF tribble_bugs FOR VALUES FROM ('2022-01-01') TO ('2023-01-01');
CREATE TABLE tribble_bugs_y2023 PARTITION OF tribble_bugs FOR VALUES FROM ('2023-01-01') TO ('2024-01-01');
CREATE TABLE tribble_bugs_y2024 PARTITION OF tribble_bugs FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE TABLE tribble_bugs_y2025 PARTITION OF tribble_bugs FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');

INSERT INTO tribble_bugs (bug_id, date_reported, summary, status, reported_by)
SELECT bug_id, date_reported, summary, status, reported_by FROM tribble_bugs_2021
UNION ALL SELECT bug_id, date_reported, summary, status, reported_by FROM tribble_bugs_2022
UNION ALL SELECT bug_id, date_reported, summary, status, reported_by FROM tribble_bugs_2023;

INSERT INTO tribble_bugs (bug_id, date_reported, summary, status, reported_by, hours)
SELECT bug_id, date_reported, summary, status, reported_by, hours FROM tribble_bugs_2024;

UPDATE tribble_bugs SET date_reported = '2021-12-27' WHERE bug_id = 1224;
```

```sql solution
SELECT tableoid::regclass::text AS partition, count(*) AS bugs
FROM tribble_bugs
GROUP BY 1;
```

```meta
require: partition\s+by\s+range | Create tribble_bugs with PARTITION BY RANGE (date_reported)
require: update\s+tribble_bugs\b | Correct bug 1224 with an UPDATE on tribble_bugs
require: from\s+tribble_bugs\b | Count the rows from tribble_bugs
```

> Hint: `PRIMARY KEY (bug_id)` is rejected on a partitioned table. Unique constraints must include the partition key: `PRIMARY KEY (bug_id, date_reported)`.

> Hint: `FOR VALUES FROM ('2021-01-01') TO ('2022-01-01')`: the upper bound is exclusive. If an insert fails with *no partition of relation found for row*, a year is missing. That's the tribble problem, but now it fails loudly.

> Hint: `tableoid` is a hidden column holding the oid of the table a row physically lives in. Cast it with `::regclass::text` to get the partition name.

## Quiz

### Why does `SELECT status FROM a UNION SELECT status FROM b` break a count per status?

- [ ] `UNION` requires an `ORDER BY`
- [x] `UNION` removes duplicate rows, so each status survives only once
- [ ] `UNION` can't combine more than two tables
- [ ] It doesn't. `UNION` and `UNION ALL` are the same

> `UNION` deduplicates the combined result. Use `UNION ALL` whenever you combine row sets you intend to count or sum.

### What happens when you `UPDATE` the partition key of a row in a range-partitioned table (Postgres 11+)?

- [ ] The update is rejected
- [ ] The row stays in its old partition with a value outside the range
- [x] Postgres moves the row into the partition that now matches
- [ ] A new partition is created automatically

> Postgres deletes the row from the old partition and inserts it into the right one, all inside your `UPDATE`.

### Why must a primary key on a partitioned table include the partition key?

- [x] Each partition enforces uniqueness with its own index, so only keys that pin a row to one partition can be guaranteed unique overall
- [ ] Because partitioned tables can't have indexes
- [ ] Because the SQL standard requires it for all composite keys
- [ ] It doesn't. Any column can be the primary key

> There is no global index across partitions. Including the partition key means two equal keys must land in the same partition, where its local index catches them.

### Which design fixes the column version, `bugs_fixed_2021, bugs_fixed_2022, ...`?

- [ ] Add columns up to `bugs_fixed_2099` in advance
- [ ] A comma-separated `bugs_fixed` string
- [x] A dependent table with one row per `(project_id, year)` and a `bugs_fixed` column
- [ ] One table per year

> A new year becomes a new row, not a new column, so the schema and the queries never have to change.
