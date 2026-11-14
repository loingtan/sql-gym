---
title: How a pool works
part: Pooling
concept: Borrow, use, return | A pool keeps a few connections open and lends them out. When all are busy, requests queue, and give up after a timeout.
---

## The cycle

A connection pool is a small set of open connections that lives inside your application (or in a proxy
in front of the database). Think of a restaurant with a fixed number of tables.

1. **Initialise.** At startup the pool opens a minimum number of connections.
2. **Borrow.** A request asks for a connection. If one is idle, it gets it at once.
3. **Use.** The request runs its queries. The connection is *active*: nobody else can use it.
4. **Return.** The request hands the connection back. It is not closed. The pool resets it and marks it *idle*.
5. **Health check.** From time to time the pool tests idle connections and replaces dead ones (the
   database restarted, a firewall dropped the link).

Idle connections are not free: each still holds a backend process and its memory on the server. That is
the reason for an upper limit.

## The settings

```js
const pool = new Pool({
  min: 2,                         // always keep 2 connections alive
  max: 10,                        // never open more than 10 at once
  idleTimeoutMillis: 30000,       // close a connection that sat idle for 30 s
  connectionTimeoutMillis: 2000,  // how long a request may wait for a free connection
});

const res = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
// borrowed, used and returned automatically
```

Every pool has the same four knobs under different names. In Java's HikariCP they are `minimumIdle`,
`maximumPoolSize`, `idleTimeout` and `connectionTimeout`.

## When every connection is busy

A request that finds no idle connection **waits in a queue**. When someone returns a connection, the
first waiter gets it. If the wait is longer than the connection timeout, the pool gives up and throws
an error to that request.

The error is the pool doing its job. Without a timeout the queue would grow without bound while users
stare at spinners, and memory would run out. Failing fast keeps the damage small and visible.

A pool that sits at its maximum with a growing queue is telling you one of two things: it is too small
for the load, or the queries are too slow. The next round is about telling these apart. For now, size
the pool with arithmetic.

## How many connections does a load need?

If 50 requests arrive per second and each holds a connection for 0.2 seconds, then on average
50 × 0.2 = **10** connections are busy at any moment. This is **Little's Law**:

> connections in use = arrival rate × time each request holds a connection

A pool smaller than that number cannot keep up: the queue grows every second until requests time out.
A pool exactly that size has no slack for the slightest hiccup. Leave some headroom.

## Exercise: Size the pool with Little's Law

50 requests per second arrive for two seconds. Each one holds its connection for 200 ms
(`pg_sleep(0.2)` stands in for a slow endpoint). A request gives up after waiting 500 ms.
The pool has 5 connections. Run it, watch the queue in the chart, then pick a size that works
without being wasteful.

```sql request
SELECT pg_sleep(0.2)
```

```sql starter-setup
pool_max: 5
```

```sql solution-setup
pool_max: 13
```

```meta
kind: load
tunable: pool_max
rate: 50
duration_s: 2
timeout_ms: 500
goal: failed = 0 | No request times out
goal: wait_p95 <= 30 | 95% of requests wait under 30 ms for a connection
goal: pool_max <= 14 | Use at most 14 connections
```

> Hint: Arrival rate × hold time = 50 × 0.2. That many connections are busy on average.

> Hint: Exactly 10 is not enough: the real hold time is a little over 200 ms, so the pool is over 100% busy. Add headroom so it runs at about 80%.

## Quiz

### What happens to a connection when a request returns it to the pool?

- [ ] It is closed and a new one is opened
- [x] It stays open and is marked idle, ready for the next request
- [ ] It is given to the database to reuse
- [ ] It is deleted after the idle timeout, always

> Returning is cheap because nothing is torn down. Only connections that stay idle past the idle timeout are closed.

### All 10 connections are busy and a new request arrives. What does the pool do?

- [ ] Opens connection number 11
- [ ] Rejects the request immediately
- [x] Makes the request wait, and fails it if no connection frees up before the timeout
- [ ] Cancels the slowest running query

> `max` is a hard ceiling. Waiting with a deadline keeps the queue from growing forever.

### 200 requests per second, each holding a connection for 50 ms. How many connections are busy on average?

- [ ] 4
- [x] 10
- [ ] 50
- [ ] 200

> Little's Law: 200 × 0.05 = 10.
