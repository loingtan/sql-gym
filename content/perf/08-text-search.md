---
title: Searching inside text
part: Indexes
concept: Trigrams and tsvector | `LIKE '%word%'` can never use a B-tree. GIN indexes on trigrams (substring) or tsvector (words) make text search fast.
---

## The pattern a B-tree can't help

`body ILIKE '%overheating%'` must examine every row: with a leading `%`, there is no prefix to seek to in a
sorted index. On 100,000 reviews it costs about 130 ms, and it grows linearly forever.

Postgres has two index types made for text, both using **GIN** (Generalized Inverted Index), which maps
each token to the rows containing it.

## pg_trgm: substrings

The `pg_trgm` extension splits text into **trigrams**, three-character chunks: `overheating` becomes
`ove`, `ver`, `erh`, … A GIN trigram index can serve `LIKE`/`ILIKE '%…%'`, regular expressions and
similarity (`%`, `<->`) searches, with no change to the query:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- already installed here
CREATE INDEX ON reviews USING gin (body gin_trgm_ops);

SELECT * FROM reviews WHERE body ILIKE '%overheating%';   -- now uses the index
```

The planner uses the index to find candidate rows, then rechecks the actual pattern on them
(`Recheck Cond` in the plan). Patterns shorter than three characters can't use it.

## Full-text search: words

For "find reviews about *this topic*" rather than "containing this substring", full-text search is
the right tool. A `tsvector` is the document reduced to normalized word stems; a `tsquery` is the question.

```sql
CREATE INDEX ON reviews USING gin (to_tsvector('english', body));

SELECT id, body FROM reviews
WHERE to_tsvector('english', body) @@ to_tsquery('english', 'waterproof & durable');
```

Stemming means `overheating`, `overheated` and `overheat` all match `overheat`. Stop words (`the`, `is`)
are dropped. The query's expression must match the index's expression exactly, including the
`'english'` configuration. Add `ts_rank` to order by relevance, or store the tsvector in a generated
column to avoid recomputing it.

## Which one?

- Substring of anything (SKUs, codes, partial names, typos): **pg_trgm**.
- Natural-language search with stemming and ranking: **tsvector**.
- Prefix only (`'abc%'`): a plain B-tree with `text_pattern_ops` is enough.

## Exercise: Reviews that mention overheating

Count reviews whose body contains `overheating` (case-insensitive), at least 10× faster than the baseline,
with no Seq Scan on `reviews`.

```sql baseline
SELECT count(*) FROM reviews WHERE body ILIKE '%overheating%'
```

```sql solution-setup
CREATE INDEX ON reviews USING gin (body gin_trgm_ops);
```

```sql solution
SELECT count(*) FROM reviews WHERE body ILIKE '%overheating%';
```

```meta
speedup: 10
forbid: Seq Scan on reviews
require: gin | Use a GIN index
```

> Hint: A B-tree on `body` won't help with a leading `%`. You need the trigram operator class.

> Hint: `CREATE INDEX ON reviews USING gin (body gin_trgm_ops);` The query stays the same.

## Exercise: Full-text: waterproof and durable

Return the ids of reviews that contain both the words *waterproof* and *durable* using full-text search,
10× faster than the LIKE baseline. (The reference uses the same tsquery, so stemming is accounted for.)

```sql baseline
SELECT id FROM reviews
WHERE to_tsvector('english', body) @@ to_tsquery('english', 'waterproof & durable')
```

```sql starter
SELECT id FROM reviews
WHERE to_tsvector('english', body) @@ to_tsquery('english', 'waterproof & durable');
```

```sql solution-setup
CREATE INDEX ON reviews USING gin (to_tsvector('english', body));
```

```sql solution
SELECT id FROM reviews
WHERE to_tsvector('english', body) @@ to_tsquery('english', 'waterproof & durable');
```

```meta
speedup: 10
forbid: Seq Scan on reviews
require: to_tsvector | Use a tsvector (full-text) index
```

> Hint: Index the exact expression the query uses: `to_tsvector('english', body)`.

> Hint: `CREATE INDEX ON reviews USING gin (to_tsvector('english', body));`

## Quiz

### Why can't a B-tree index serve `WHERE body LIKE '%heat%'`?

- [x] The pattern has no fixed prefix, so there is no starting point in the sorted index
- [ ] B-trees don't store text
- [ ] LIKE is never indexable
- [ ] The column is too long

> Sorted order only helps when you know how the value *starts*.

### What does a GIN trigram index store?

- [ ] The full text, sorted
- [x] Every three-character chunk of each value, mapped to the rows containing it
- [ ] Word stems in English
- [ ] A hash of each row

> It's an inverted index: from chunk to rows. Any substring of 3+ characters decomposes into chunks the index knows.

### `to_tsvector('english', body) @@ to_tsquery('english', 'overheat')` matches a review saying "it overheated". Why?

- [ ] Because of a typo tolerance setting
- [x] Full-text search stems words, so `overheated` and `overheat` share the stem
- [ ] It doesn't match
- [ ] Because `@@` means LIKE

> Stemming reduces words to a root. It is why tsvector search feels like search and LIKE feels like grep.
