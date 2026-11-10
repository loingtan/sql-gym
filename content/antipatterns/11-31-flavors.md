---
title: 31 Flavors
part: Physical Database Design
concept: Lookup table | Put the allowed values in rows of a lookup table with a foreign key. Adding, renaming or retiring a value becomes an ordinary INSERT or UPDATE.
---

## Objective

Restrict a column to a **fixed set of values**. A bug's `status` must be `NEW`, `IN PROGRESS`, `FIXED` and so on,
and the database should reject `'BANANA'`.

## The antipattern: values in the column definition

The quick way is to write the list into the column's **metadata**:

```sql
-- A CHECK constraint
CREATE TABLE contacts (
  salutation varchar(5) CHECK (salutation IN ('Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Rev.'))
);

-- A Postgres ENUM type (MySQL has ENUM as a column type)
CREATE TYPE bug_status AS ENUM ('NEW', 'IN PROGRESS', 'FIXED');
CREATE TABLE bugs (status bug_status NOT NULL DEFAULT 'NEW');
```

Domains (`CREATE DOMAIN ... CHECK (VALUE IN (...))`) and triggers do the same thing. They work, until the list
changes, and it will. One day the company opens an office in France and you need `M.`, `Mme.` and `Mlle.`.

- **Which values are allowed?** `SELECT DISTINCT status FROM bugs` only shows values *in use*. The real list is
  in the catalog. For an ENUM Postgres has `enum_range(NULL::bug_status)`. For a CHECK constraint you get text
  from `pg_get_constraintdef()`, something like `CHECK (((salutation)::text = ANY ((ARRAY['Mr.'::character varying, ...` that you have to parse.
  Most teams copy the list into application code instead, and the two copies drift apart.
- **Adding a value is DDL.** A CHECK has to be dropped and added again, and you must know the old list to
  write the new one. `ADD CONSTRAINT` scans the whole table under an `ACCESS EXCLUSIVE` lock (use
  `NOT VALID` then `VALIDATE CONSTRAINT` to shorten that). `ALTER TYPE ... ADD VALUE` is cheap, but the new
  value can't be used in the same transaction that adds it.
- **Removing a value is worse.** Postgres has no `ALTER TYPE ... DROP VALUE`. You create a new type, rewrite the
  column with `ALTER COLUMN ... TYPE ... USING`, and drop the old type. Rows that still hold the old value
  block the change, and the DDL can't decide for you whether they should become `VERIFIED`, `NULL` or something else.
- **No room for attributes.** You can't mark a value as obsolete, give it a display label or a sort order.
- **Surprising sort order.** ENUM values sort in declaration order, not alphabetically.

## How to recognize it

- "We need a maintenance window to add an option to a dropdown."
- "This list of values *shouldn't* need to change." (*Shouldn't* is not *can't*.)
- "The list in the application is out of sync with the database again."

## Legitimate uses

Metadata is fine when the set of values **truly never changes**: `LEFT`/`RIGHT`, `ON`/`OFF`, `ASC`/`DESC`.
An ENUM is also compact (4 bytes) and its declaration order can be useful. CHECK constraints are excellent for
rules that are not lists at all, such as `CHECK (start_date < end_date)` or `CHECK (hours >= 0)`.

## Solution: values in data

Create a **lookup table** with one row per allowed value, and reference it with a foreign key. The base schema of
this app already does it: `bugs.status` references `bug_status(status)`.

```sql
CREATE TABLE salutations (
  salutation varchar(5) PRIMARY KEY,
  active     boolean NOT NULL DEFAULT true
);
ALTER TABLE contacts
  ADD FOREIGN KEY (salutation) REFERENCES salutations(salutation) ON UPDATE CASCADE;

INSERT INTO salutations (salutation) VALUES ('M.'), ('Mme.'), ('Mlle.');      -- add: plain INSERT
UPDATE salutations SET active = false WHERE salutation = 'Rev.';           -- retire, keep history
SELECT salutation FROM salutations WHERE active ORDER BY salutation;        -- the dropdown
```

