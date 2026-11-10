-- Chapters 7-10: Polymorphic Associations, Multicolumn Attributes, Metadata Tribbles, Rounding Errors.
-- Small hand-crafted tables (plus a few deterministic copies of bugs.bugs) that make each pitfall visible.

-- Chapter 7, Polymorphic Associations -------------------------------------------------------------
-- poly_comments.issue_id points at poly_bugs OR poly_features depending on issue_type. No FK is possible,
-- so orphans and typos get in. The two parents deliberately share ids 1-4.
DROP TABLE IF EXISTS bugs.poly_comments CASCADE;
DROP TABLE IF EXISTS bugs.poly_bugs CASCADE;
DROP TABLE IF EXISTS bugs.poly_features CASCADE;

CREATE TABLE bugs.poly_bugs (
  issue_id bigint PRIMARY KEY,
  summary  varchar(80) NOT NULL,
  status   varchar(20) NOT NULL
);

CREATE TABLE bugs.poly_features (
  issue_id bigint PRIMARY KEY,
  summary  varchar(80) NOT NULL,
  sponsor  varchar(50)
);

CREATE TABLE bugs.poly_comments (
  comment_id bigint PRIMARY KEY,
  issue_type varchar(20) NOT NULL,    -- 'Bugs' or 'FeatureRequests'. Nothing enforces that.
  issue_id   bigint NOT NULL,         -- no FOREIGN KEY: it can't name two tables
  author     bigint NOT NULL REFERENCES bugs.accounts(account_id),
  comment    text NOT NULL
);

INSERT INTO bugs.poly_bugs VALUES
  (1, 'Crash when saving a file', 'NEW'),
  (2, 'Typo on the login page',   'FIXED'),
  (3, 'Search is slow',           'IN PROGRESS'),
  (4, 'Print preview is blank',   'NEW'),
  (5, 'Memory leak in sync',      'CLOSED');

INSERT INTO bugs.poly_features VALUES
  (1, 'Dark mode',          'Design team'),
  (2, 'Export to CSV',      'Finance'),
  (3, 'Keyboard shortcuts', NULL),
  (4, 'Single sign-on',     'IT');

INSERT INTO bugs.poly_comments VALUES
  (1,  'Bugs',            1, 12, 'It crashes!'),
  (2,  'Bugs',            1, 55, 'Reproduced on Windows.'),
  (3,  'FeatureRequests', 1, 230, 'Great idea!'),
  (4,  'Bugs',            2, 7,  'Fixed in 2.1.'),
  (5,  'FeatureRequests', 2, 140, 'Finance needs this by Q3.'),
  (6,  'FeatureRequests', 2, 301, '+1'),
  (7,  'Bugs',            3, 21, 'Looks like a missing index.'),
  (8,  'Bugs',            7, 64, 'Still happens.'),                  -- orphan: bug 7 was deleted
  (9,  'FeatureRequests', 5, 88, 'Please prioritize.'),              -- orphan: no feature 5 (but bug 5 exists)
  (10, 'Feature',         3, 412, 'Vim bindings please.'),           -- orphan: typo in the type
  (11, 'Bugs',            5, 33, 'Closing as fixed.'),
  (12, 'FeatureRequests', 4, 199, 'Needs Okta support.'),
  (13, 'bugs',            4, 57, 'Same here.'),                      -- orphan: wrong case
  (14, 'FeatureRequests', 3, 260, 'Shortcut list attached.');

-- Chapter 8, Multicolumn Attributes ---------------------------------------------------------------
DROP TABLE IF EXISTS bugs.multi_bugs CASCADE;
CREATE TABLE bugs.multi_bugs (
  bug_id  bigint PRIMARY KEY,
  summary varchar(80) NOT NULL,
  tag1    varchar(20),
  tag2    varchar(20),
  tag3    varchar(20)
);

INSERT INTO bugs.multi_bugs VALUES
  (1,  'Crashes while saving',          'crash',       NULL,          NULL),
  (2,  'Printing is slow',              'printing',    'performance', NULL),
  (3,  'Support XML',                   NULL,          NULL,          NULL),
  (4,  'Report export is slow',         'performance', 'reports',     NULL),
  (5,  'Slow print preview',            'performance', NULL,          'printing'),     -- gap left by a removed tag
  (6,  'Printer dialog crashes',        'crash',       'printing',    NULL),
  (7,  'Emailed report crashes',        'email',       'reports',     'crash'),
  (8,  'Slow, slow printing',           'printing',    'performance', 'performance'),  -- duplicate: nothing stops it
  (9,  'Wrong colors in the toolbar',   'cosmetic',    NULL,          NULL),
  (10, 'Slow search',                   NULL,          'performance', NULL),
  (11, 'Printing cuts off the margin',  'printing',    NULL,          NULL),
  (12, 'Email send crashes, very slow', 'performance', 'email',       'crash');        -- full: no room for a 4th tag

-- Mini-antipattern "Storing Prices": today's price vs the price paid on the order.
DROP TABLE IF EXISTS bugs.multi_orders CASCADE;
DROP TABLE IF EXISTS bugs.multi_merchandise CASCADE;
CREATE TABLE bugs.multi_merchandise (
  merch_id bigint PRIMARY KEY,
  name     varchar(50) NOT NULL,
  price    numeric(9,2) NOT NULL          -- today's unit price
);

CREATE TABLE bugs.multi_orders (
  order_id   bigint PRIMARY KEY,
  order_date date NOT NULL,
  merch_id   bigint NOT NULL REFERENCES bugs.multi_merchandise(merch_id),
  quantity   int NOT NULL,
  price      numeric(9,2) NOT NULL        -- what the customer paid for this line, after discounts
);

