---
title: A connection is a process
part: Connections
concept: Connections are expensive | Each one is an OS process with its own memory, and opening it costs more than a fast query. Open few, reuse them.
---

## What a connection is

Before your application can send SQL, it needs a **connection**: a dedicated channel to the database
server. In PostgreSQL that channel is heavier than a socket. Postgres uses a **process-per-connection**
model: for every client that connects, the main server process (the *postmaster*) forks a new operating
system process, called a **backend**, that serves only that client until it disconnects.

Each backend has its own memory, its own login session and its own transaction state. A commonly quoted
figure is 5–10 MB per connection, and more once it has run queries and cached things. Treat the exact
number as a rough estimate; the point is that a connection is a real process with real memory.

Because of that, the server caps how many can exist: `max_connections`, 100 by default. Connection 101
is refused with `FATAL: sorry, too many clients already`. A few slots (`superuser_reserved_connections`,
default 3) are held back so an administrator can still log in when the rest are taken.

## What opening one costs

Opening a connection is a small ceremony:

1. TCP handshake (three packets back and forth)
2. TLS negotiation, if encryption is on
3. Authentication (Postgres's default password scheme is deliberately slow to compute)
4. The postmaster forks the backend process, which initialises its memory

Closing it kills the process and frees the memory. Over a network this takes roughly 1–5 ms inside one
rack, 5–20 ms across a data center, 50–200 ms between data centers and up to a second or more across
regions.

Compare that with the work you came to do. A lookup by primary key takes well under a millisecond. If
every request opens a connection, runs one fast query and closes it, almost all the time goes to the
ceremony. It is like hiring and firing a cashier for every customer.

## The idea of a pool

Open a handful of connections once, keep them, and lend them out: **borrow, use, return**. That is a
connection pool, and the next round takes it apart. This round lets you measure the problem it solves.

## Exercise: How many slots are there?

Ask the server about its connection limit. Return one row with three numbers:
`max_connections`, `superuser_reserved_connections`, and how many slots are left for ordinary
(non-superuser) roles: the first minus the second minus `reserved_connections`. The settings live in
the `pg_settings` view as text.

```sql starter
SELECT name, setting
FROM pg_settings
WHERE name LIKE '%connections%';
```

```sql reference
SELECT m.setting::int, s.setting::int, m.setting::int - s.setting::int - r.setting::int
FROM pg_settings m, pg_settings s, pg_settings r
WHERE m.name = 'max_connections'
  AND s.name = 'superuser_reserved_connections'
  AND r.name = 'reserved_connections'
```

```sql solution
SELECT current_setting('max_connections')::int AS max_connections,
       current_setting('superuser_reserved_connections')::int AS superuser_reserved,
       current_setting('max_connections')::int
         - current_setting('superuser_reserved_connections')::int
         - current_setting('reserved_connections')::int AS for_ordinary_roles;
```

> Hint: Run the starter to see the settings. You need one row with three integer columns.

> Hint: `current_setting('max_connections')::int` reads one setting as a number.

## Exercise: Connect every time, or reuse?

The experiment sends 300 requests, one after another. Each runs `SELECT 1`, about the cheapest query
there is. With `mode: connect`, every request opens a new connection, runs the query and closes it.
Run it and look at "Connections opened" and the total time. Then change one word.

```sql request
SELECT 1
```

```sql starter-setup
mode: connect     # connect = a new connection per request, pool = borrow from a pool
```

```sql solution-setup
mode: pool
```

```meta
kind: load
tunable: mode
requests: 300
pool_max: 5
goal: total_ms <= 400 | Finish all 300 requests in under 400 ms
goal: connections <= 5 | Open at most 5 connections
goal: failed = 0 | No failed requests
```

> Hint: Compare "Wait for a connection" with "Time holding it" after the first run. Which one is the work, and which is the ceremony?

> Hint: `mode: pool` opens one connection and reuses it 300 times.

## Quiz

### What does PostgreSQL create when a client connects?

- [ ] A thread inside the server process
- [x] A new operating system process that serves only that client
- [ ] Nothing until the first query
- [ ] A row in a table

> Postgres forks one backend process per connection. That is why connections cost memory and why there is a hard limit.

### A query takes 2 ms. Opening a connection takes 40 ms. With a new connection per request, how long does one request take?

- [ ] 2 ms
- [ ] 20 ms
- [x] About 42 ms
- [ ] 80 ms

> The setup cost is paid on every request, so the request is 95% ceremony.

### What happens to client number 101 when `max_connections` is 100 and all slots are in use?

- [ ] It waits in a queue inside Postgres
- [x] Postgres refuses it with "too many clients already"
- [ ] The oldest connection is closed to make room
- [ ] Postgres raises the limit automatically

> Postgres does not queue connection attempts. Queuing is the pool's job, as the next round shows.
