---
title: ID Required
part: Logical Database Design
concept: A key is a constraint, not a column named id | Put the primary key on the columns that identify a row. An intersection table's key is the pair itself.
---

## Objective

Give every table a **primary key**: it keeps duplicate rows out, lets you address one row, and is what
foreign keys point at. Often no natural column is reliably unique, so you add an artificial one, a
**surrogate key** (pseudokey). In Postgres the standard way is an identity column:

```sql
CREATE TABLE bugs (
  bug_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  summary varchar(80)
);
INSERT INTO bugs (summary) VALUES ('Crash on save') RETURNING bug_id;
```

`serial`/`bigserial` still work but are a legacy shortcut (a loose sequence plus a default). Identity
columns are SQL-standard, owned by the column, and `GENERATED ALWAYS` rejects hand-typed values unless you
say `OVERRIDING SYSTEM VALUE`. `RETURNING` hands back the new key, so you never need `MAX(id) + 1`.

## The antipattern: one size fits all

Frameworks and tutorials made this a reflex: every table gets a column named `id`, an auto-generated integer,
as its primary key. Applied blindly, it hurts in several ways.

- **A redundant key.** The table already has a unique identifier (`bug_code 'VIS-078'`, declared `UNIQUE`), and
  `id` sits next to it doing the same job.
- **Duplicate rows.** In an intersection table, the primary key should be the *pair*. With `id` as the key,
  nothing stops the same pair from being stored three times:

  ```sql
  CREATE TABLE idreq_article_tags (
    id         serial PRIMARY KEY,
    article_id int NOT NULL REFERENCES idreq_articles(id),
    tag_id     int NOT NULL REFERENCES idreq_tags(id)
  );
  INSERT INTO idreq_article_tags (article_id, tag_id) VALUES (3, 1), (3, 1), (3, 1);  -- accepted
  ```

  Every count and sum through that table is now inflated. Adding `UNIQUE (article_id, tag_id)` fixes it, and
  then `id` has no job left.
- **A meaningless name.** `SELECT b.id, a.id FROM bugs b JOIN accounts a ON b.assigned_to = a.id` returns two
  columns called `id`. Drivers that build objects or JSON by column name keep only one of them. You end up
  aliasing everything.
- **No `USING`.** When the key and the foreign key share a name, `JOIN bug_products USING (bug_id)` is short
  and merges the column. If every key is `id`, the foreign key can never have the same name, so it's `ON` forever.

Some developers also skip compound keys because they need more typing. That's like refusing two-dimensional
coordinates because one number is easier: simpler, and wrong for the data.

## How to recognize it

