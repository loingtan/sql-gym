-- Chapters 3-6 (Part I, Logical Database Design): Naive Trees, ID Required, Keyless Entry, Entity-Attribute-Value.
-- Small hand-made tables whose rows make each antipattern's pitfalls visible.

-- Chapter 3, Naive Trees: an adjacency list (parent_id) of threaded comments, deeper than a few self-joins reach.
DROP TABLE IF EXISTS bugs.tree_comments CASCADE;
CREATE TABLE bugs.tree_comments (
  comment_id bigint PRIMARY KEY,
  bug_id     bigint NOT NULL REFERENCES bugs.bugs(bug_id),
  parent_id  bigint REFERENCES bugs.tree_comments(comment_id),
  author     bigint NOT NULL REFERENCES bugs.accounts(account_id),   -- 12 Kukla, 34 Fran, 56 Ollie
  comment    text   NOT NULL
);

INSERT INTO bugs.tree_comments VALUES
  (1,  1234, NULL, 34, 'What''s the cause of this bug?'),
  (2,  1234, 1,    56, 'I think it''s a null pointer.'),
  (3,  1234, 2,    34, 'No, I checked for that.'),
  (4,  1234, 1,    12, 'We need to check for invalid input.'),
  (5,  1234, 4,    56, 'Yes, that''s a bug.'),
  (6,  1234, 4,    34, 'Yes, please add a check.'),
  (7,  1234, 6,    12, 'That fixed it.'),
  (8,  1234, 7,    56, 'Not for me: it still fails in staging.'),
  (9,  1234, 8,    34, 'Staging still runs last week''s build.'),
  (10, 1234, 9,    56, 'Redeployed. Works now.'),
  (11, 1234, 10,   12, 'Closing then.'),
  (12, 1234, 6,    56, 'Can we add a regression test too?'),
  (13, 1234, 12,   12, 'Added one in the same patch.'),
  (14, 1234, 5,    34, 'Me too!'),
  (15, 1234, NULL, 56, 'Is this a duplicate of the export crash?'),
  (16, 1234, 15,   12, 'No, different stack trace.'),
  (17, 2001, NULL, 12, 'Export to PDF hangs on large reports.'),
  (18, 2001, 17,   34, 'How large?'),
  (19, 2001, 18,   12, 'Anything over 200 pages.'),
  (20, 2001, 17,   56, 'Profiled it: the font cache is rebuilt for every page.');

-- Chapter 4, ID Required: an intersection table with a surrogate id and no key on the pair, so duplicates got in.
DROP TABLE IF EXISTS bugs.idreq_article_tags CASCADE;
DROP TABLE IF EXISTS bugs.idreq_articles CASCADE;
DROP TABLE IF EXISTS bugs.idreq_tags CASCADE;
CREATE TABLE bugs.idreq_articles (
  id         serial PRIMARY KEY,
  title      varchar(80) NOT NULL,
  word_count int NOT NULL
);
CREATE TABLE bugs.idreq_tags (
  id  serial PRIMARY KEY,
  tag varchar(20) NOT NULL UNIQUE
);
CREATE TABLE bugs.idreq_article_tags (
  id         serial PRIMARY KEY,                -- the "every table needs an id" key. Nothing stops duplicate pairs.
  article_id int NOT NULL REFERENCES bugs.idreq_articles(id),
  tag_id     int NOT NULL REFERENCES bugs.idreq_tags(id)
);

INSERT INTO bugs.idreq_articles (id, title, word_count) VALUES
  (1, 'Rates rise again',             900),
  (2, 'Chip makers expand',           800),
  (3, 'Housing market cools',         1200),
  (4, 'Remote work and city budgets', 800),   -- same word count as article 2: sum(DISTINCT ...) is a trap
  (5, 'Tariffs explained',            600),
  (6, 'Election night recap',         1500),
  (7, 'A new battery chemistry',      700),
  (8, 'Telescope finds water',        1000);
INSERT INTO bugs.idreq_tags (id, tag) VALUES
  (1, 'economy'), (2, 'politics'), (3, 'science'), (4, 'tech');
INSERT INTO bugs.idreq_article_tags (article_id, tag_id) VALUES
  (1, 1), (2, 1), (3, 1), (3, 1), (4, 1), (3, 1), (5, 1),   -- economy: 5 articles, 7 rows
  (1, 2), (6, 2), (6, 2),                                   -- politics: 2 articles, 3 rows
  (7, 3), (8, 3),
  (2, 4), (7, 4), (8, 4), (2, 4);                           -- tech: 3 articles, 4 rows
SELECT setval(pg_get_serial_sequence('bugs.idreq_articles', 'id'), 8);
SELECT setval(pg_get_serial_sequence('bugs.idreq_tags', 'id'), 4);