- The list is a normal query result, so the dropdown, the validation and any report all read the same rows.
- Adding a value is an `INSERT`, without DDL, downtime or knowing the old list.
- Renaming is an `UPDATE`; `ON UPDATE CASCADE` fixes every referencing row.
- A referenced value can't be deleted (the foreign key stops you), so you **retire** it with a flag. Old rows stay
  valid, and new rows can be stopped from using it in the application or a trigger.
- Extra columns (`active`, `label`, `sort_order`, `color`) are free.
- It uses only standard foreign keys, so it works in every database.

Rule of thumb: a list that will never change can live in the schema; a list that might change is data, so store it as rows.

## Mini-antipattern: reserved words

`SELECT * FROM bugs WHERE order = 123` fails with *syntax error at or near "order"*: `ORDER` is a reserved
keyword. Quote the identifier with **double quotes**, the SQL standard delimiter (MySQL uses backticks, SQL
Server brackets):

```sql
SELECT * FROM queue WHERE "order" = 123;
SELECT word FROM pg_get_keywords() WHERE catcode = 'R';   -- Postgres' reserved words
```

Some reserved words don't cause a syntax error at all. `user` is reserved in Postgres, so
`SELECT user FROM accounts` runs and returns the **current role name** on every row, not your column.
Quoting also makes a name case-sensitive in Postgres: unquoted names fold to lower case, so `"Order"`
and `order` are different identifiers. The simplest fix is to avoid keywords as names (`sort_order`, `username`).
When code builds SQL dynamically, quote names with `format('%I', name)` or `quote_ident()`.

## Exercise: Bugs per status, including empty ones

`flavor_bugs.status` uses the ENUM type `flavor_status`. The dashboard must show **every** allowed status with
its number of bugs, `0` for statuses no bug has yet, in the type's declared (workflow) order.
Return `status, bugs`.

```sql starter
SELECT status, count(*) AS bugs
FROM flavor_bugs
GROUP BY status
ORDER BY status;
```

```sql reference
SELECT s.status, count(b.bug_id) AS bugs
FROM unnest(enum_range(NULL::flavor_status)) AS s(status)
LEFT JOIN flavor_bugs b USING (status)
GROUP BY s.status
ORDER BY s.status
```

```sql solution
SELECT e.enumlabel AS status, count(b.bug_id) AS bugs
FROM pg_enum e
LEFT JOIN flavor_bugs b ON b.status::text = e.enumlabel
WHERE e.enumtypid = 'flavor_status'::regtype
GROUP BY e.enumlabel, e.enumsortorder
ORDER BY e.enumsortorder;
```

```meta
ordered: true
require: enum_range|pg_enum | Read the allowed values from the type definition, not from the rows
```

> Hint: The data only knows the statuses in use. The full list is in the catalog: `enum_range(NULL::flavor_status)` returns it as an array, and `unnest()` turns the array into rows.

> Hint: Start `FROM` the list of values and `LEFT JOIN flavor_bugs`. Then `count(b.bug_id)` gives 0 where nothing matched (`count(*)` would give 1).

> Hint: Ordering by an ENUM value sorts in declaration order, which is the workflow order here.

## Exercise: Bonjour, France

`flavor_contacts.salutation` is limited by the CHECK constraint `flavor_contacts_salutation_check` to
`Mr.`, `Mrs.`, `Ms.`, `Dr.`, `Rev.`. Replace it with a lookup table:

1. Create `salutations (salutation varchar(5) PRIMARY KEY, active boolean NOT NULL DEFAULT true)` with the five
   current values and the French `M.`, `Mme.`, `Mlle.`.
2. Retire `Rev.` (`active = false`). Ken Sato keeps it.
3. Drop the CHECK constraint and add a foreign key to `salutations`.
4. Add the new contact `Amélie Laurent` with salutation `Mme.`.

Then, **from `salutations`**, return the dropdown: every *active* salutation with its number of contacts
(`0` if unused), as `salutation, contacts`.

