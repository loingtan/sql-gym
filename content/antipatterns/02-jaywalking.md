---
title: Jaywalking
part: Logical Database Design
concept: Intersection table | One row per (product, account) pair. Equality, joins, COUNT and foreign keys all work again.
---

## Objective

Store a **multivalue attribute**. A product started with one contact (`account_id` pointing at `accounts`).
Now a product can have *several* contacts, and the schema has to follow.

## The antipattern: a comma-separated list

The "smallest change" is to turn `account_id` into a `varchar` and store `'12,34'` in it. No new table,
no migration of the code that reads one row per product. It looks like a win, and every query after
that pays for it:

- **Finding products for account 12** needs pattern matching instead of `=`. `LIKE '%12%'` also matches
  `112`, `120` and `212`. A correct regex is fiddly, and no B-tree index can help it, so it's a full scan every time.
- **Joining to `accounts`** means matching a regex built from every account id against every product:
  a cross product evaluated row by row.
- **Counting contacts** turns into string tricks such as
  `length(account_id) - length(replace(account_id, ',', '')) + 1`, which are wrong for `''`, `NULL` and duplicates.
- **Updating** one entry means reading the string, editing it in application code and writing it back.
- **Validation is gone.** A foreign key checks a whole column value, not the pieces of a string, so
  `'9,banana'` is happily accepted.
- **The separator** may appear inside a value someday, and **the list length** is capped by the `varchar(n)` you guessed.

```sql
-- Looks right, returns wrong rows (112, 120, 212...)
SELECT * FROM jaywalk_products WHERE account_id LIKE '%12%';
```

## How to recognize it

- "What is the maximum number of entries this list must hold?" (you are sizing a `varchar`)
- "How do I match a word boundary in SQL?" (you are parsing strings that should be rows)
- "Which character will never appear in an entry?" (you are choosing a separator)

## Legitimate uses

Denormalized lists are fine when the database **never looks inside them**: you receive a CSV string
from somewhere, store it, and hand it back unchanged. Postgres arrays (`int[]`) fix some problems (typed
elements, `= ANY(...)`, GIN indexes) but still give up foreign keys. Start normalized, and denormalize
only with measurements in hand.

## Solution: create an intersection table

Store each value on its own row in a table that references both sides, an **intersection table**
(also called a join, mapping or many-to-many table):

```sql
CREATE TABLE contacts (
  product_id bigint NOT NULL REFERENCES products(product_id),
  account_id bigint NOT NULL REFERENCES accounts(account_id),
  PRIMARY KEY (product_id, account_id)
);

SELECT p.* FROM products p JOIN contacts c USING (product_id) WHERE c.account_id = 12;
SELECT product_id, count(*) FROM contacts GROUP BY product_id;
```

Every problem above disappears. Lookups use equality and indexes, both directions are a simple join,
aggregates are plain `COUNT`, adding or removing a contact is one `INSERT` or `DELETE`, the foreign key
rejects `banana`, the primary key rejects duplicates, and there is no length limit or separator.

## Mini-antipattern: splitting CSV into rows

Postgres can split a list at query time with `unnest(string_to_array(col, ','))` (or `string_to_table`).
That is great for a **one-time migration** into an intersection table. If you split the string on every
query, the antipattern is still there.

## Exercise: Products for account 12

The table `jaywalk_products` stores contacts as a comma-separated `account_id` string.
Return `product_id, product_name` for every product whose list contains account **12**, and nothing else.

Watch out for `112`, `120`, `212`, a stray space after a comma, and a `banana` that will break any cast to integer.

```sql starter
SELECT product_id, product_name
FROM jaywalk_products
WHERE account_id LIKE '%12%';
```

```sql reference
SELECT product_id, product_name
FROM jaywalk_products
WHERE account_id ~ '(^|,)\s*12\s*(,|$)'
```

```sql solution
SELECT product_id, product_name
FROM jaywalk_products
WHERE '12' = ANY (string_to_array(replace(account_id, ' ', ''), ','));
```

> Hint: Compare whole list *elements*, not substrings. `string_to_array(text, ',')` gives you a `text[]`.

> Hint: Compare as text (`'12' = ANY (...)`) so `banana` doesn't cause a cast error. `replace(account_id, ' ', '')` handles the space.

## Exercise: Fix it with an intersection table

Create a `contacts` intersection table with foreign keys and a composite primary key, migrate the
CSV data into it (skip garbage, drop duplicates), then **using `contacts`** list every product with its
number of contacts as `product_id, contacts`. Products without contacts must show `0`.

```sql starter-setup
CREATE TABLE contacts (
  -- product_id ... REFERENCES ...
  -- account_id ... REFERENCES ...
  -- PRIMARY KEY (...)
);

-- INSERT INTO contacts ... SELECT ... FROM jaywalk_products, unnest(string_to_array(...)) ...
```

```sql starter
SELECT p.product_id, 0 AS contacts
FROM jaywalk_products p;
```

```sql reference
SELECT p.product_id, count(DISTINCT trim(t.id)) AS contacts
FROM jaywalk_products p
LEFT JOIN LATERAL unnest(string_to_array(p.account_id, ',')) AS t(id) ON trim(t.id) ~ '^\d+$'
GROUP BY p.product_id
```

```sql solution-setup
CREATE TABLE contacts (
  product_id bigint NOT NULL REFERENCES jaywalk_products(product_id),
  account_id bigint NOT NULL REFERENCES accounts(account_id),
  PRIMARY KEY (product_id, account_id)
);

INSERT INTO contacts (product_id, account_id)
SELECT DISTINCT p.product_id, trim(t.id)::bigint
FROM jaywalk_products p, unnest(string_to_array(p.account_id, ',')) AS t(id)
WHERE trim(t.id) ~ '^\d+$';
```

```sql solution
SELECT p.product_id, count(c.account_id) AS contacts
FROM jaywalk_products p
LEFT JOIN contacts c USING (product_id)
GROUP BY p.product_id
ORDER BY p.product_id;
```

```meta
require: (join|from)\s+contacts | Answer the question from the new contacts table
```

> Hint: `unnest(string_to_array(account_id, ','))` turns one row per product into one row per list entry. Filter with `trim(x) ~ '^\d+$'`.

> Hint: `SELECT DISTINCT` during the migration avoids a primary-key violation on product 10 (`'5,5'`).

> Hint: `count(*)` counts the NULL row a LEFT JOIN produces for a product with no contacts. Count a column from `contacts` instead.

## Quiz

### Why can't a B-tree index speed up `WHERE account_id LIKE '%12%'`?

- [ ] Because `account_id` is a `varchar`, not an integer
- [x] Because the pattern starts with a wildcard, so there is no prefix to seek to in the sorted index
- [ ] Because B-tree indexes don't support `LIKE` at all
- [ ] Because the table is too small

> A B-tree is sorted by the whole value, so it can find values that *start with* something. A leading `%` means any position, so every entry must be checked.

### Which of these does an intersection table give you that a comma-separated list cannot?

- [ ] Fewer tables in the schema
- [x] A foreign key on every single contact
- [ ] Faster inserts of a whole list at once
- [ ] Storing the list in exactly the order the user typed it

> Foreign keys validate whole column values. Once each contact is its own row, each one can be checked against `accounts`.

### When is storing a comma-separated string acceptable?

- [ ] When you need to count the entries per row
- [ ] When you search by individual entries, but rarely
- [x] When you only store and return the string unchanged and never query inside it
- [ ] When the list is guaranteed to have fewer than 10 entries

> It's legitimate when the database treats the value as opaque. The moment you query its parts, it should be rows.
