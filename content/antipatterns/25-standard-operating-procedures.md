---
title: Standard Operating Procedures
part: Application Development
concept: A tool, not a rule | Use database routines where they win (fewer round-trips, privileged operations), not because "we always have".
---

## Objective

Put logic inside the database as **stored routines** so every client calls the same, prescribed code, for
example "close every unresolved bug of a product" without each app writing its own `UPDATE`.

## The antipattern: follow the leader

Stored procedures aren't the antipattern. **Choosing any technique only because a previous project
used it** is. "All SQL goes in procedures" was common when one DBA wrote the efficient queries and client languages were
weak. Applied without thinking today, it has costs:

- **Portability**: every brand's procedure language differs (PL/pgSQL, T-SQL, PL/SQL, MySQL). Moving databases means rewriting.
- **Tooling**: weaker debuggers, test frameworks, linters and migration support than application languages have.
- **Deployment**: one database server, no rolling restart. Every caller depends on the version that's live.
- **Scalability**: logic in procedures runs on the one database server, while the app servers sit idle waiting for it.
  You can add app servers, but there is usually only one primary database.

## How to recognize it

- "We always use procedures because they're faster." No feature is faster in every case. Measure.
- "What tool can convert our 500 T-SQL procedures to Postgres?" There's no reliable automatic translation.
- "Why do I get a syntax error at `DECLARE`?" Each procedure language has its own rules.

## Legitimate uses

- **Many dependent steps over a slow link**: one call instead of many network round-trips.
- **Admin and batch jobs** with no client application (cleanup, audits, scheduled jobs via `pg_cron`).
- **Controlled privilege**: a `SECURITY DEFINER` function lets a role perform one sensitive operation the
  prescribed way without having rights on the tables.
- **Data rules close to the data**: triggers and constraint helpers.

## Solution: adopt modern application architecture

Keep logic that formats queries or processes results in the application, where it can be unit-tested, debugged,
reviewed and scaled across servers. The SQL itself still runs in the database. Use routines deliberately, and
then treat them as code (chapter 24): versioned, tested, documented.

**Postgres routines, briefly:**

| | Function | Procedure (PG 11+) |
|---|---|---|
| Called with | `SELECT f(...)`, anywhere an expression fits | `CALL p(...)` |
| Returns | a value, a row, or a set (`RETURNS TABLE`) | nothing (or `INOUT` params) |
| Transactions | runs inside the caller's | may `COMMIT`/`ROLLBACK` when called outside a transaction block |

```sql
-- SQL-language function: one query, can be inlined by the planner
CREATE FUNCTION open_bugs(p_product bigint) RETURNS bigint
LANGUAGE sql STABLE
BEGIN ATOMIC
  SELECT count(*) FROM bugs JOIN bugs_products USING (bug_id)
  WHERE product_id = p_product AND status = 'NEW';
END;

-- PL/pgSQL procedure: procedural steps
CREATE PROCEDURE close_unresolved(p_product bigint)
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE bugs SET status = 'WONTFIX'
  WHERE status = 'NEW'
    AND bug_id IN (SELECT bug_id FROM bugs_products WHERE product_id = p_product);
END $$;
CALL close_unresolved(3);
```

Use `LANGUAGE sql` when one query does the job, and PL/pgSQL when you need variables, loops or exception handling.

## Mini-antipattern: assuming every database's procedures work alike

The book's warnings about MySQL procedures don't all apply to Postgres, and Postgres has its own pitfalls:

- `CREATE OR REPLACE FUNCTION` swaps the body **atomically** (no drop-then-create gap), but it can't change the return type.
- PL/pgSQL bodies are only **syntax-checked** at `CREATE` time. A misspelled table or column is found the first time
  that line runs, so test every branch. A SQL-standard body (`BEGIN ATOMIC ... END`) is parsed at creation, and its
  dependencies are tracked so `DROP TABLE` will refuse.
- PL/pgSQL caches query plans per session, and generic plans may be chosen after a few calls (`plan_cache_mode`).
- Volatility labels (`IMMUTABLE`/`STABLE`/`VOLATILE`) matter: a wrong label leads to wrong results or blocks indexes and inlining.

## Exercise: A SQL function per product

In Setup, create a **SQL-language** function `bug_hours(p_product bigint) RETURNS numeric` that returns the total
`hours` of all bugs linked to that product. Then return `product_id, product_name, bug_hours(product_id)` for every product.

```sql starter
SELECT p.product_id, p.product_name, sum(b.hours)
FROM products p
JOIN bugs_products bp USING (product_id)
JOIN bugs b USING (bug_id)
GROUP BY p.product_id, p.product_name;
```

