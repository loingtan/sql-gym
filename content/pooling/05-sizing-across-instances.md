---
title: Sizing across instances
part: Pooling
concept: Pool size × instances ≤ max_connections | Every app instance brings its own pool. Size from the database's cores, multiply by instances, and put a proxy in front when that doesn't fit.
---

## Start from the database's cores

A database server runs as many queries at the same moment as it has CPU cores. A widely used starting
point for the number of connections that do useful work:

> pool size = (cores × 2) + effective spindles

"Spindles" are disks that can seek independently. For an SSD or a managed cloud database, count 1.
A 4-core server with SSD storage: (4 × 2) + 1 = **9** connections. The factor of 2 is there because a
query spends part of its time waiting for disk or network, and another query can use the core meanwhile.

Nine sounds tiny, and it can serve hundreds of concurrent users, because a user holds a connection only
for the few milliseconds a query runs. It is a starting point. Measure, as in rounds 2 to 4.

## Then multiply by the instances

The pool lives inside your application. Run ten copies of the application and you have ten pools:

> total connections = pool size × number of app instances

Ten instances with a pool of 20 want 200 connections. With `max_connections = 100`, the instances that
start last cannot fill their pools. Postgres does not queue them: it answers
`FATAL: sorry, too many clients already`. It tends to happen during a deploy or a scale-up, when new
instances start while the old ones still hold their connections.

So divide the budget instead of copying a number from a tutorial:

1. Decide how many connections the database should serve (cores, then measurement).
2. Leave room for everything else that connects: migrations, cron jobs, dashboards, you with `psql`.
3. Divide what remains by the largest number of instances you will run, deploys included.

Some pools open every connection at startup (HikariCP does by default, because `minimumIdle` equals
`maximumPoolSize`). Others, like node-postgres, open them on demand, which hides the problem until the
first traffic peak.

## When the budget doesn't fit: a proxy

If you need 50 instances, each can only have two connections. And **serverless** functions are worse:
every cold start is a new "instance" that opens its own connection, and hundreds can start in a second.

The answer is a pooler **between** the applications and the database: PgBouncer, RDS Proxy, Supabase
Pooler. Thousands of cheap client connections go in, a small fixed number of real Postgres connections
come out. The applications keep their pools, and the proxy multiplexes them.

## Beyond the article: three things that eat a pool

These are not in the article this track follows, and you will meet them.

- **Leaks.** Code borrows a connection and an error path never returns it. The pool shrinks by one each
  time until nothing is left. Always release in a `finally`, or use helpers that return it for you.
- **Idle in transaction.** A request runs `BEGIN`, then waits (for a web API, for a user) without
  committing. The connection is held and does nothing, and its open transaction blocks vacuum and may
  hold locks. Set `idle_in_transaction_session_timeout`.
- **PgBouncer modes.** In *session* mode a client keeps a server connection until it disconnects. In
  *transaction* mode it keeps one only for the length of a transaction, which is what makes the big
  multiplexing possible, and it means session state (`SET`, advisory locks, some prepared statements)
  does not carry over between transactions.

See who is connected right now, in the SQL console:

```sql
SELECT application_name, state, count(*)
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY 1, 2
ORDER BY 3 DESC;
```

## Exercise: Six instances, one database

Six app instances start, and each opens its whole pool at startup. Each instance then receives
40 requests per second that hold a connection for 100 ms. The database allows 100 connections. Someone
copied `pool_max: 20` from a tutorial. Run it and read the first error. Then choose a pool size that
serves the load, lets every instance start, and leaves at least 40 connections for everything else.

```sql request
SELECT pg_sleep(0.1)
```

```sql starter-setup
pool_max: 20      # per instance
```

```sql solution-setup
pool_max: 6
```

```meta
kind: load
tunable: pool_max
instances: 6
warm: true
rate: 40
duration_s: 2
timeout_ms: 1000
goal: refused = 0 | Postgres refuses no connection
goal: failed = 0 | No failed requests
goal: total_pool <= 60 | All pools together use at most 60 connections
goal: wait_p95 <= 20 | 95% of requests wait under 20 ms for a connection
```

> Hint: 6 instances × 20 = 120 connections, and the server allows 100.

> Hint: Per instance, Little's Law says 40 × 0.1 = 4 busy on average. Add headroom to stay near 70%.

> Hint: Check the total as well: pool size × 6 must stay at or under 60.

## Quiz

### A 4-core database on SSD storage. What does the cores formula suggest as a starting pool size?

- [ ] 4
- [x] 9
- [ ] 40
- [ ] 100

> (4 × 2) + 1 = 9.

### 8 app instances, each with a pool of 15, and `max_connections = 100`. What happens?

- [ ] Postgres queues the extra connections
- [ ] Each pool silently shrinks to 12
- [x] The pools want 120 connections in total, so some connection attempts are refused
- [ ] Nothing, pools share connections between instances

> Pools know nothing about each other. The total is pool size × instances.

### Why do serverless functions need a connection proxy such as PgBouncer or RDS Proxy?

- [ ] They cannot speak the Postgres protocol
- [x] Each cold start opens its own connection, and a burst of them exhausts max_connections
- [ ] They run queries more slowly
- [ ] Proxies make queries faster

> There is no long-lived process to hold a pool, so the pooling has to move to something that stays up.
