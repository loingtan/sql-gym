---
title: Entity-Attribute-Value
part: Logical Database Design
concept: Use metadata for metadata | Attributes belong in columns, where types, NOT NULL, CHECK and foreign keys work. Model the subtypes; keep jsonb for truly open-ended data.
---

## Objective

Support **variable attributes**. Bugs and feature requests share most attributes (status, priority, date
reported), but a bug also has a `severity` and a `version_affected`, while a feature request has a `sponsor`.
More issue types will come. You want one place to query all issues, and you don't want a schema change every
time someone invents an attribute.

## The antipattern: a generic attribute table

Store attributes as rows: one row per entity, attribute name and value. This is **Entity-Attribute-Value**
(EAV), also sold as "open schema" or "name-value pairs":

```sql
CREATE TABLE eav_issue_attributes (
  issue_id   bigint NOT NULL REFERENCES eav_issues(issue_id),
  attr_name  varchar(100) NOT NULL,
  attr_value varchar(100),
  PRIMARY KEY (issue_id, attr_name)
);
INSERT INTO eav_issue_attributes VALUES
  (1, 'issue_type', 'BUG'), (1, 'status', 'NEW'), (1, 'date_reported', '2024-03-02'), (1, 'severity', 'crash');
```

Two narrow tables, no NULL-filled columns, new attributes without `ALTER TABLE`. It looks great until you
use it:

- **Even simple reads are indirect.** `SELECT issue_id, date_reported FROM issues` becomes
  `SELECT issue_id, attr_value FROM eav_issue_attributes WHERE attr_name = 'date_reported'`.
- **No mandatory attributes.** `NOT NULL` applies to a column, not to "a row with this name must exist".
- **No data types.** `attr_value` is a string, so `'banana'` is a perfectly good `date_reported`.
  One-value-column-per-type variants only move the mess into `COALESCE(...)` chains.
- **No referential integrity.** A foreign key on `attr_value` would apply to *every* attribute, not just `status`.
- **No fixed attribute names.** One row says `date_reported`, another `report_date`. Every query has to know
  all spellings.
- **Rebuilding a row** takes one join (or one aggregate) per attribute, and you must know all attributes when
  writing the query. Inner joins silently drop entities that lack any one of them.

This is the **inner-platform effect**: rebuilding a database's features (columns, types, constraints) inside a
database, worse than the original.

## How to recognize it

- "The database is fully extensible: you define new attributes at runtime."
- "What's the maximum number of joins in one query?"
- "We need a consultant to write reports for our e-commerce platform." (many customizable packages use EAV)

## Legitimate uses

Truly user-defined fields, in one or two tables, when you budget for the extra work and know the downsides.
If most of your data is non-relational, a non-relational store may fit, but the core problem stays: when
metadata is fluid, every query has to discover the structure first.

## Solution: model the subtypes

Do the analysis. Most "dynamic" data turns out to be a handful of known subtypes.

**Single Table Inheritance.** One table with the common columns, every subtype's columns, and a type column.
The book's complaint, that nothing says which column belongs to which type, is fixable in Postgres with
`CHECK` constraints:

```sql
CREATE TABLE issues (
  issue_id      bigint PRIMARY KEY,
  issue_type    varchar(10) NOT NULL CHECK (issue_type IN ('BUG', 'FEATURE')),
  status        varchar(20) NOT NULL REFERENCES bug_status(status),
  date_reported date NOT NULL,
  severity      varchar(30),
  sponsor       varchar(50),
  CHECK (issue_type = 'BUG' OR severity IS NULL),
  CHECK (issue_type = 'FEATURE' OR sponsor IS NULL)
);
```

Best for few subtypes with few extra columns.

**Concrete Table Inheritance.** A full table per subtype (`bugs`, `feature_requests`), each repeating the common
columns. Columns that don't apply can't even be written, but adding a common attribute means altering every
table, and querying all issues needs a `UNION ALL` view.

**Class Table Inheritance.** A base table `issues` with the common columns, plus one table per subtype whose
primary key is also a foreign key to the base: `issue_bugs(issue_id PRIMARY KEY REFERENCES issues, severity, ...)`.
Searching across all issues is one table; subtype columns are a `LEFT JOIN ... USING (issue_id)` away. (Postgres's
own `INHERITS` feature looks tempting here, but primary keys, unique constraints and foreign keys don't span
parent and children.)

**Semistructured data: `jsonb`.** When the attributes really are open-ended, keep the known ones as columns
and put the rest in one `jsonb` column:

```sql
ALTER TABLE issues ADD COLUMN attrs jsonb NOT NULL DEFAULT '{}';
CREATE INDEX ON issues USING gin (attrs);
SELECT issue_id, attrs->>'sponsor' FROM issues WHERE attrs @> '{"sponsor": "Acme Corp"}';
```