- Every table's primary key is literally `id`.
- "This table doesn't need a primary key." (they mean *pseudokey*; every table needs *a* key)
- "How did I get duplicate many-to-many links?" (the key isn't on the pair)
- "I don't want to normalize, I'd have to join to an id every time." (normalization isn't about pseudokeys)

Without any key, you inherit a chore: `SELECT bug_id FROM bugs GROUP BY bug_id HAVING count(*) > 1`, forever.
In Postgres a table without a primary key also can't publish `UPDATE`/`DELETE` through logical replication
unless you set `REPLICA IDENTITY FULL`, which makes the subscriber scan the table for each change.

## Legitimate uses

Surrogate keys are a good tool. Use one when the natural key is long (a file path), when it can change or
turns out not to be unique after all, or when a chain of child tables would otherwise inherit an ever-growing
compound key. If an ORM expects an `id` column and following it buys you real features, that's a fair trade.
Just know it's a convention, not a rule of relational design.

## Solution: tailored to fit

A primary key is a **constraint**, declared on whatever column or columns identify a row. Identity
generation is a separate feature: you can have one without the other.

- **Name keys after what they identify**: `bug_id`, `account_id`. Name foreign keys after the key they
  reference, or after their role when that reads better (`reported_by REFERENCES accounts(account_id)`).
- **Use natural keys** when a value is truly unique, stable and non-null (`bug_status.status`, an ISO code).
- **Use compound keys** when the combination is what's unique, as in every intersection table:

```sql
CREATE TABLE bugs_products (
  bug_id     bigint NOT NULL REFERENCES bugs(bug_id),
  product_id bigint NOT NULL REFERENCES products(product_id),
  PRIMARY KEY (bug_id, product_id)
);
INSERT INTO bugs_products VALUES (1234, 1), (1234, 1);   -- ERROR: duplicate key value

SELECT * FROM bugs JOIN bugs_products USING (bug_id);
```

To migrate data that already has duplicates, copy `SELECT DISTINCT` pairs, or use
`INSERT ... ON CONFLICT DO NOTHING` to skip rows the key rejects.

## Mini-antipattern: is a BIGINT big enough?

Do the arithmetic. A 32-bit `integer` tops out at 2,147,483,647: at 10,000 inserts a minute that's gone in
about 149 days. Postgres has no unsigned types, and note that **`serial` is a 32-bit `integer`**. A `bigint`
(up to 9.2 × 10¹⁸) at the same rate lasts about 1.75 billion years. Use `bigint` identity columns and stop
worrying. (Gaps from rolled-back transactions and sequence caching are normal and harmless.)

## Exercise: Articles per tag

The intersection table `idreq_article_tags` has a surrogate `id` as its only key, and duplicate links crept in.
Without changing any table, report every tag as `tag, articles, total_words`: the number of **distinct**
articles with that tag and the sum of their `word_count`, each article counted once per tag.

```sql starter
SELECT t.tag, count(*) AS articles, sum(a.word_count) AS total_words
FROM idreq_article_tags at
JOIN idreq_tags t ON t.id = at.tag_id
JOIN idreq_articles a ON a.id = at.article_id
GROUP BY t.tag;
```

```sql reference
SELECT t.tag, count(*), sum(a.word_count)
FROM idreq_tags t
JOIN idreq_articles a ON EXISTS (SELECT 1 FROM idreq_article_tags x WHERE x.tag_id = t.id AND x.article_id = a.id)
GROUP BY t.tag
```

```sql solution
SELECT t.tag, count(*) AS articles, sum(a.word_count) AS total_words
FROM (SELECT DISTINCT article_id, tag_id FROM idreq_article_tags) at
JOIN idreq_tags t ON t.id = at.tag_id
JOIN idreq_articles a ON a.id = at.article_id
GROUP BY t.tag;
```

> Hint: Look at the economy rows: `SELECT article_id, count(*) FROM idreq_article_tags WHERE tag_id = 1 GROUP BY 1`.

> Hint: `count(DISTINCT article_id)` fixes the count, but `sum(DISTINCT word_count)` is wrong: two different economy articles both have 800 words.

> Hint: Remove the duplicate *pairs* before joining: `FROM (SELECT DISTINCT article_id, tag_id FROM idreq_article_tags) at`.

## Exercise: Key the pair, not an id

Fix the design. Create an intersection table `article_tags (article_id, tag_id)` whose **primary key is the
pair**, with foreign keys to `idreq_articles` and `idreq_tags`, and no `id` column. Copy the existing links
into it (the key will reject the duplicates, so deal with them). Then answer the same report,
`tag, articles, total_words`, **from `article_tags`** with a plain `count(*)` and `sum()`.

```sql starter-setup
CREATE TABLE article_tags (
  -- article_id ... REFERENCES ...
  -- tag_id     ... REFERENCES ...
  -- PRIMARY KEY (...)
);

-- INSERT INTO article_tags ... SELECT ... FROM idreq_article_tags ...
```

```sql starter
SELECT t.tag, count(*) AS articles, sum(a.word_count) AS total_words
FROM idreq_article_tags at
JOIN idreq_tags t ON t.id = at.tag_id
JOIN idreq_articles a ON a.id = at.article_id
GROUP BY t.tag;
```

```sql reference
SELECT t.tag, count(*), sum(a.word_count)
FROM idreq_tags t
JOIN idreq_articles a ON EXISTS (SELECT 1 FROM idreq_article_tags x WHERE x.tag_id = t.id AND x.article_id = a.id)
GROUP BY t.tag
```

```sql solution-setup
CREATE TABLE article_tags (
  article_id int NOT NULL REFERENCES idreq_articles(id),
  tag_id     int NOT NULL REFERENCES idreq_tags(id),
  PRIMARY KEY (article_id, tag_id)
);

INSERT INTO article_tags (article_id, tag_id)
SELECT article_id, tag_id FROM idreq_article_tags
ON CONFLICT DO NOTHING;
```

```sql solution
SELECT t.tag, count(*) AS articles, sum(a.word_count) AS total_words
FROM article_tags at
JOIN idreq_tags t ON t.id = at.tag_id
JOIN idreq_articles a ON a.id = at.article_id
GROUP BY t.tag;
```

```meta
require: primary\s+key\s*\(\s*(article_id\s*,\s*tag_id|tag_id\s*,\s*article_id)\s*\) | Declare PRIMARY KEY (article_id, tag_id)
require: (from|join)\s+article_tags\b | Answer the question from the new article_tags table
```

> Hint: `PRIMARY KEY (article_id, tag_id)` goes inside `CREATE TABLE`, after the column definitions.

> Hint: A plain `INSERT ... SELECT` fails on the first duplicate. Use `SELECT DISTINCT article_id, tag_id`, or append `ON CONFLICT DO NOTHING`.

> Hint: Notice you still have to write `ON t.id = at.tag_id`: with the parent key named `id`, `JOIN idreq_tags USING (tag_id)` is impossible.

## Quiz

### An intersection table has `id serial PRIMARY KEY, bug_id, product_id`. What does that primary key prevent?

- [ ] Linking the same bug to the same product twice
- [x] Only two rows with the same `id`, which the sequence never produces anyway
- [ ] Linking a bug to a product that doesn't exist
- [ ] Nothing: Postgres ignores primary keys on intersection tables

> The key constrains the column it's declared on. The pair that actually needs to be unique is unconstrained, so duplicate links are accepted.

### Which statement about primary keys is true?

- [ ] A primary key must be a single integer column
- [ ] A primary key must be generated by a sequence or identity
- [x] A primary key is a constraint and can span several columns of any indexable type
- [ ] A table with a natural key should still get an `id` as its primary key

> Key and generator are independent: an identity column doesn't have to be the key, and a key doesn't have to be generated.

### Why prefer `bug_id` over `id` as the name of the bugs table's key?

- [ ] Postgres doesn't allow a column named `id`
- [x] Joined results stay unambiguous, and a foreign key with the same name lets you write `JOIN ... USING (bug_id)`
- [ ] Longer names make the index smaller
- [ ] Identity columns must end in `_id`

> Two `id` columns in one result collide in drivers that map by name, and `USING` needs the same column name on both sides.

### Your table inserts 10,000 rows a minute. What should its generated key be?

- [ ] `serial`, it's the Postgres default
- [ ] `integer`, but unsigned to double the range
- [x] `bigint GENERATED ALWAYS AS IDENTITY`
- [ ] `numeric(20)` in case `bigint` runs out

> `serial` is a 32-bit integer and would run out in about five months; Postgres has no unsigned types. A `bigint` lasts over a billion years at that rate.
