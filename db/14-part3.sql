-- Part III (Queries) + Chapter 26 tables. Chapters 16 and 18 use the perf schema and the base bugs tables.

-- Chapter 17, Poor Man's Search Engine: a tiny knowledge base whose rows trip up LIKE.
-- 'Crash' / 'CRASHES' (case), 'crashpad' (substring, not the word) and 'blueprint' (contains "print").
DROP TABLE IF EXISTS bugs.search_kb CASCADE;
CREATE TABLE bugs.search_kb (
  article_id int  PRIMARY KEY,
  title      text NOT NULL,
  body       text NOT NULL
);

INSERT INTO bugs.search_kb VALUES
  (1,  'Editor crashes when saving large files', 'Saving a file over 2 GB crashes the editor. Split the file first.'),
  (2,  'Crash on startup after the update',      'Delete the cache folder and start the app again.'),
  (3,  'Printing a test page',                   'Printing a test page crashed the driver on Windows. Install driver 4.2.'),
  (4,  'Configuring the crashpad uploader',      'Point the crashpad minidump uploader at your own server.'),
  (5,  'Blueprint export keeps crashing',        'Exporting a blueprint with 500 layers keeps crashing the exporter.'),
  (6,  'Search is slow',                         'Searching takes ten seconds on large projects. Rebuild the index.'),
  (7,  'Sync service CRASHES at midnight',       'The nightly sync job stops with an error. Move it to 1 AM.'),
  (8,  'Print preview is blank',                 'Print preview shows an empty page for reports with images.'),
  (9,  'Report builder crash',                   'The report builder crashed when you print to PDF.'),
  (10, 'Memory grows in the toolbar',            'Memory grows until the operating system kills the app.');

-- Chapter 19, Implicit Columns.
-- The archive table was created later by someone else, with the columns in a different order.
-- All columns are text, so a positional INSERT ... SELECT * scrambles data without an error.
DROP TABLE IF EXISTS bugs.implicit_contacts_archive CASCADE;
DROP TABLE IF EXISTS bugs.implicit_contacts CASCADE;
CREATE TABLE bugs.implicit_contacts (
  contact_id int  PRIMARY KEY,
  first_name text NOT NULL,
  last_name  text NOT NULL,
  email      text NOT NULL,
  phone      text NOT NULL
);
CREATE TABLE bugs.implicit_contacts_archive (
  contact_id int  PRIMARY KEY,
  last_name  text NOT NULL,
  first_name text NOT NULL,
  phone      text NOT NULL,
  email      text NOT NULL
);

INSERT INTO bugs.implicit_contacts VALUES
  (1, 'Linh',  'Tran',   'linh.tran@mail.example',  '+84 90 111 2222'),
  (2, 'Bill',  'Karwin', 'bill@oldmail.example',    '+1 555 0100'),
  (3, 'Priya', 'Patel',  'priya@mail.example',      '+44 20 7946 0000'),
  (4, 'Omar',  'Garcia', 'omar.g@oldmail.example',  '+34 91 123 4567'),
  (5, 'Hana',  'Sato',   'hana@oldmail.example',    '+81 3 1234 5678'),
  (6, 'Minh',  'Le',     'minh.le@mail.example',    '+84 28 3822 0000');

-- The book's intro story: books and authors both have a "title" column (book title vs. salutation).
DROP TABLE IF EXISTS bugs.implicit_books CASCADE;
DROP TABLE IF EXISTS bugs.implicit_authors CASCADE;
CREATE TABLE bugs.implicit_authors (
  author_id int  PRIMARY KEY,
  name      text NOT NULL,
  title     text               -- salutation (Dr., Rev., ...), added last week
);
CREATE TABLE bugs.implicit_books (
  book_id   int  PRIMARY KEY,
  author_id int  NOT NULL REFERENCES bugs.implicit_authors(author_id),
  title     text NOT NULL,
  published int  NOT NULL
);

