---
title: Fear of the Unknown
part: Queries
concept: NULL is not a value | Comparing with NULL yields unknown, not false. Use IS NULL, IS DISTINCT FROM, COALESCE and NOT EXISTS.
---

## Objective

Represent **missing** information: a bug nobody is assigned to yet, an account with no hourly rate, a
middle initial that does not exist. SQL's answer is `NULL`, a marker for "no value here".

## The antipattern: treating NULL as an ordinary value (or the reverse)

NULL is not zero, not an empty string and not false. Any expression that touches it becomes NULL:

```sql
SELECT 10 + NULL;                 -- NULL, not 10
SELECT 'Bug ' || NULL;            -- NULL, not 'Bug '
SELECT NULL = NULL;               -- NULL, not true
SELECT NULL <> 5;                 -- NULL, not true
```

A `WHERE` clause keeps a row only when its condition is **true**. A condition that is NULL ("unknown")
drops the row, exactly like false. That produces the classic surprises:

- `WHERE assigned_to = 12` and `WHERE assigned_to <> 12` together do **not** cover the table. Unassigned
  bugs are in neither.
- `WHERE assigned_to = NULL` matches nothing. Ever.
- `first_name || ' ' || middle_initial || ' ' || last_name` is NULL for everyone without a middle initial.

The opposite mistake is avoiding NULL by inventing a stand-in: `-1` for "no assignee", `'N/A'` for "no
priority". Now `avg(hours)` includes the `-1`s, a foreign key to `accounts` needs a fake account number -1,
and every query has to remember the magic value. The column loses its meaning to keep its `NOT NULL`.

## Three-valued logic

| | result |
|---|---|
| `NULL AND true` | NULL |
| `NULL AND false` | false |
| `NULL OR true` | true |
| `NULL OR false` | NULL |
| `NOT NULL` | NULL |

## How to recognize it

- "How do I find rows where no value is set?"
- "The full name shows blank for some users."
- "The totals don't add up to the row count."
- A sentinel such as `-1`, `0`, `''` or `'UNKNOWN'` that means "nothing".

## Legitimate uses

Using NULL is not the antipattern. Declaring `NOT NULL` is right when a missing value makes no sense for
the column. When "missing" has several meanings you need to tell apart (not asked, refused to answer),
a real status value is justified.

## Solution: treat NULL as its own thing

```sql
WHERE assigned_to IS NULL                              -- the only way to test for NULL
WHERE assigned_to IS DISTINCT FROM 12                  -- "<>" that treats NULL as a comparable value
WHERE priority_before IS NOT DISTINCT FROM priority_after   -- NULL-safe "="
SELECT first_name || COALESCE(' ' || middle_initial, '') || ' ' || last_name
SELECT count(*), count(hours), avg(hours)              -- count(col) and avg skip NULLs; count(*) doesn't
ORDER BY hours DESC NULLS LAST
```

`COALESCE(a, b, …)` returns its first non-NULL argument. Aggregates ignore NULL inputs, which is usually
what you want and occasionally a surprise.

## Mini-antipattern: NOT IN (NULL)

`x NOT IN (1, 2, NULL)` means `x <> 1 AND x <> 2 AND x <> NULL`. The last term is never true, so the whole
condition is never true and the query returns **no rows**, without an error. It bites whenever the list
comes from a subquery on a nullable column. `NOT EXISTS` has no such trap, and Postgres plans it as an
efficient anti-join.

## Exercise: Staff with nothing to do

List `account_id, account_name` of staff (accounts where `hourly_rate IS NOT NULL`) who have **no bug
assigned**. The starter looks correct and returns nothing: 721 bugs have `assigned_to IS NULL`.

```sql starter
SELECT account_id, account_name
FROM accounts
WHERE hourly_rate IS NOT NULL
  AND account_id NOT IN (SELECT assigned_to FROM bugs);
```

```sql reference
SELECT a.account_id, a.account_name
FROM accounts a
WHERE a.hourly_rate IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM bugs b WHERE b.assigned_to = a.account_id)
```

```sql solution
SELECT a.account_id, a.account_name
FROM accounts a
WHERE a.hourly_rate IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM bugs b WHERE b.assigned_to = a.account_id)
ORDER BY a.account_id;
```

> Hint: The subquery returns NULLs. `account_id NOT IN (…, NULL)` can never be true.

> Hint: Rewrite it with `NOT EXISTS (SELECT 1 FROM bugs b WHERE b.assigned_to = a.account_id)`, or filter the NULLs out of the subquery.

## Exercise: What changed last night?

`unknown_triage` holds each bug's priority and assignee before and after last night's triage. NULL means
"not set". Return the `bug_id` of every bug whose priority **or** assignee changed, including changes
from or to "not set".

```sql starter
SELECT bug_id
FROM unknown_triage
WHERE priority_before <> priority_after
   OR assignee_before <> assignee_after;
```

```sql reference
SELECT bug_id
FROM unknown_triage
WHERE priority_before IS DISTINCT FROM priority_after
   OR assignee_before IS DISTINCT FROM assignee_after
```

```sql solution
SELECT bug_id
FROM unknown_triage
WHERE priority_before IS DISTINCT FROM priority_after
   OR assignee_before IS DISTINCT FROM assignee_after
ORDER BY bug_id;
```

```meta
require: is\s+distinct\s+from | Compare with IS DISTINCT FROM
```

> Hint: `NULL <> 'MEDIUM'` is unknown, so bug 103 (priority set for the first time) is dropped.

> Hint: `a IS DISTINCT FROM b` is true when exactly one side is NULL, and false when both are.

## Quiz

### What does `SELECT count(*) FROM bugs WHERE assigned_to = NULL` return?

- [ ] The number of unassigned bugs
- [x] 0
- [ ] An error
- [ ] NULL

> `= NULL` is never true. Use `IS NULL`.

### `avg(hours)` over the rows 10, 20, NULL is

- [ ] 10
- [x] 15
- [ ] NULL
- [ ] An error

> Aggregates skip NULL inputs: (10 + 20) / 2. Replacing the NULL with 0 would change the answer to 10.

### Why does `WHERE id NOT IN (SELECT assigned_to FROM bugs)` return no rows when one `assigned_to` is NULL?

- [ ] The subquery is too large
- [x] It expands to a chain of `<>` comparisons joined by AND, and `id <> NULL` is unknown
- [ ] NOT IN needs an index
- [ ] NULL equals every value

> One unknown term in an AND chain keeps the whole condition from ever being true.

### Which expression is a NULL-safe "equals"?

- [ ] `a = b`
- [ ] `a = b OR a = NULL`
- [x] `a IS NOT DISTINCT FROM b`
- [ ] `COALESCE(a = b)`

> It is true when both sides are NULL, false when only one is, and otherwise the same as `=`.