-- Chapter 5, Keyless Entry: bugs that reference accounts and a status lookup table, with no foreign keys declared.
DROP TABLE IF EXISTS bugs.keyless_bugs CASCADE;
DROP TABLE IF EXISTS bugs.keyless_status CASCADE;
CREATE TABLE bugs.keyless_status (
  status varchar(20) PRIMARY KEY
);
CREATE TABLE bugs.keyless_bugs (
  bug_id      bigint PRIMARY KEY,
  summary     varchar(80) NOT NULL,
  reported_by bigint NOT NULL,                       -- should reference accounts(account_id)
  assigned_to bigint,                                -- should reference accounts(account_id); NULL = unassigned
  status      varchar(20) NOT NULL DEFAULT 'NEW'     -- should reference keyless_status(status)
);

INSERT INTO bugs.keyless_status VALUES ('NEW'), ('IN PROGRESS'), ('FIXED'), ('BOGUS'), ('CLOSED');
INSERT INTO bugs.keyless_bugs VALUES
  (1,  'Save dialog crashes',        3,    12,   'NEW'),
  (2,  'Login page shows a typo',    7,    NULL, 'IN PROGRESS'),
  (3,  'Search box is very slow',    9999, 5,    'FIXED'),     -- reporter account never existed
  (4,  'Toolbar uses the wrong font', 4,   777,  'NEW'),       -- assignee was deleted
  (5,  'Undo history loses data',    8,    NULL, 'BANANA'),    -- garbage status
  (6,  'File upload times out',      600,  600,  'CLOSED'),    -- account 600 is gone: two broken references
  (7,  'Print preview is blank',     2,    3,    'BOGUS'),
  (8,  'Spell checker freezes',      11,   12,   'Fixed'),     -- string keys are case-sensitive
  (9,  'Sync service leaks memory',  15,   NULL, 'BOGUS'),
  (10, 'Report builder ignores Enter', 20, 21,   'NEW'),
  (11, 'Settings screen flickers',   33,   34,   'CLOSED'),
  (12, 'Export to PDF fails',        40,   41,   'IN PROGRESS');

-- Chapter 6, Entity-Attribute-Value: issues whose attributes are stored as name/value rows.
DROP TABLE IF EXISTS bugs.eav_issue_attributes CASCADE;
DROP TABLE IF EXISTS bugs.eav_issues CASCADE;
CREATE TABLE bugs.eav_issues (
  issue_id bigint PRIMARY KEY
);
CREATE TABLE bugs.eav_issue_attributes (
  issue_id   bigint NOT NULL REFERENCES bugs.eav_issues(issue_id),
  attr_name  varchar(100) NOT NULL,
  attr_value varchar(100),
  PRIMARY KEY (issue_id, attr_name)
);

INSERT INTO bugs.eav_issues SELECT generate_series(1, 10);
INSERT INTO bugs.eav_issue_attributes (issue_id, attr_name, attr_value) VALUES
  (1, 'issue_type', 'BUG'), (1, 'status', 'NEW'), (1, 'priority', 'HIGH'),
  (1, 'date_reported', '2024-03-02'), (1, 'severity', 'loss of functionality'), (1, 'version_affected', '1.0'),
  (2, 'issue_type', 'BUG'), (2, 'status', 'FIXED'), (2, 'priority', 'LOW'),
  (2, 'date_reported', '2024-03-15'), (2, 'severity', 'cosmetic'), (2, 'version_affected', '1.0'),
  (3, 'issue_type', 'BUG'), (3, 'status', 'NEW'), (3, 'priority', 'MEDIUM'),
  (3, 'date_reported', '2024-04-01'), (3, 'severity', 'crash'),
  (4, 'issue_type', 'BUG'), (4, 'status', 'IN PROGRESS'),                       -- no priority row at all
  (4, 'date_reported', '2024-04-09'), (4, 'severity', 'crash'), (4, 'version_affected', '1.1'),
  (5, 'issue_type', 'BUG'), (5, 'status', 'CLOSED'), (5, 'priority', 'HIGH'),
  (5, 'report_date', '2024-04-20'), (5, 'severity', 'data loss'),                -- a synonym for date_reported
  (6, 'issue_type', 'BUG'), (6, 'status', 'NEW'), (6, 'priority', 'LOW'),
  (6, 'date_reported', 'banana'), (6, 'severity', 'cosmetic'),                    -- nothing checks the value
  (7, 'issue_type', 'FEATURE'), (7, 'status', 'NEW'), (7, 'priority', 'MEDIUM'),
  (7, 'date_reported', '2024-03-05'), (7, 'sponsor', 'Acme Corp'),
  (8, 'issue_type', 'FEATURE'), (8, 'status', 'IN PROGRESS'), (8, 'priority', 'HIGH'),
  (8, 'date_reported', '2024-03-28'), (8, 'sponsor', 'Globex'),
  (9, 'issue_type', 'FEATURE'), (9, 'status', 'NEW'),
  (9, 'date_reported', '2024-04-11'), (9, 'sponsor', 'Acme Corp'),
  (10, 'issue_type', 'FEATURE'), (10, 'status', 'CLOSED'), (10, 'priority', 'LOW'),
  (10, 'date_reported', '2024-04-30');
