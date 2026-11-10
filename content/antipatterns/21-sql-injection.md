---
title: SQL Injection
part: Application Development
concept: Values in, never code | Pass values as bind parameters; build identifiers only from an allow-list or format('%I').
---

## Objective

Write **dynamic SQL**: queries whose values (and sometimes columns or sort order) come from the application
at run time. That's normal and necessary.

## The antipattern: execute unverified input as code

The bug appears when you paste input into the SQL **text** before the server parses it:

```python
sql = f"SELECT * FROM products WHERE product_name = '{name}'"   # UNSAFE
```

An honest `O'Hare` already breaks it (syntax error). A chosen input changes what the statement means:
`123 OR TRUE` turns `WHERE account_id = {id}` into "every account". One quote in a login form can
comment out the password check. The attacker's string becomes part of your program.

The "cures" people reach for each cover only part of the problem:

- **Escaping quotes** protects string literals, but not a number pasted without quotes, and it's easy to forget once.
- **Stored procedures** are only as safe as the SQL inside them. `EXECUTE 'UPDATE ... WHERE id = ' || p_id` in PL/pgSQL is the same bug.
- **Frameworks** help only if you use their placeholders. Any API that accepts a SQL string accepts a concatenated one.

## How to recognize it

Any SQL built by concatenation or interpolation (`+`, `||`, f-strings, `format()` with `%s`) that contains
data from outside the code: request parameters, files, other services, or **values read back from your own
database** (second-order injection). Assume it is there until a review proves otherwise.

## Legitimate uses

None. There is no good reason to let input change the syntax of a statement.

## Solution: trust no one

**Bind parameters for values.** The server parses the statement first, then receives values separately.
Nothing in a value can change the syntax:

```sql
PREPARE find_product(text) AS SELECT * FROM products WHERE product_name = $1;
EXECUTE find_product('O''Hare');
```

Drivers do this for you (`$1` in node-postgres and libpq, `%s` in psycopg). For a list, bind one array
instead of building `IN (...)`: `WHERE bug_id = ANY($1::bigint[])`.

**Identifiers and keywords can't be parameters.** Map user choices to a fixed set you wrote:
`{"date": "date_reported", "status": "status"}` and `{"up": "ASC", "down": "DESC"}`, with a default for anything else.

**Inside PL/pgSQL**, use `format()` and `EXECUTE ... USING`:

```sql
EXECUTE format('SELECT count(*) FROM bugs WHERE %I = $1', col)  -- %I quotes an identifier
USING val;                                                       -- value bound, not pasted
```

`%L` / `quote_literal()` quote a value correctly when you really must inline it, for example to give the planner
a literal on a skewed column. `%s` inserts raw text, so it is not safe for input.

**Filter** what you can: cast numbers (`int(x)`), reject what doesn't match a strict pattern, and have someone
else review every place SQL is assembled.

## Mini-antipattern: query parameters inside quotes

`WHERE summary LIKE '%$1%'` doesn't use a parameter. `$1` sits inside a string literal, so it's just
the three characters `$1`. A placeholder is its own token and stands for a whole value:

```sql
WHERE summary LIKE '%' || $1 || '%'      -- or pass '%word%' as the parameter
```

## Exercise: Log in as admin without the password

The app's login query pastes the username straight into the SQL. The password check can never be true
(`password_hash = 'x'`). Type a **username** that makes the unsafe query return the admin's row
(`account_id, account_name`). Then compare with the safe version shown below the result, which binds your
input as `$1`.

```sql template
SELECT account_id, account_name FROM accounts WHERE account_name = '{{input}}' AND password_hash = 'x'
```

```sql reference
SELECT account_id, account_name FROM accounts WHERE account_id = 1
```

```sql solution
admin' --
```

```meta
kind: inject
```

> Hint: Your input is placed between two single quotes. What happens if your input contains a quote of its own?

> Hint: `--` starts a comment that runs to the end of the line, so anything the app adds after your input is ignored.

> Hint: With a bind parameter the whole input is one value, so no account has that strange name and nothing is returned.

## Exercise: Dynamic filters, the safe way

A report lets the user choose a column and a value. In Setup, write a PL/pgSQL function `bug_count(col text, val text)
RETURNS bigint` that counts bugs where that column equals the value. Build the SQL with `format('%I')` and bind the
value with `EXECUTE ... USING`. Then return `bug_count('status', 'NEW'), bug_count('priority', 'HIGH')`.

```sql starter-setup
CREATE FUNCTION bug_count(col text, val text) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  EXECUTE 'SELECT count(*) FROM bugs WHERE ' || col || ' = ''' || val || '''' INTO n;  -- UNSAFE
  RETURN n;
END $$;
```

```sql starter
SELECT bug_count('status', 'NEW'), bug_count('priority', 'HIGH');
```

```sql reference
SELECT (SELECT count(*) FROM bugs WHERE status = 'NEW'),
       (SELECT count(*) FROM bugs WHERE priority = 'HIGH')
```

```sql solution-setup
CREATE FUNCTION bug_count(col text, val text) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  IF col NOT IN ('status', 'priority', 'summary') THEN
    RAISE EXCEPTION 'column % is not allowed', col;
  END IF;
  EXECUTE format('SELECT count(*) FROM bugs WHERE %I = $1', col) INTO n USING val;
  RETURN n;
END $$;
```

```sql solution
SELECT bug_count('status', 'NEW'), bug_count('priority', 'HIGH');
```

```meta
require: %I | Quote the column with format('%I', ...)
require: \bUSING\b | Bind the value with EXECUTE ... USING
```

> Hint: `format('... WHERE %I = $1', col)` quotes `col` as an identifier. `$1` stays a placeholder.

> Hint: `EXECUTE sql INTO n USING val;` sends `val` as a bound value, so a quote in it can't end the string.

> Hint: An allow-list (`IF col NOT IN (...) THEN RAISE EXCEPTION`) is still a good idea. `%I` stops injection but not "filter on a column we never meant to expose".

## Quiz

### Why can't a bind parameter be injected?

- [ ] The driver escapes quotes very carefully
- [x] The statement is parsed before the value arrives, so the value can only ever be one value
- [ ] Postgres rejects values that contain SQL keywords
- [ ] Parameters are always cast to integers

> Parsing happens first. Afterwards nothing can change the statement's syntax.

### You need a user-chosen sort column. What's safe?

- [ ] Bind it as `ORDER BY $1`
- [ ] Escape quotes in it and paste it in
- [x] Look it up in a fixed map of allowed columns (or quote it with `format('%I')` after an allow-list check)
- [ ] Put the query in a stored procedure

> `ORDER BY $1` sorts by a constant. Identifiers must come from code you control.

### Which PL/pgSQL line is vulnerable?

- [ ] `EXECUTE format('SELECT * FROM t WHERE %I = $1', c) USING v;`
- [x] `EXECUTE 'SELECT * FROM t WHERE name = ''' || v || '''';`
- [ ] `EXECUTE format('SELECT * FROM t WHERE name = %L', v);`
- [ ] `SELECT * FROM t WHERE name = v;`

> Concatenating `v` into the text lets a quote in `v` end the literal. `%L` quotes it, `USING` binds it, and static SQL uses the variable directly.

### Why does `WHERE summary LIKE '%$1%'` find nothing?

- [ ] `LIKE` can't be used with parameters
- [x] `$1` inside quotes is literal text, not a placeholder
- [ ] The parameter must be cast to `text` first
- [ ] `%` is not a wildcard in Postgres

> Write `LIKE '%' || $1 || '%'` or pass the whole pattern as the parameter.