```sql reference
SELECT p.product_id, p.product_name,
       (SELECT sum(b.hours) FROM bugs_products bp JOIN bugs b USING (bug_id) WHERE bp.product_id = p.product_id)
FROM products p
```

```sql solution-setup
CREATE FUNCTION bug_hours(p_product bigint) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT sum(b.hours)
  FROM bugs_products bp JOIN bugs b USING (bug_id)
  WHERE bp.product_id = p_product
$$;
```

```sql solution
SELECT product_id, product_name, bug_hours(product_id)
FROM products;
```

```meta
require: create\s+(or\s+replace\s+)?function | Create the function in Setup
require: language\s+sql | Write it in LANGUAGE sql
require: bug_hours\s*\(\s*(p\.)?product_id\s*\) | Call bug_hours(product_id) in the Query
```

> Hint: A SQL function's body is just a query: `LANGUAGE sql AS $$ SELECT ... $$`. (Use the `$$` form here: this app's Setup box splits statements at `;`, which breaks a `BEGIN ATOMIC ... END` body.)

> Hint: Mark it `STABLE`: it only reads data, so it gives the same answer for the same arguments within one statement.

## Exercise: A procedure that closes unresolved bugs

In Setup, create a procedure `close_unresolved(p_product bigint)` that sets `status = 'WONTFIX'` on every **NEW**
bug linked to the product, then `CALL` it for product **3**. In the Query, return `status, count(*)` for
the bugs of product 3.

```sql starter-setup
UPDATE bugs SET status = 'WONTFIX'
WHERE status = 'NEW'
  AND bug_id IN (SELECT bug_id FROM bugs_products WHERE product_id = 3);
```

```sql starter
SELECT b.status, count(*)
FROM bugs b JOIN bugs_products bp USING (bug_id)
WHERE bp.product_id = 3
GROUP BY b.status;
```

```sql reference
SELECT CASE WHEN b.status = 'NEW' THEN 'WONTFIX' ELSE b.status END AS status, count(*)
FROM bugs b JOIN bugs_products bp USING (bug_id)
WHERE bp.product_id = 3
GROUP BY 1
```

```sql solution-setup
CREATE PROCEDURE close_unresolved(p_product bigint)
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE bugs SET status = 'WONTFIX'
  WHERE status = 'NEW'
    AND bug_id IN (SELECT bug_id FROM bugs_products WHERE product_id = p_product);
END $$;

CALL close_unresolved(3);
```

```sql solution
SELECT b.status, count(*)
FROM bugs b JOIN bugs_products bp USING (bug_id)
WHERE bp.product_id = 3
GROUP BY b.status;
```

```meta
require: create\s+(or\s+replace\s+)?procedure | Create a procedure in Setup
require: \bcall\s+close_unresolved\s*\( | Run it with CALL close_unresolved(...)
```

> Hint: `CREATE PROCEDURE name(args) LANGUAGE plpgsql AS $$ BEGIN ... END $$;` then `CALL name(3);`.

> Hint: Don't `COMMIT` inside it here: the app runs your attempt inside one transaction, and a procedure can only commit when called outside a transaction block.

## Quiz

### What's the actual antipattern in this chapter?

- [ ] Using stored procedures at all
- [x] Choosing a technique only because earlier projects did, without weighing it for this one
- [ ] Writing SQL in application code
- [ ] Using PL/pgSQL instead of SQL functions

> Procedures are a tool. The mistake is a rule followed out of habit.

### How do you run a Postgres `PROCEDURE`, and what can it do that a function can't?

- [ ] `SELECT p()`; it can return a set of rows
- [x] `CALL p()`; it can `COMMIT`/`ROLLBACK` when not called inside an outer transaction
- [ ] `EXECUTE p()`; it runs on the app server
- [ ] `PERFORM p()`; it is always faster

> Functions run inside the caller's transaction and return values. Procedures are invoked with `CALL` and may control transactions.

### A PL/pgSQL function references a misspelled column. When do you find out?

- [ ] At `CREATE FUNCTION` time
- [x] When that statement first executes
- [ ] Never; it returns NULL
- [ ] At the next `VACUUM`

> PL/pgSQL checks syntax at creation but resolves tables and columns at run time. Test every branch.

### When is a stored routine a good fit?

- [ ] Always: procedures are faster
- [ ] Never: keep all logic in the app
- [x] Many dependent statements over a slow link, admin jobs, or a `SECURITY DEFINER` gate to one privileged operation
- [ ] Formatting HTML for reports

> These cases save round-trips or control privileges. Everything else belongs where it's easiest to test and scale.