```sql starter-setup
-- CREATE TABLE salutations (...);
-- INSERT INTO salutations ...;
-- ALTER TABLE flavor_contacts DROP CONSTRAINT ..., ADD FOREIGN KEY ...;
-- INSERT INTO flavor_contacts (full_name, salutation) VALUES ('Amélie Laurent', 'Mme.');
```

```sql starter
SELECT salutation, count(*) AS contacts
FROM flavor_contacts
GROUP BY salutation;
```

```sql reference
SELECT s.salutation, count(c.full_name) AS contacts
FROM unnest(ARRAY['Mr.', 'Mrs.', 'Ms.', 'Dr.', 'M.', 'Mme.', 'Mlle.']) AS s(salutation)
LEFT JOIN (
  SELECT full_name, salutation FROM flavor_contacts
  UNION ALL SELECT 'Amélie Laurent', 'Mme.'
) c USING (salutation)
GROUP BY s.salutation
```

```sql solution-setup
CREATE TABLE salutations (
  salutation varchar(5) PRIMARY KEY,
  active     boolean NOT NULL DEFAULT true
);

INSERT INTO salutations (salutation) VALUES
  ('Mr.'), ('Mrs.'), ('Ms.'), ('Dr.'), ('Rev.'), ('M.'), ('Mme.'), ('Mlle.');

UPDATE salutations SET active = false WHERE salutation = 'Rev.';

ALTER TABLE flavor_contacts
  DROP CONSTRAINT flavor_contacts_salutation_check,
  ADD FOREIGN KEY (salutation) REFERENCES salutations(salutation) ON UPDATE CASCADE;

INSERT INTO flavor_contacts (full_name, salutation) VALUES ('Amélie Laurent', 'Mme.');
```

```sql solution
SELECT s.salutation, count(c.contact_id) AS contacts
FROM salutations s
LEFT JOIN flavor_contacts c USING (salutation)
WHERE s.active
GROUP BY s.salutation;
```

```meta
require: references\s+salutations | Point flavor_contacts.salutation at the lookup table with a foreign key
require: (from|join)\s+salutations | Build the dropdown from the salutations table
```

> Hint: Insert all eight values (including `Rev.`) **before** adding the foreign key, or the existing rows fail the check. Ken Sato still says `Rev.`.

> Hint: One `ALTER TABLE` can do both: `DROP CONSTRAINT flavor_contacts_salutation_check, ADD FOREIGN KEY (salutation) REFERENCES salutations(salutation)`.

> Hint: Start the query `FROM salutations WHERE active` and `LEFT JOIN flavor_contacts`. Count a contact column, not `*`.

## Quiz

### Why is `SELECT DISTINCT status FROM bugs` a bad way to fill a status dropdown?

- [ ] It is too slow on large tables
- [x] It only returns statuses that are in use, so a value no row has yet can never be chosen
- [ ] DISTINCT doesn't work on ENUM columns
- [ ] It returns the values in the wrong order

> The allowed set and the used set are different. With values in metadata you must read the catalog; with a lookup table it's just `SELECT ... FROM bug_status`.

### You must stop offering `DUPLICATE` as a status, but 400 old bugs have it. With a lookup table, what do you do?

- [ ] `DELETE FROM bug_status WHERE status = 'DUPLICATE'`
- [ ] Recreate the column without that value
- [x] Add an `active` flag to the lookup table and set it to false for `DUPLICATE`
- [ ] Update the 400 bugs to `NULL` first

> The foreign key protects the old rows, so you retire the value instead of deleting it. History stays valid and the dropdown shows only active values.

### What does `SELECT user FROM accounts` return in PostgreSQL if `accounts` has a column named `user`?

- [ ] The values of the `user` column
- [ ] A syntax error
- [x] The current role name, repeated on every row
- [ ] NULL on every row

> `USER` is a reserved word that means `current_user`. Write `"user"` to get the column, or better, don't name a column `user`.

### When is a CHECK constraint with a list of values a good choice?

- [x] When the set can't change, like `'LEFT'` / `'RIGHT'`
- [ ] When the list changes every month
- [ ] When the application also keeps a copy of the list
- [ ] When the values need a display label

> Metadata suits a fixed set. If the set may change, or needs extra attributes, use a lookup table.
