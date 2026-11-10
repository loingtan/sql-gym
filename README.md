# Query Gym

Practice SQL on a real PostgreSQL 17 with millions of rows. Two tracks:

- **Performance Lab**: 10 rounds on `perf` (1M orders, 2.5M order items, no secondary indexes). Read the
  plan, add the right index or rewrite the query, beat the baseline. Every run is timed with
  `EXPLAIN (ANALYZE, BUFFERS)` and compared to the slow version.
- **Antipatterns**: one chapter per chapter of *SQL Antipatterns, Vol. 1* (Bill Karwin), on the book's
  bug-tracker database. Theory, then exercises that make you fix the query or the schema, then a quiz.

Styled after [gonnacrash.com](https://gonnacrash.com): rounds, concept cards you unlock, a progress page.

## Run

```sh
docker compose up
```

Open <http://localhost:3000>. The first start seeds ~4M rows (10–30 s). Ports: app 3000, Postgres 5433
(`postgres` / `practice`, database `practice`), both bound to 127.0.0.1 only. Change them with
`APP_PORT` / `DB_PORT` in `.env`.

Reset everything (data and progress): `docker compose down -v`.

## How an exercise is checked

Each run executes your **Setup** (any DDL/DML: `CREATE INDEX`, `CREATE TABLE`, `INSERT`…) and then one
**Query**, inside a transaction that is always rolled back. Pass means:

- your rows equal the reference rows (column names ignored, order ignored unless the exercise says otherwise)
- plus any extra goals: minimum speedup over the baseline (median of 3 timed runs), forbidden plan nodes
  (`No Seq Scan on orders`), or required techniques (regex on your SQL).

The **SQL console** (menu) runs anything against either schema, with an *Explain analyze* button.

## Writing lessons

Lessons are Markdown in `content/perf/` and `content/antipatterns/`, hot-reloaded (the folder is mounted
into the container). Chapter-specific tables live in `db/1x-*.sql` and run on first boot; to add one to a
running database: `docker compose exec -T db psql -U postgres -d practice < db/your.sql`.

```markdown
---
title: Jaywalking
part: Logical Database Design
concept: Intersection table | one-sentence takeaway shown on the concept card
---
Theory markdown…

## Exercise: Title
Task markdown…

```sql baseline        <- the slow query; also the reference answer and the starter if none given
```sql reference       <- expected rows, when different from the baseline
```sql starter-setup / starter / solution-setup / solution
```meta
speedup: 10            <- must be N× faster than baseline
forbid: Seq Scan on orders
require: regex | message shown as the goal
ordered: true
schema: perf           <- default is the track's schema
kind: inject           <- SQL-injection lab: learner types an input for ```sql template with {{input}}
```
> Hint: shown on demand, one at a time

## Quiz
### Question?
- [x] right
- [ ] wrong
> Explanation
```

`node verify.js [id-prefix]` runs every solution through the real checker and asserts every starter fails.
Run it after editing a lesson.

## Layout

| | |
|---|---|
| `server.js` | HTTP + JSON API, no framework |
| `runner.js` | runs SQL in rolled-back transactions, times with EXPLAIN ANALYZE, compares results |
| `content.js` | parses lesson Markdown |
| `public/` | the SPA: vanilla JS, hash routes |
| `db/` | seed SQL: `01-perf` big tables, `02-bugs` the book's database, `1x-*` chapter tables |
