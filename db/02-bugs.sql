-- The bug-tracker example database from "SQL Antipatterns" (Introduction/setup.sql), in Postgres dialect.
-- Chapter files (1x-*.sql) add the antipattern-specific tables to this schema.
CREATE SCHEMA bugs;
SET search_path = bugs;

CREATE TABLE accounts (
  account_id     bigserial PRIMARY KEY,
  account_name   varchar(20),
  first_name     varchar(20),
  last_name      varchar(20),
  email          varchar(100),
  password_hash  char(64),
  portrait_image bytea,
  hourly_rate    numeric(9,2)
);

CREATE TABLE bug_status (
  status varchar(20) PRIMARY KEY
);

CREATE TABLE bugs (
  bug_id        bigserial PRIMARY KEY,
  date_reported date          NOT NULL DEFAULT current_date,
  summary       varchar(80),
  description   varchar(1000),
  resolution    varchar(1000),
  reported_by   bigint        NOT NULL REFERENCES accounts(account_id),
  assigned_to   bigint        REFERENCES accounts(account_id),
  verified_by   bigint        REFERENCES accounts(account_id),
  status        varchar(20)   NOT NULL DEFAULT 'NEW' REFERENCES bug_status(status),
  priority      varchar(20),
  hours         numeric(9,2)
);

CREATE TABLE comments (
  comment_id   bigserial PRIMARY KEY,
  bug_id       bigint    NOT NULL REFERENCES bugs(bug_id),
  author       bigint    NOT NULL REFERENCES accounts(account_id),
  comment_date timestamp NOT NULL DEFAULT now(),
  comment      text      NOT NULL
);

CREATE TABLE screenshots (
  bug_id           bigint NOT NULL REFERENCES bugs(bug_id),
  image_id         bigint NOT NULL,
  screenshot_image bytea,
  caption          varchar(100),
  PRIMARY KEY (bug_id, image_id)
);

CREATE TABLE tags (
  bug_id bigint      NOT NULL REFERENCES bugs(bug_id),
  tag    varchar(20) NOT NULL,
  PRIMARY KEY (bug_id, tag)
);

CREATE TABLE products (
  product_id   bigserial PRIMARY KEY,
  product_name varchar(50)
);

CREATE TABLE bugs_products (
  bug_id     bigint NOT NULL REFERENCES bugs(bug_id),
  product_id bigint NOT NULL REFERENCES products(product_id),
  PRIMARY KEY (bug_id, product_id)
);

-- Data -------------------------------------------------------------------------------------------
-- Accounts 1..50 are developers, 51..70 QA, the rest are users. Account 1 is the admin.
INSERT INTO accounts (account_id, account_name, first_name, last_name, email, password_hash, hourly_rate)
SELECT g,
       CASE WHEN g = 1 THEN 'admin' ELSE lower(fn) || g END,
       CASE WHEN g = 1 THEN 'Ada' ELSE fn END,
       CASE WHEN g = 1 THEN 'Admin' ELSE ln END,
       CASE WHEN g = 1 THEN 'admin@bugs.example' ELSE lower(fn) || '.' || lower(ln) || g || '@bugs.example' END,
       encode(sha256(('secret' || g)::bytea), 'hex'),
       CASE WHEN g <= 70 THEN round((20 + seed.rnd(g, 103) * 80)::numeric, 2) END
FROM generate_series(1, 500) g
CROSS JOIN LATERAL (
  SELECT seed.pick(ARRAY['Bill','Mary','Linh','Minh','Sam','Priya','Tom','Hana','Omar','Lucy','Duc','Mai','Ken','Ana'], g, 101) AS fn,
         seed.pick(ARRAY['Karwin','Nguyen','Tran','Smith','Lee','Garcia','Kim','Patel','Brown','Le','Sato','Novak'], g, 102) AS ln
) n;

INSERT INTO bug_status VALUES
  ('NEW'), ('IN PROGRESS'), ('CODE COMPLETE'), ('FIXED'), ('VERIFIED'), ('CLOSED'), ('DUPLICATE'), ('WONTFIX');

INSERT INTO products (product_id, product_name) VALUES
  (1, 'Open RoundFile'), (2, 'Visual TurboBuilder'), (3, 'ReConsider'), (4, 'Bug Butler'),
  (5, 'Patchwork Studio'), (6, 'Query Quill'), (7, 'Lint Lantern'), (8, 'Sprint Sprout'),
  (9, 'Deploy Dragon'), (10, 'Log Lagoon'), (11, 'Cache Canoe'), (12, 'Merge Monkey');

