---
title: See No Evil
part: Application Development
concept: Read the error | Check every database call, and debug the SQL the server actually received, not the code that built it.
---

## Objective

Write less code. Fewer lines mean less to test and review, so it's tempting to skip "noise" like checking
return values and catching exceptions.

## The antipattern: making bricks without straw

It shows up in two ways, and both ignore information the database is already giving you.

**Ignoring errors.** The connection fails (wrong host, user, password), the statement has a typo, a constraint
rejects the row. The code doesn't look, so it carries on with a broken result: a blank page, a null dereference,
"the database lost my data". The server said exactly what was wrong; nobody read it.

**Debugging the code instead of the SQL.** Building a query from fragments hides its real shape:

```python
query = "SELECT * FROM bugs"
if bug_id: query += "WHERE bug_id = %s"       # no space: ...FROM bugsWHERE bug_id = ...
```

Staring at the Python won't show the problem. Printing the final string shows it at once.

## How to recognize it

- "My program crashes after I query the database." (The query failed and the result was used anyway.)
- "Can you find my SQL error? Here's my code..." (Show the SQL, not the code that builds it.)
- "I don't clutter my code with error handling."

## Legitimate uses

Skip a check only when there's nothing useful to do about the error, like a failed `close()` right before the
process exits. Letting an exception travel up to a caller that handles it is not ignoring it.

## Solution: recover from errors gracefully

- **Check every call.** In node-postgres, `await client.query()` throws, so catch it, log the error and the SQL, and
  show the user a friendly message. Also check `rowCount` when "updated 0 rows" means something went wrong.
- **Look at the actual SQL.** Build it in a variable and log it (with parameters logged separately). On the server,
  `log_min_error_statement = error` (the default) logs every failing statement; `log_statement`, `auto_explain` and
  `pg_stat_statements` show what really ran. Never print SQL into HTML comments, since anyone can view the source.
- **Use the error's fields.** Postgres errors carry a `SQLSTATE` code (`23505` unique violation, `23503` FK violation,
  `42P01` undefined table, `42703` undefined column, `42601` syntax error). Branch on the code, not on the message text.

## Mini-antipattern: reading syntax error messages

Postgres says *where* it got confused and often *what* it expected:

```text
ERROR:  syntax error at or near "date_reported"
LINE 1: SELECT * FROM bugs ORDER date_reported;
                                 ^
```

The caret marks the first token the parser couldn't use. The mistake is usually there or **just before it**
(here the missing `BY`). Other patterns worth knowing:

- `syntax error at or near "WHERE"`: a second `WHERE` where `AND` belongs.
- `syntax error at end of input`: something was left open, such as a parenthesis or a quote.
- `column "date_reportd" does not exist` with `HINT: Perhaps you meant to reference the column "bugs.date_reported"`.
  Read the hint!
- `syntax error at or near "="` after `FROM bugsWHERE status`: the parser took `bugsWHERE` as the table and `status`
  as an alias. The caret is after the real mistake, so look left.

## Exercise: Fix the query from the error messages

This query should list `bug_id, summary` for **NEW** bugs assigned to account **1**, oldest first (`date_reported`,
then `bug_id`). Run it, read each error (the message and the caret), fix that spot, and run again.

```sql starter
SELECT bug_id, summary
FROM bugs
WHERE (status = 'NEW' AND WHERE assigned_to = 1
ORDER date_reported, bug_id
```

```sql reference
SELECT bug_id, summary FROM bugs
WHERE status = 'NEW' AND assigned_to = 1
ORDER BY date_reported, bug_id
```

```sql solution
SELECT bug_id, summary
FROM bugs
WHERE (status = 'NEW' AND assigned_to = 1)
ORDER BY date_reported, bug_id
```

```meta
ordered: true
```

> Hint: `syntax error at or near "WHERE"`: a WHERE clause takes one boolean expression. Join conditions with `AND`, not another `WHERE`.

> Hint: `syntax error at or near "date_reported"`: what keyword usually comes between `ORDER` and a column?

> Hint: `syntax error at end of input` means something was opened and never closed. Count the parentheses.

## Exercise: The query the code built

The app glued this query together from fragments and it fails. Read the errors and fix it so it returns
`bug_id, date_reported` for **CRITICAL** bugs reported in **2022**, ordered by `bug_id`.

```sql starter
SELECT bug_id, date_reportd FROM bugsWHERE priority = 'CRITICAL'AND date_reported >= '2022-01-01'AND date_reported < '2023-01-01'ORDER BY bug_id
```

```sql reference
SELECT bug_id, date_reported FROM bugs
WHERE priority = 'CRITICAL' AND date_reported >= '2022-01-01' AND date_reported < '2023-01-01'
ORDER BY bug_id
```

```sql solution
SELECT bug_id, date_reported
FROM bugs
WHERE priority = 'CRITICAL'
  AND date_reported >= '2022-01-01'
  AND date_reported < '2023-01-01'
ORDER BY bug_id
```

```meta
ordered: true
```

> Hint: The caret on `=` is *after* the real problem. The parser read `bugsWHERE` as a table name and `priority` as its alias.

> Hint: Postgres tolerates `'CRITICAL'AND` (a literal followed by a keyword), but formatting one condition per line makes errors much easier to spot.

> Hint: Once the syntax is fixed, read the `HINT:` line of the next error, which names the column you meant.

## Quiz

### Postgres reports `syntax error at or near "BY"` with the caret on `BY`. Where's the mistake most likely?

- [ ] Always exactly at `BY`
- [x] At `BY` or just before it; the caret marks the first token the parser couldn't fit
- [ ] At the end of the statement
- [ ] Postgres error positions are random

> The parser reports where it got stuck. The cause is often the token right before that point.

### Your app's query returns nothing and the user sees a blank page. What should you look at first?

- [ ] The code that concatenates the query
- [x] The error the driver returned and the exact SQL text the server received
- [ ] The table's row count
- [ ] Restart the database

> Read the error and the real SQL first. They usually explain the problem right away.

### Which is the most robust way for code to detect a duplicate-key error?

- [ ] Search the message for the word "duplicate"
- [x] Check the error's SQLSTATE code, `23505`
- [ ] Count rows before and after the insert
- [ ] Ignore it and retry

> Message text changes with version and language. SQLSTATE codes are stable.
