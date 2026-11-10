-- Part IV, Application Development (chapters 20-25). Small hand-made tables; synthetic data only.

-- Ch 20 Readable Passwords: a tiny "common passwords" list, as an attacker would bring to a dictionary attack.
DROP TABLE IF EXISTS bugs.pw_wordlist CASCADE;
CREATE TABLE bugs.pw_wordlist (
  word text PRIMARY KEY
);
INSERT INTO bugs.pw_wordlist (word) VALUES
  ('123456'), ('password'), ('qwerty'), ('letmein'), ('xyzzy'), ('opensesame'),
  ('secret'), ('secret1'), ('secret2'), ('secret7'), ('secret42'), ('secret99'), ('secret500'), ('admin');

-- Ch 22 Pseudokey Neat-Freak: asset tags with gaps (deleted / rolled-back rows). Gaps are fine.
DROP TABLE IF EXISTS bugs.neat_assets CASCADE;
CREATE TABLE bugs.neat_assets (
  asset_id   bigint PRIMARY KEY,
  department text   NOT NULL,
  label      text   NOT NULL,
  bought_on  date   NOT NULL
);
INSERT INTO bugs.neat_assets VALUES
  (1,  'Sales', 'Laptop',     '2023-01-10'),
  (2,  'Sales', 'Monitor',    '2023-01-11'),
  (4,  'Dev',   'Laptop',     '2023-02-01'),
  (5,  'Dev',   'Keyboard',   '2023-02-03'),
  (8,  'Sales', 'Phone',      '2023-03-15'),
  (9,  'Dev',   'Monitor',    '2023-03-20'),
  (13, 'QA',    'Tablet',     '2023-04-02'),
  (14, 'Dev',   'Docking',    '2023-04-05'),
  (21, 'QA',    'Laptop',     '2023-05-09'),
  (22, 'Sales', 'Headset',    '2023-05-30');

-- Ch 24 Diplomatic Immunity: tables someone created "just for now", without keys or indexes.
DROP TABLE IF EXISTS bugs.di_import_log CASCADE;
CREATE TABLE bugs.di_import_log (       -- no primary key
  imported_at date,
  source      text,
  row_count   int
);
INSERT INTO bugs.di_import_log VALUES ('2024-01-01', 'crm', 120), ('2024-01-02', 'crm', 98);

DROP TABLE IF EXISTS bugs.di_watchers CASCADE;
CREATE TABLE bugs.di_watchers (         -- no primary key, FK columns without an index
  bug_id     bigint NOT NULL REFERENCES bugs.bugs(bug_id),
  account_id bigint NOT NULL REFERENCES bugs.accounts(account_id)
);
INSERT INTO bugs.di_watchers VALUES (1, 2), (1, 3), (2, 2);

DROP TABLE IF EXISTS bugs.di_releases CASCADE;
CREATE TABLE bugs.di_releases (         -- done right: primary key, indexed FK, documented
  release_id bigint PRIMARY KEY,
  product_id bigint NOT NULL REFERENCES bugs.products(product_id),
  version    text   NOT NULL
);
CREATE INDEX di_releases_product_id_idx ON bugs.di_releases (product_id);
INSERT INTO bugs.di_releases VALUES (1, 1, '1.0'), (2, 1, '1.1'), (3, 2, '2.0');
COMMENT ON TABLE bugs.di_releases IS 'Shipped versions of a product.';

COMMENT ON TABLE bugs.bugs IS 'One row per reported defect.';
COMMENT ON TABLE bugs.accounts IS 'People who report, fix or verify bugs. Account 1 is the admin.';