Trade-offs: no per-key types, foreign keys or `NOT NULL` (only what you write as `CHECK`s, such as
`attrs ? 'sponsor'`), weaker planner statistics, and key names repeated in every row. When a key becomes
important, promote it to a real column (a generated column, `GENERATED ALWAYS AS (attrs->>'sponsor') STORED`,
is a halfway step).

**Stuck with EAV?** Don't force entities into wide rows. Fetch the attributes as rows and build the object in
the application, or let Postgres do it: `SELECT issue_id, jsonb_object_agg(attr_name, attr_value) ... GROUP BY issue_id`.
When you must pivot, `max(attr_value) FILTER (WHERE attr_name = 'status')` keeps entities with missing attributes.

## Exercise: Rebuild the bug rows

Reconstruct every issue whose `issue_type` is `'BUG'` as one row: `issue_id, status, priority, severity`.
An attribute the issue doesn't have must come out as `NULL`, not make the issue disappear.

```sql starter
SELECT t.issue_id, s.attr_value AS status, p.attr_value AS priority, v.attr_value AS severity
FROM eav_issue_attributes t
JOIN eav_issue_attributes s ON s.issue_id = t.issue_id AND s.attr_name = 'status'
JOIN eav_issue_attributes p ON p.issue_id = t.issue_id AND p.attr_name = 'priority'
JOIN eav_issue_attributes v ON v.issue_id = t.issue_id AND v.attr_name = 'severity'
WHERE t.attr_name = 'issue_type' AND t.attr_value = 'BUG';
```

```sql reference
SELECT t.issue_id, s.attr_value, p.attr_value, v.attr_value
FROM eav_issue_attributes t
LEFT JOIN eav_issue_attributes s ON s.issue_id = t.issue_id AND s.attr_name = 'status'
LEFT JOIN eav_issue_attributes p ON p.issue_id = t.issue_id AND p.attr_name = 'priority'
LEFT JOIN eav_issue_attributes v ON v.issue_id = t.issue_id AND v.attr_name = 'severity'
WHERE t.attr_name = 'issue_type' AND t.attr_value = 'BUG'
```

```sql solution
SELECT issue_id,
       max(attr_value) FILTER (WHERE attr_name = 'status')   AS status,
       max(attr_value) FILTER (WHERE attr_name = 'priority') AS priority,
       max(attr_value) FILTER (WHERE attr_name = 'severity') AS severity
FROM eav_issue_attributes
GROUP BY issue_id
HAVING max(attr_value) FILTER (WHERE attr_name = 'issue_type') = 'BUG';
```

> Hint: Run the starter and compare with `SELECT * FROM eav_issue_attributes WHERE issue_id = 4`. Which attribute is missing?

> Hint: Either turn the attribute joins into `LEFT JOIN`s, or pivot in one pass: `GROUP BY issue_id` with `max(attr_value) FILTER (WHERE attr_name = 'status')`.

> Hint: With the pivot, keep only bugs in `HAVING max(attr_value) FILTER (WHERE attr_name = 'issue_type') = 'BUG'`.

## Exercise: Migrate to single-table inheritance

Move the EAV data into a real table `issues`. The starter setup gives you its columns. Make `date_reported` a
real `date`, add `CHECK` constraints (`issue_type` is `BUG` or `FEATURE`; `severity` and `version_affected` only
on bugs; `sponsor` only on features), then fill it from `eav_issue_attributes`. The migration will expose what
EAV let in: some rows spell the attribute `report_date` (treat it as `date_reported`), and a value that isn't a
valid date must become `NULL`. Finally return
`issue_id, issue_type, status, priority, date_reported, severity, version_affected, sponsor` **from `issues`**.

```sql starter-setup
CREATE TABLE issues (
  issue_id         bigint PRIMARY KEY REFERENCES eav_issues(issue_id),
  issue_type       varchar(10) NOT NULL,   -- CHECK: only BUG or FEATURE
  status           varchar(20) NOT NULL,
  priority         varchar(20),
  date_reported    varchar(100),           -- make this a real date
  severity         varchar(30),            -- bugs only
  version_affected varchar(20),            -- bugs only
  sponsor          varchar(50)             -- features only
);

-- INSERT INTO issues (...)
-- SELECT issue_id, max(attr_value) FILTER (WHERE attr_name = '...'), ...
-- FROM eav_issue_attributes GROUP BY issue_id;
```

```sql starter
SELECT issue_id, issue_type, status, priority, date_reported, severity, version_affected, sponsor
FROM issues;
```