INSERT INTO bugs.multi_merchandise VALUES
  (1, 'Bug Butler license', 49.00),
  (2, 'Query Quill Pro',    120.00),
  (3, 'Lint Lantern',       15.00);

INSERT INTO bugs.multi_orders VALUES
  (1, '2023-03-01', 1, 2,  78.00),   -- unit price was 39.00 back then
  (2, '2023-11-24', 2, 1,  90.00),   -- Black Friday
  (3, '2024-02-10', 1, 1,  44.10),   -- 10% member discount
  (4, '2024-06-01', 3, 4,  60.00),
  (5, '2024-07-15', 2, 2, 240.00),
  (6, '2024-09-09', 3, 10, 120.00);  -- bulk discount

-- Chapter 9, Metadata Tribbles --------------------------------------------------------------------
-- One clone table per year, copied from bugs.bugs. Real-life damage included:
--   * early-January 2022 bugs were filed into tribble_bugs_2021 by mistake,
--   * nobody created tribble_bugs_2025, so 2025 bugs went into tribble_bugs_2024,
--   * the "hours" column was only ever added to tribble_bugs_2024.
DROP TABLE IF EXISTS bugs.tribble_bugs_2021, bugs.tribble_bugs_2022, bugs.tribble_bugs_2023, bugs.tribble_bugs_2024 CASCADE;

CREATE TABLE bugs.tribble_bugs_2021 (
  bug_id        bigint PRIMARY KEY,
  date_reported date NOT NULL,
  summary       varchar(80),
  status        varchar(20) NOT NULL,
  reported_by   bigint NOT NULL
);
CREATE TABLE bugs.tribble_bugs_2022 (LIKE bugs.tribble_bugs_2021 INCLUDING ALL);
CREATE TABLE bugs.tribble_bugs_2023 (LIKE bugs.tribble_bugs_2021 INCLUDING ALL);
CREATE TABLE bugs.tribble_bugs_2024 (LIKE bugs.tribble_bugs_2021 INCLUDING ALL);
ALTER TABLE bugs.tribble_bugs_2024 ADD COLUMN hours numeric(9,2);

INSERT INTO bugs.tribble_bugs_2021
SELECT bug_id, date_reported, summary, status, reported_by FROM bugs.bugs
WHERE date_reported < '2022-01-03';                                   -- 2022-01-01 and 01-02 misfiled here
INSERT INTO bugs.tribble_bugs_2022
SELECT bug_id, date_reported, summary, status, reported_by FROM bugs.bugs
WHERE date_reported >= '2022-01-03' AND date_reported < '2023-01-01';
INSERT INTO bugs.tribble_bugs_2023
SELECT bug_id, date_reported, summary, status, reported_by FROM bugs.bugs
WHERE date_reported >= '2023-01-01' AND date_reported < '2024-01-01';
INSERT INTO bugs.tribble_bugs_2024
SELECT bug_id, date_reported, summary, status, reported_by, hours FROM bugs.bugs
WHERE date_reported >= '2024-01-01';                                  -- 2025 rows dumped here too

-- Chapter 10, Rounding Errors ---------------------------------------------------------------------
DROP TABLE IF EXISTS bugs.round_payments, bugs.round_invoices, bugs.round_bugs, bugs.round_accounts CASCADE;

-- Payments stored as double precision (what FLOAT means in Postgres).
CREATE TABLE bugs.round_invoices (
  invoice_id bigint PRIMARY KEY,
  customer   varchar(50) NOT NULL,
  total      numeric(9,2) NOT NULL
);
CREATE TABLE bugs.round_payments (
  payment_id bigint PRIMARY KEY,
  invoice_id bigint NOT NULL REFERENCES bugs.round_invoices(invoice_id),
  amount     double precision NOT NULL
);

INSERT INTO bugs.round_invoices VALUES
  (1, 'Acme',     0.30),
  (2, 'Globex',   100.00),
  (3, 'Initech',  39.97),
  (4, 'Umbrella', 1.00),
  (5, 'Hooli',    250.00),
  (6, 'Wayne',    3.30),
  (7, 'Soylent',  10.00),
  (8, 'Stark',    0.70);

INSERT INTO bugs.round_payments VALUES
  (1, 1, 0.10), (2, 1, 0.20),                                 -- 0.1 + 0.2
  (3, 2, 100.00),
  (4, 3, 19.99), (5, 3, 19.98),
  (6, 4, 0.10), (7, 4, 0.10), (8, 4, 0.10), (9, 4, 0.10), (10, 4, 0.10),
  (11, 4, 0.10), (12, 4, 0.10), (13, 4, 0.10), (14, 4, 0.10), (15, 4, 0.10),   -- ten dimes
  (16, 5, 200.00),                                            -- only partly paid
  (17, 6, 1.10), (18, 6, 2.20),
  (19, 7, 9.99),                                              -- one cent short
  (20, 8, 0.10), (21, 8, 0.60);

-- Rates and hours stored as real (float4): the rounding error grows big enough to see in dollars.
CREATE TABLE bugs.round_accounts (
  account_id   bigint PRIMARY KEY,
  account_name varchar(20) NOT NULL,
  hourly_rate  real
);
CREATE TABLE bugs.round_bugs (
  bug_id      bigint PRIMARY KEY,
  assigned_to bigint NOT NULL REFERENCES bugs.round_accounts(account_id),
  hours       real
);

INSERT INTO bugs.round_accounts
SELECT account_id, account_name, hourly_rate::real FROM bugs.accounts WHERE account_id <= 50;
INSERT INTO bugs.round_bugs
SELECT bug_id, assigned_to, hours::real FROM bugs.bugs WHERE assigned_to <= 50 AND hours IS NOT NULL;

