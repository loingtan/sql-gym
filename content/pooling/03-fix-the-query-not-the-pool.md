---
title: Fix the query, not the pool
part: Pooling
concept: Query time drives connection demand | Demand = arrival rate × hold time. Halve the query time and you need half the connections.
---

## Why "just raise the pool size" is the wrong reflex

The pool is exhausted, requests time out, and the first idea is always a bigger pool. Look at Little's
Law again:

> connections needed = arrival rate × time each request holds a connection

You do not control the arrival rate: that is your users. You do control how long a request holds its
connection, and that is mostly **query time**.

| Arrival rate | Hold time | Connections needed |
|---|---|---|
| 50 req/s | 20 ms | 1 |
| 50 req/s | 200 ms | 10 |
| 50 req/s | 2 s | 100 |

One slow query turns a pool of 10 from generous into hopeless. The same law read the other way gives
the ceiling of a pool:

> maximum throughput = pool size ÷ hold time

Ten connections and 10 ms queries serve 1,000 requests per second. Ten connections and 100 ms queries
serve 100. Past the ceiling, requests queue.

## Why more connections can make it worse

The database has a fixed number of CPU cores. A core runs one query at a time. With more active
connections than cores, the operating system switches between them, and every switch costs time that
does no work. Add contention for locks, memory and disk, and total throughput goes **down** as the
connection count goes up. Several engineering teams have reported the same finding: a small pool of
busy connections beats a large pool of connections taking turns.

So when a pool is exhausted, check in this order:

1. **Which queries hold connections the longest?** Fix those: add the index, rewrite the predicate,
   fetch fewer rows. Everything in the Performance Lab applies.
2. **Is a connection held while doing something else?** Calling a slow web API between two queries of
   one transaction keeps the connection busy doing nothing.
3. Only then consider the pool size, and compare it with the server's cores first (round 5).

## Exercise: The pool you are not allowed to grow

150 requests per second, a pool of **2**, and a 500 ms wait limit. The settings are fixed. The request
looks up one order, and the ORM sends the id as text, so the query casts the column and scans a million
rows each time. Run it, read the numbers, then rewrite the request so it returns the same row quickly.

```sql request
SELECT id, total FROM orders WHERE id::text = '4242'
```

```sql reference
SELECT id, total FROM orders WHERE id = 4242
```

```sql solution
SELECT id, total FROM orders WHERE id = 4242
```

```meta
kind: load
edit-query: true
pool_max: 2
rate: 150
duration_s: 2
timeout_ms: 500
goal: failed = 0 | No request times out
goal: wait_p95 <= 10 | 95% of requests wait under 10 ms for a connection
```

> Hint: Look at "Time holding it" and the Little's Law line under the numbers. How many connections does this load need, and how many are there?

> Hint: `id::text = '4242'` wraps the column in a cast, so the primary-key index can't be used (Performance Lab, round 4). Compare the bare column with a number.

## Quiz

### Requests arrive at 100 per second. An index cuts the query from 80 ms to 8 ms. How does the number of busy connections change?

- [ ] It stays the same
- [x] From 8 to 0.8
- [ ] From 80 to 8
- [ ] From 100 to 10

> 100 × 0.08 = 8, and 100 × 0.008 = 0.8. Ten times faster means ten times fewer connections.

### A pool of 20 connections, each query takes 50 ms. What is the most it can serve?

- [ ] 20 requests per second
- [ ] 100 requests per second
- [x] 400 requests per second
- [ ] 1,000 requests per second

> pool size ÷ hold time = 20 ÷ 0.05 = 400.

### Why can raising the pool from 20 to 200 on an 8-core database lower throughput?

- [ ] Postgres limits pools to 100
- [x] The cores spend time switching between 200 active processes and those processes contend for locks and memory
- [ ] The network cannot carry 200 connections
- [ ] Idle connections run slower

> Work is done by cores, not by connections. Past a point, extra connections only add switching and contention.