```sql reference
SELECT issue_id,
       max(attr_value) FILTER (WHERE attr_name = 'issue_type'),
       max(attr_value) FILTER (WHERE attr_name = 'status'),
       max(attr_value) FILTER (WHERE attr_name = 'priority'),
       max(CASE WHEN attr_name IN ('date_reported', 'report_date') AND attr_value ~ '^\d{4}-\d{2}-\d{2}$'
                THEN attr_value::date END),
       max(attr_value) FILTER (WHERE attr_name = 'severity'),
       max(attr_value) FILTER (WHERE attr_name = 'version_affected'),
       max(attr_value) FILTER (WHERE attr_name = 'sponsor')
FROM eav_issue_attributes
GROUP BY issue_id
```

```sql solution-setup
CREATE TABLE issues (
  issue_id         bigint PRIMARY KEY REFERENCES eav_issues(issue_id),
  issue_type       varchar(10) NOT NULL CHECK (issue_type IN ('BUG', 'FEATURE')),
  status           varchar(20) NOT NULL,
  priority         varchar(20),
  date_reported    date,
  severity         varchar(30),
  version_affected varchar(20),
  sponsor          varchar(50),
  CHECK (issue_type = 'BUG' OR (severity IS NULL AND version_affected IS NULL)),
  CHECK (issue_type = 'FEATURE' OR sponsor IS NULL)
);

INSERT INTO issues
SELECT issue_id,
       max(attr_value) FILTER (WHERE attr_name = 'issue_type'),
       max(attr_value) FILTER (WHERE attr_name = 'status'),
       max(attr_value) FILTER (WHERE attr_name = 'priority'),
       max(attr_value) FILTER (WHERE attr_name IN ('date_reported', 'report_date')
                                 AND pg_input_is_valid(attr_value, 'date'))::date,
       max(attr_value) FILTER (WHERE attr_name = 'severity'),
       max(attr_value) FILTER (WHERE attr_name = 'version_affected'),
       max(attr_value) FILTER (WHERE attr_name = 'sponsor')
FROM eav_issue_attributes
GROUP BY issue_id;
```

```sql solution
SELECT issue_id, issue_type, status, priority, date_reported, severity, version_affected, sponsor
FROM issues;
```

```meta
require: date_reported\s+date\b | Declare date_reported as a date column
require: check\s*\( | Add CHECK constraints for the issue type and the subtype-only columns
require: (from|join)\s+issues\b | Answer the question from the new issues table
```

> Hint: Pivot with one `max(attr_value) FILTER (WHERE attr_name = '...')` per column, `GROUP BY issue_id`. For the date use `attr_name IN ('date_reported', 'report_date')`.

> Hint: Casting `'banana'` to `date` fails the whole `INSERT`. Postgres 16+ has `pg_input_is_valid(attr_value, 'date')` to test a value before casting it.

> Hint: A subtype rule reads as "either it's a bug, or the column is empty": `CHECK (issue_type = 'BUG' OR severity IS NULL)`.

## Quiz

### Why can't EAV make `date_reported` mandatory for every issue?

- [ ] Because `attr_value` allows NULL
- [x] Because `NOT NULL` constrains a column, and here the attribute is a row that may simply not exist
- [ ] Because dates can't be stored in a `varchar`
- [ ] It can, with a foreign key on `attr_name`

> A constraint that says "a row with this name must exist for every entity" isn't something SQL constraints express. Columns get it for free.

### What happens if you put `FOREIGN KEY (attr_value) REFERENCES bug_status(status)` on the EAV table?

- [ ] Only the `status` attribute is checked against `bug_status`
- [x] Every attribute's value must be a bug status, so dates, priorities and sponsors are all rejected
- [ ] Postgres refuses to create a foreign key on a `varchar`
- [ ] Nothing changes, because foreign keys ignore EAV tables

> A constraint applies to every row of the table. In EAV, rows hold unrelated attributes, so no single foreign key fits.

### Rebuilding entities with one `JOIN` per attribute, what goes wrong when an issue lacks one attribute?

- [ ] Its row appears twice
- [x] With inner joins, the whole issue disappears from the result
- [ ] Postgres raises an error
- [ ] The missing value becomes an empty string

> An inner join needs a matching row. Use `LEFT JOIN`s, or pivot with `max(...) FILTER (WHERE attr_name = ...)`, which yields `NULL`.

### When is a `jsonb` column the better choice over modeling subtypes as columns?

- [ ] Whenever you want to avoid `ALTER TABLE`
- [ ] When an attribute needs a foreign key
- [x] When the attributes are genuinely open-ended and you query them less than the core columns
- [ ] When every row has the same attributes

> `jsonb` gives flexibility and GIN-indexed containment queries, but loses per-key types, foreign keys and `NOT NULL`. Known, important attributes belong in columns.
