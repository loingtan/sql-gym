-- (The seed schema stays: chapter files can be re-applied to a running database with psql -f.)

-- VACUUM FULL rewrites the small antipattern tables so no HOT-update chains are left. With chains,
-- an index created inside a transaction can't be used by that same transaction (pg_index.indcheckxmin).
SELECT format('VACUUM (FULL, ANALYZE) %I.%I', schemaname, tablename) FROM pg_tables WHERE schemaname = 'bugs' \gexec

-- Plain VACUUM on the big tables sets the visibility map, which index-only scans rely on.
VACUUM (ANALYZE) perf.customers, perf.products, perf.orders, perf.order_items, perf.reviews;
