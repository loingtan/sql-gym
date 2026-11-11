---
title: Poor Man's Search Engine
part: Queries
concept: Full-text search | LIKE '%word%' matches characters, not words, and scans every row. Use tsvector and tsquery with a GIN index.
---

## Objective

Search text for **words**: find the knowledge-base articles about a crash, whatever form the word takes
and wherever it appears.

## The antipattern: pattern-matching predicates

The tool everyone knows is `LIKE` with wildcards, or a regular expression:

```sql
SELECT * FROM search_kb WHERE title LIKE '%crash%';
SELECT * FROM search_kb WHERE body ~* '\mcrash\M';     -- regex with word boundaries
```

Two problems come with it.

- **Performance.** A pattern that starts with `%` cannot use a B-tree index, so every search reads and
  tests every row. It works on ten articles and falls over on ten million.
- **Wrong matches.** `LIKE` compares characters. `'%crash%'` finds `crashpad` (not a crash), and misses
  `Crash` and `CRASHES` because it is case-sensitive. `'%print%'` finds `blueprint`. `ILIKE` fixes the
  case, a word-boundary regex fixes the substrings, and neither knows that *crashed* and *crashing* are
  forms of the same word.

## How to recognize it

- "How do I put a variable between two wildcards in a LIKE?"
- "Can a regex check for several words, in any order, and exclude another?"
- "The search page times out now that we have more data."

## Legitimate uses

A filter that runs rarely or on a small table does not need search infrastructure. `LIKE 'abc%'` with a
fixed prefix is index-friendly and fine. Pattern matching is also right when you really are looking for
a character sequence, such as a part number.

## Solution: use the right tool for the job

Postgres has full-text search built in. A **tsvector** is a document reduced to normalized word stems
with positions. A **tsquery** is a search condition. `@@` tests one against the other.

```sql
SELECT to_tsvector('english', 'The editor CRASHED while printing');
-- 'crash':3 'editor':2 'print':5        stop words dropped, words stemmed and lowercased

SELECT article_id, title
FROM search_kb
WHERE to_tsvector('english', title || ' ' || body) @@ to_tsquery('english', 'crash');
```

Query syntax in `to_tsquery`: `&` and, `|` or, `!` not, `<->` followed by, `crash:*` prefix.
`websearch_to_tsquery` accepts what people type into a search box: `crash -print`, `"print preview"`,
`slow or blank`.

Make it fast with a GIN index on the same expression, or on a stored generated column:

```sql
ALTER TABLE search_kb ADD COLUMN search tsvector
  GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body)) STORED;
CREATE INDEX ON search_kb USING gin (search);
```

Order results by relevance with `ts_rank(search, query)`, and weight the title above the body with
`setweight(to_tsvector(title), 'A') || setweight(to_tsvector(body), 'B')`.

When you do need substring or typo-tolerant matching, the `pg_trgm` extension gives `LIKE '%…%'` and
similarity search a GIN index. For large-scale or multilingual search with facets, a dedicated engine
(Elasticsearch, OpenSearch, Meilisearch) fed from the database is the next step.

## Exercise: Articles about crashes

Return the `article_id` of every article in `search_kb` that mentions a crash in its title or body, in
any form (*crash, crashes, crashed, crashing*, any letter case). The `crashpad` uploader article is not
about a crash.

```sql starter
SELECT article_id
FROM search_kb
WHERE title LIKE '%crash%';
```

```sql reference
SELECT article_id
FROM search_kb
WHERE to_tsvector('english', title || ' ' || body) @@ to_tsquery('english', 'crash')
```

```sql solution
SELECT article_id
FROM search_kb
WHERE to_tsvector('english', title || ' ' || body) @@ to_tsquery('english', 'crash')
ORDER BY article_id;
```

```meta
require: @@ | Use full-text search (the @@ operator)
```

> Hint: The starter misses "Crash", "CRASHES" and the article whose body says "crashed", and it wrongly includes "crashpad".

> Hint: `to_tsvector('english', title || ' ' || body) @@ to_tsquery('english', 'crash')` compares word stems.

## Exercise: Crash, but not printing

Support wants the crash articles that have nothing to do with printing. Return the `article_id`s that
match the search-box query `crash -print`. Note what happens to the *blueprint* article.

```sql starter
SELECT article_id
FROM search_kb
WHERE (title || ' ' || body) ILIKE '%crash%'
  AND (title || ' ' || body) NOT ILIKE '%print%';
```

```sql reference
SELECT article_id
FROM search_kb
WHERE to_tsvector('english', title || ' ' || body) @@ websearch_to_tsquery('english', 'crash -print')
```

```sql solution
SELECT article_id
FROM search_kb
WHERE to_tsvector('english', title || ' ' || body) @@ websearch_to_tsquery('english', 'crash -print')
ORDER BY article_id;
```

```meta
require: to_tsquery | Build the condition with websearch_to_tsquery or to_tsquery
```

> Hint: `NOT ILIKE '%print%'` throws out the blueprint article, because "blueprint" contains "print".

> Hint: `websearch_to_tsquery('english', 'crash -print')` is the same as `to_tsquery('english', 'crash & !print')`.

## Quiz

### Why does `WHERE title LIKE '%crash%'` return the "crashpad uploader" article?

- [ ] LIKE is case-insensitive
- [x] LIKE matches a sequence of characters anywhere, with no idea of word boundaries
- [ ] The article is tagged as a crash
- [ ] Because of the index

> Substring matching finds "crash" inside "crashpad", and "print" inside "blueprint".

### What does `to_tsvector('english', 'Crashes were reported')` contain?

- [ ] The three words as typed
- [x] The stems `crash` and `report`, with positions; "were" is dropped as a stop word
- [ ] A hash of the sentence
- [ ] Trigrams such as `cra`, `ras`, `ash`

> Lowercasing, stemming and stop-word removal are what make different forms of a word match.

### Which index makes `tsvector @@ tsquery` fast?

- [ ] B-tree
- [ ] Hash
- [x] GIN
- [ ] BRIN

> GIN is an inverted index: from each word stem to the rows that contain it.