INSERT INTO bugs.implicit_authors VALUES
  (1, 'Ada Lovelace',    'Countess'),
  (2, 'Grace Hopper',    'Rear Adm.'),
  (3, 'Edgar Codd',      'Dr.'),
  (4, 'Bill Karwin',     NULL),
  (5, 'Donald Knuth',    'Prof.');

INSERT INTO bugs.implicit_books VALUES
  (1, 3, 'A Relational Model of Data',        1970),
  (2, 4, 'SQL Antipatterns',                  2010),
  (3, 5, 'The Art of Computer Programming',   1968),
  (4, 1, 'Notes on the Analytical Engine',    1843),
  (5, 2, 'Understanding Computers',           1984),
  (6, 5, 'Literate Programming',              1992),
  (7, 4, 'SQL Antipatterns, Volume 1',        2022);

-- Chapter 26, Foreign Key Mistakes.
-- Exercise 1: tasks were loaded without a foreign key, and some point at deleted projects (4 and 7).
DROP TABLE IF EXISTS bugs.fkm_tasks CASCADE;
DROP TABLE IF EXISTS bugs.fkm_projects CASCADE;
CREATE TABLE bugs.fkm_projects (
  project_id int  PRIMARY KEY,
  name       text NOT NULL
);
CREATE TABLE bugs.fkm_tasks (
  task_id    int  PRIMARY KEY,
  project_id int  NOT NULL,          -- no foreign key yet. That's the problem.
  title      text NOT NULL
);

INSERT INTO bugs.fkm_projects VALUES
  (0, 'Inbox'), (1, 'Website relaunch'), (2, 'Mobile app'), (3, 'Billing'), (5, 'Data warehouse');

INSERT INTO bugs.fkm_tasks VALUES
  (1,  1, 'New landing page'),
  (2,  1, 'Fix broken links'),
  (3,  2, 'Push notifications'),
  (4,  4, 'Migrate old forum'),        -- project 4 was deleted
  (5,  3, 'VAT rounding'),
  (6,  2, 'Dark mode'),
  (7,  7, 'Prototype chatbot'),        -- project 7 never existed
  (8,  5, 'Nightly ETL'),
  (9,  4, 'Archive forum attachments'),-- project 4 again
  (10, 3, 'Invoice PDF layout'),
  (11, 0, 'Triage me'),
  (12, 5, 'Partition the fact table');

-- Exercise 2: releases have a compound key; builds must reference (product_id, version).
DROP TABLE IF EXISTS bugs.fkm_build_log CASCADE;
DROP TABLE IF EXISTS bugs.fkm_releases CASCADE;
CREATE TABLE bugs.fkm_releases (
  product_id  int         NOT NULL,
  version     varchar(10) NOT NULL,
  released_on date        NOT NULL,
  PRIMARY KEY (product_id, version)
);
CREATE TABLE bugs.fkm_build_log (
  build_id   int         PRIMARY KEY,
  product_id int         NOT NULL,
  version    varchar(10) NOT NULL,
  status     text        NOT NULL
);

INSERT INTO bugs.fkm_releases VALUES
  (1, '1.0', '2023-01-10'), (1, '1.1', '2023-06-01'),
  (2, '1.0', '2023-02-15'), (2, '1.1', '2023-09-20'), (2, '2.0', '2024-03-01'),
  (3, '1.0', '2024-01-05');

INSERT INTO bugs.fkm_build_log VALUES
  (101, 1, '1.0', 'passed'), (102, 1, '1.1', 'passed'), (103, 1, '1.1', 'failed'),
  (104, 2, '1.0', 'passed'), (105, 2, '1.1', 'failed'), (106, 2, '1.1', 'passed'),
  (107, 2, '2.0', 'passed'), (108, 3, '1.0', 'passed'), (109, 1, '1.0', 'failed'),
  (110, 2, '1.1', 'passed');
