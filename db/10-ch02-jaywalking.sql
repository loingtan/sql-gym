-- Chapter 2, Jaywalking: a comma-separated list of account ids stored in one column.
-- The rows are hand-picked to trip up naive pattern matching.
DROP TABLE IF EXISTS bugs.jaywalk_products CASCADE;
CREATE TABLE bugs.jaywalk_products (
  product_id   bigint PRIMARY KEY,
  product_name varchar(50) NOT NULL,
  account_id   varchar(100)          -- comma-separated list of accounts.account_id. The antipattern.
);

INSERT INTO bugs.jaywalk_products VALUES
  (1,  'Open RoundFile',      '12,34'),
  (2,  'Visual TurboBuilder', '12'),
  (3,  'ReConsider',          '3,112,47'),
  (4,  'Bug Butler',          '120,5'),
  (5,  'Patchwork Studio',    '7, 12'),          -- someone typed a space
  (6,  'Query Quill',         '41,42,43,44,45'),
  (7,  'Lint Lantern',        ''),
  (8,  'Sprint Sprout',       '9,banana'),       -- nothing stops garbage
  (9,  'Deploy Dragon',       '212,312,12'),
  (10, 'Log Lagoon',          '5,5'),            -- duplicate entry
  (11, 'Cache Canoe',         NULL),
  (12, 'Merge Monkey',        '33,21,12');
