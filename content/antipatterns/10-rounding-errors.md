---
title: Rounding Errors
part: Physical Database Design
concept: numeric for money | float, real and double precision store binary approximations. Use numeric(p,s) when values must add up and compare exactly.
---

## Objective

Store **fractional numbers** (hours worked, hourly rates, money) and do arithmetic with them. The
unspoken second goal is that the results are **correct**: the project cost report must match what the
boss gets with a calculator.

## The antipattern: use a floating-point type

`float` sounds like the natural choice for "a number with a fraction", because it's what most programming
languages use. In Postgres, `float` and `float8` mean `double precision`, and `real` (`float4`, `float(1)`
to `float(24)`) is single precision. All of them are IEEE 754 **binary** floating point.

Binary fractions can't represent most decimal fractions exactly. One third has no finite decimal form,
and in the same way `0.1` or `59.95` have no finite binary form. They are stored as the nearest value that fits:

```sql
SELECT 59.95::real::float8;              -- 59.95000076293945
SELECT 0.1::float8 + 0.2::float8;        -- 0.30000000000000004
SELECT 0.1::float8 + 0.2::float8 = 0.3;  -- false
```

Postgres prints floats in their shortest form that reads back to the same value, so a stored `59.95`
*looks* exact until you do arithmetic with it or compare it. The consequences:

- **Equality fails.** `WHERE hourly_rate = 59.95` on a `real` column finds nothing. The common workaround
  `abs(x - 59.95) < 0.000001` needs a threshold, and the right threshold depends on the magnitude of the values.
- **Errors accumulate.** `SUM()` over thousands of rows adds up all the tiny errors. `sum(real)` even keeps its running
  total in single precision, so a total in the millions is off by dollars.
- **Products compound.** Repeated multiplication, as in compound interest, multiplies the error too.

`double precision` has about 15 significant digits instead of about 6, so the error is smaller and turns up
later. It is still there, and equality comparisons still break.

## How to recognize it

- Any `float`, `real` or `double precision` column that holds **money, quantities or rates**.
- Queries with `abs(a - b) < 0.0001` instead of `a = b`.
- `round()` calls scattered through reports "to fix the cents".
- Totals that differ from the spreadsheet by a few cents or dollars.

## Legitimate uses

Floats are fast and cover a huge range, from `1e-307` to `1e308`. Use them for **measurements** that are
approximate anyway (temperatures, sensor readings, coordinates, scientific data, ML features), where you
aggregate with `avg`/`min`/`max` and filter with ranges (`BETWEEN`, `<`), never with `=`.

## Solution: use `numeric`

`numeric(p, s)` (also spelled `decimal`) stores **decimal digits exactly**: `p` digits in total, `s` of them after the
decimal point. `numeric(9,2)` holds up to `9999999.99`.

```sql
ALTER TABLE round_accounts ALTER COLUMN hourly_rate TYPE numeric(9,2)
  USING round(hourly_rate::numeric, 2);

SELECT * FROM round_accounts WHERE hourly_rate = 59.95;   -- matches now
SELECT 0.1 + 0.2 = 0.3;                                   -- true: unadorned literals are numeric
```

Postgres specifics:

- A bare decimal literal such as `59.95` is `numeric`. A float only appears when a column or cast makes one,
  and comparing a `real` column with `59.95` widens both sides to `double precision`, where they differ.
- Arithmetic on `numeric` stays exact for `+ - *`. Division still has to stop somewhere:
  `1 / 3.0` gives `0.33333333333333333333`, so `round()` where the business rule says to.
- `numeric` without `(p, s)` accepts any precision. Add precision and scale to make the column reject bad input.
- Avoid the `money` type: its output and input depend on the `lc_monetary` setting. Storing integer
  **cents** in a `bigint` is also exact and fast.
- `numeric` is slower than `float` in heavy number crunching. For business data that's rarely what limits you.

Still, `numeric` can't store one third exactly. It removes *binary* surprises, so the remaining rounding
happens where you can see it.

## Exercise: Fully paid invoices

`round_payments.amount` is `double precision`, and `round_invoices.total` is `numeric(9,2)`. Return
`invoice_id` for every invoice whose payments add up **exactly** to its total. Do the arithmetic in `numeric`.

```sql starter
SELECT i.invoice_id
FROM round_invoices i
JOIN round_payments p USING (invoice_id)
GROUP BY i.invoice_id
HAVING sum(p.amount) = i.total;
```

```sql reference
SELECT i.invoice_id
FROM round_invoices i
JOIN round_payments p ON p.invoice_id = i.invoice_id
GROUP BY i.invoice_id, i.total
HAVING round(sum(p.amount)::numeric, 2) = i.total
```

