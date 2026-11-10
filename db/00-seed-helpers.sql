-- Helpers for seeding. Kept after init so chapter files (1x-*.sql) can be re-applied with psql -f.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA seed;

-- Deterministic pseudo-random number in [0, 1). hashint8extended backs hash partitioning,
-- so it is stable across Postgres versions: every machine gets exactly the same data.
CREATE FUNCTION seed.rnd(n bigint, salt bigint) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN (hashint8extended(n, salt) & 2147483647)::double precision / 2147483648;

CREATE FUNCTION seed.pick(arr text[], n bigint, salt bigint) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN arr[1 + floor(seed.rnd(n, salt) * cardinality(arr))::int];