INSERT INTO bugs (bug_id, date_reported, summary, description, reported_by, assigned_to, verified_by, status, priority, hours)
SELECT g,
       date '2021-01-01' + (g * 1500 / 5000),
       seed.pick(ARRAY['Save dialog','Login page','Search box','Print preview','Export to PDF','Settings screen',
                       'Toolbar','Undo history','File upload','Spell checker','Report builder','Sync service'], g, 111)
         || ' ' ||
       seed.pick(ARRAY['crashes on startup','shows a typo','is very slow','ignores the Enter key','loses data',
                       'freezes after an hour','uses the wrong font','fails with a timeout','returns a blank page',
                       'leaks memory'], g, 112),
       'Steps to reproduce: ' || seed.pick(ARRAY['open the app and wait','click the button twice','paste a long text',
                       'use a non-English locale','resize the window','log in from two browsers'], g, 113)
         || '. Expected it to work; it ' || seed.pick(ARRAY['crashed','hung','printed garbage','showed an error'], g, 114) || '.',
       1 + floor(seed.rnd(g, 115) * 500)::bigint,
       CASE WHEN seed.rnd(g, 116) < 0.15 THEN NULL ELSE 1 + floor(seed.rnd(g, 117) * 50)::bigint END,
       CASE WHEN st IN ('VERIFIED', 'CLOSED') THEN 51 + floor(seed.rnd(g, 118) * 20)::bigint END,
       st,
       CASE WHEN p < 0.10 THEN NULL WHEN p < 0.40 THEN 'LOW' WHEN p < 0.75 THEN 'MEDIUM' WHEN p < 0.95 THEN 'HIGH' ELSE 'CRITICAL' END,
       CASE WHEN seed.rnd(g, 119) < 0.30 THEN NULL ELSE round((seed.rnd(g, 120) * 40)::numeric, 2) END
FROM generate_series(1, 5000) g
CROSS JOIN LATERAL (
  SELECT seed.pick(ARRAY['NEW','NEW','IN PROGRESS','CODE COMPLETE','FIXED','FIXED','VERIFIED','CLOSED','CLOSED',
                         'CLOSED','DUPLICATE','WONTFIX'], g, 121) AS st,
         seed.rnd(g, 122) AS p
) x;

INSERT INTO comments (comment_id, bug_id, author, comment_date, comment)
SELECT g, b,
       1 + floor(seed.rnd(g, 132) * 500)::bigint,
       (date '2021-01-01' + (b * 1500 / 5000)::int) + seed.rnd(g, 133) * interval '30 days',
       seed.pick(ARRAY['I can reproduce this.','Works for me.','Still happens in the latest build.',
                       'Fixed in the next release.','Is this a duplicate?','Attached a screenshot.',
                       'Please add steps to reproduce.','Raising the priority.','Customer reported it again.',
                       'Root cause found, patch coming.'], g, 134)
FROM generate_series(1, 20000) g
CROSS JOIN LATERAL (SELECT 1 + floor(seed.rnd(g, 131) * 5000)::bigint AS b) x;

INSERT INTO tags (bug_id, tag)
SELECT DISTINCT b, seed.pick(ARRAY['crash','performance','ui','security','printing','data-loss','regression',
                                   'docs','i18n','accessibility'], b * 4 + k, 141)
FROM generate_series(1, 5000) b, generate_series(1, 3) k
WHERE seed.rnd(b * 4 + k, 142) < 0.5;

INSERT INTO bugs_products (bug_id, product_id)
SELECT DISTINCT b, 1 + floor(power(seed.rnd(b * 2 + k, 151), 1.5) * 12)::bigint
FROM generate_series(1, 5000) b, generate_series(1, 2) k
WHERE k = 1 OR seed.rnd(b, 152) < 0.25;

INSERT INTO screenshots (bug_id, image_id, screenshot_image, caption)
SELECT 1 + floor(seed.rnd(g, 161) * 5000)::bigint, g, decode(md5(g::text), 'hex'),
       seed.pick(ARRAY['Error dialog','Broken layout','Stack trace','Before the crash','After the crash'], g, 162)
FROM generate_series(1, 600) g;

SELECT setval(pg_get_serial_sequence('bugs.accounts', 'account_id'), max(account_id)) FROM accounts;
SELECT setval(pg_get_serial_sequence('bugs.bugs', 'bug_id'), max(bug_id)) FROM bugs;
SELECT setval(pg_get_serial_sequence('bugs.comments', 'comment_id'), max(comment_id)) FROM comments;
SELECT setval(pg_get_serial_sequence('bugs.products', 'product_id'), max(product_id)) FROM products;