```sql solution
SELECT i.invoice_id
FROM round_invoices i
JOIN round_payments p USING (invoice_id)
GROUP BY i.invoice_id
HAVING sum(p.amount::numeric(9,2)) = i.total;
```

```meta
require: numeric | Convert the amounts to numeric
```

> Hint: `0.1 + 0.2` in `double precision` is `0.30000000000000004`, so Acme's invoice of `0.30` never matches.

> Hint: Cast each payment before adding: `sum(p.amount::numeric(9,2))`. Rounding the float sum afterwards (`round(sum(p.amount)::numeric, 2)`) works too.

> Hint: Six invoices are fully paid. Hooli and Soylent really are short.

## Exercise: Fix the column types

`round_accounts.hourly_rate` and `round_bugs.hours` were created as `real`. The project cost report
`sum(hours * hourly_rate)` is off by more than a dollar. Change **both columns** to `numeric(9,2)` with
`ALTER TABLE`, then return one column, `project_cost`: the total cost of all bugs (joined on
`round_bugs.assigned_to = round_accounts.account_id`), rounded to cents.

```sql starter-setup
-- ALTER TABLE round_accounts ALTER COLUMN hourly_rate TYPE ... USING ...;
-- ALTER TABLE round_bugs ...
```

```sql starter
SELECT round(sum(b.hours * a.hourly_rate)::numeric, 2) AS project_cost
FROM round_bugs b
JOIN round_accounts a ON a.account_id = b.assigned_to;
```

```sql reference
SELECT round(sum(round(b.hours::numeric, 2) * round(a.hourly_rate::numeric, 2)), 2) AS project_cost
FROM round_bugs b
JOIN round_accounts a ON a.account_id = b.assigned_to
```

```sql solution-setup
ALTER TABLE round_accounts ALTER COLUMN hourly_rate TYPE numeric(9,2) USING round(hourly_rate::numeric, 2);
ALTER TABLE round_bugs ALTER COLUMN hours TYPE numeric(9,2) USING round(hours::numeric, 2);
```

```sql solution
SELECT round(sum(b.hours * a.hourly_rate), 2) AS project_cost
FROM round_bugs b
JOIN round_accounts a ON a.account_id = b.assigned_to;
```

```meta
require: alter\s+table\s+round_accounts\s+alter\s+(column\s+)?hourly_rate\s+(set\s+data\s+)?type\s+(numeric|decimal) | Change round_accounts.hourly_rate to numeric with ALTER TABLE
require: alter\s+table\s+round_bugs\s+alter\s+(column\s+)?hours\s+(set\s+data\s+)?type\s+(numeric|decimal) | Change round_bugs.hours to numeric with ALTER TABLE
```

> Hint: `ALTER TABLE t ALTER COLUMN c TYPE numeric(9,2) USING round(c::numeric, 2)` rewrites the column. `USING` says how to convert each old value.

> Hint: `sum(real * real)` is computed in `real` (about 6 significant digits). Rounding the result to cents can't bring back digits that are already gone.

> Hint: With both columns `numeric(9,2)`, every product and the sum are exact. Only the final `round(..., 2)` rounds.

## Quiz

### Why does `WHERE hourly_rate = 59.95` find nothing when `hourly_rate` is `real`?

- [ ] Because `real` columns can't be compared with `=`
- [x] Because the stored value is the nearest binary fraction (59.9500007...), which differs from 59.95 when both are compared as `double precision`
- [ ] Because Postgres rounds `real` values to whole numbers
- [ ] Because the literal must be quoted

> 59.95 has no exact binary form. `real` keeps about 24 bits of it, and widening that to `double precision` shows the difference.

### Which type stores `19.99` exactly?

- [ ] `double precision`
- [ ] `real`
- [x] `numeric(9,2)`
- [ ] `float(53)`

> Only `numeric`/`decimal` stores decimal digits. `float(53)` is just another name for `double precision`.

### Where is a floating-point column a good fit?

- [ ] Invoice totals
- [ ] Account balances
- [x] Sensor temperatures that are averaged and filtered by range
- [ ] Hourly rates used for billing

> Approximate measurements with a wide range, aggregated and compared with ranges rather than `=`, are what IEEE 754 is for.

### In Postgres, what is the type of the literal `0.1` in `SELECT 0.1 + 0.2 = 0.3`?

- [ ] `real`
- [ ] `double precision`
- [x] `numeric`
- [ ] `text`

> Unadorned decimal literals are `numeric`, so this comparison is `true`. Floats only appear when a column or a cast introduces them.
