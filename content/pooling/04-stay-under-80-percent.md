---
title: Stay under 80%
part: Pooling
concept: Waiting explodes near full | Arrivals come in bursts. At 70–80% average use the queue stays short; near 100% it grows without limit.
---

## The average hides the queue

Little's Law gives an **average**: 100 requests per second × 50 ms = 5 connections busy on average. So
a pool of 5, or 6 to be safe, should do?

It would if requests arrived like a metronome, one every 10 ms. Real requests arrive in **bursts**:
nothing for 40 ms, then five at once. During a burst every connection is taken and the rest wait. During
a lull, connections sit idle, and idle time cannot be saved up for later. The bursts cost you, the
lulls give nothing back.

## Kingman's formula

Queueing theory has an approximation for the average wait, known as Kingman's formula:

> wait ≈ ( ρ ÷ (1 − ρ) ) × variability × service time

Here ρ (rho) is **utilisation**: the share of capacity in use, between 0 and 1. The first factor is the
one to remember:

| Utilisation ρ | ρ ÷ (1 − ρ) |
|---|---|
| 50% | 1 |
| 70% | 2.3 |
| 80% | 4 |
| 90% | 9 |
| 95% | 19 |
| 99% | 99 |

The wait does not grow in a straight line. Going from 50% to 80% makes it four times longer. Going from
80% to 95% makes it almost five times longer again. Close to 100% it has no limit. The "variability"
factor says the same thing as the paragraph above: the burstier the arrivals and the more uneven the
query times, the longer the wait.

The same curve governs CPU cores, disks, network links, checkout counters and motorways. Anything that
serves random arrivals behaves well up to roughly **70–80%** and badly beyond.

## What to do with it

- Size the pool so that average use is about 70–80% of it: connections needed ÷ 0.75.
- Watch the **wait time** for a connection, and its 95th percentile rather than its average. It is the
  first number to move when you are running out of room.
- Remember round 3: making queries faster lowers utilisation just as well as adding connections, and
  without adding load to the database.

## Exercise: Find the knee of the curve

About 100 requests per second arrive **at random** for three seconds. Each holds a connection for
50 ms, so about 5.4 are busy on average (the hold time is a little over 50 ms in practice). The pool
has 6, which looks like enough. Run it and look at the p95 wait. Then find the smallest comfortable pool.

```sql request
SELECT pg_sleep(0.05)
```

```sql starter-setup
pool_max: 6
```

```sql solution-setup
pool_max: 8
```

```meta
kind: load
tunable: pool_max
rate: 100
duration_s: 3
arrivals: random
timeout_ms: 1000
goal: failed = 0 | No request times out
goal: wait_p95 <= 35 | 95% of requests wait under 35 ms for a connection
goal: pool_max <= 9 | Use at most 9 connections
```

> Hint: 5.4 busy out of 6 is 90% utilisation. Check the table: that is the steep part of the curve.

> Hint: Aim for about 70%: 5.4 ÷ 0.7. Try 7 and 8 and compare the p95 wait of each run.

## Quiz

### A pool runs at 95% utilisation and requests wait a long time. Average demand is below the pool size. Why the waiting?

- [ ] The pool is broken
- [x] Arrivals are bursty, and at 95% there is almost no slack to absorb a burst
- [ ] The database is down
- [ ] Averages are always wrong

> Idle time in the lulls can't be banked. Near full use, every burst becomes a queue.

### According to the table, how does the wait at 90% utilisation compare with the wait at 50%?

- [ ] About twice as long
- [ ] About the same
- [x] About nine times as long
- [ ] Shorter

> ρ ÷ (1 − ρ) is 1 at 50% and 9 at 90%.

### Which number warns you earliest that a pool is running out of room?

- [ ] Average query time
- [ ] Number of idle connections
- [x] The 95th percentile of the time requests wait for a connection
- [ ] The size of the database

> Wait time is the queue made visible, and the tail moves before the average does.
