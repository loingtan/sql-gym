---
title: Implicit Columns
part: Queries
concept: Name your columns | SELECT * and INSERT without a column list depend on column order nobody promised. Spell the columns out.
---

## Objective

Type less. `SELECT *` fetches everything without listing it, and `INSERT INTO t VALUES (…)` skips the
column list.

## The antipattern: a shortcut that gets you lost

The wildcard means "whatever columns exist, in whatever order they have **when the query runs**". The
statement keeps working as the table changes underneath it, with a different meaning each time.

- **Refactoring breaks it quietly.** Add a column and `INSERT INTO accounts VALUES (…)` fails with a
  column count error. Reorder or swap columns of the same type and it **succeeds**, writing the first
  name into the last-name column. `INSERT INTO archive SELECT * FROM contacts` copies by position: if
  the two tables list the same columns in a different order, the data is scrambled with no error.
- **Joins collide.** `SELECT * FROM books JOIN authors …` returns two columns called `title` once
  someone adds a salutation to `authors`. Code that reads `row['title']` now gets one or the other,
  depending on the driver.
- **Hidden costs.** The wildcard drags along every column, including the 2 MB `bytea` and the long
  `text` you never display. More data read, sent and held in memory, and no chance of an index-only scan.
- **Dropped columns go unnoticed.** With `SELECT *` nothing fails when a column disappears, until code
  far from the query touches the missing field.

## How to recognize it

- "The app broke because it still uses the old column names."
- "It took days to find out the import put values into the wrong columns."
- "Why is this page sending 40 MB over the network?"

## Legitimate uses

Ad-hoc queries typed at a prompt, where you look at the result once and throw the statement away.
`count(*)` and `EXISTS (SELECT * …)` are fine: nothing is fetched by position. Inside a single statement,
`SELECT t.*` from a subquery you define two lines above is also safe.

## Solution: name columns explicitly

```sql
SELECT bug_id, date_reported, summary, status FROM bugs;

INSERT INTO accounts (account_name, first_name, last_name, email)
VALUES ('bkarwin', 'Bill', 'Karwin', 'bill@example.com');

INSERT INTO contacts_archive (contact_id, first_name, last_name, email, phone)
SELECT contact_id, first_name, last_name, email, phone FROM contacts WHERE …;
```

Explicit lists fail **early and loudly**: reference a dropped column and the statement errors at the
line that is wrong. Added columns are ignored until you ask for them. Column order stops mattering.
In joins, alias the collisions: `b.title AS book_title, a.title AS salutation`.

It is more typing. Editors and `\d table` produce the list for you, and the query then documents what it
needs.

## Exercise: The archive that scrambled itself

Move the contacts whose email ends in `@oldmail.example` into `implicit_contacts_archive`. The archive
has the same columns in a different order, and all of them are text. Fix the `INSERT` in Setup so the
query returns the archived contacts with every value in its own column.

```sql starter-setup
INSERT INTO implicit_contacts_archive
SELECT * FROM implicit_contacts
WHERE email LIKE '%@oldmail.example';
```

```sql starter
SELECT contact_id, first_name, last_name, email, phone
FROM implicit_contacts_archive
ORDER BY contact_id;
```

```sql reference
SELECT contact_id, first_name, last_name, email, phone
FROM implicit_contacts
WHERE email LIKE '%@oldmail.example'
```

```sql solution-setup
INSERT INTO implicit_contacts_archive (contact_id, first_name, last_name, email, phone)
SELECT contact_id, first_name, last_name, email, phone
FROM implicit_contacts
WHERE email LIKE '%@oldmail.example';
```

```sql solution
SELECT contact_id, first_name, last_name, email, phone
FROM implicit_contacts_archive
ORDER BY contact_id;
```

```meta
require: insert\s+into\s+implicit_contacts_archive\s*\( | Give the INSERT an explicit column list
```

> Hint: Run the starter and look at the rows: last names sit in `first_name`, phone numbers in `email`. No error was raised.

> Hint: `INSERT INTO implicit_contacts_archive (contact_id, first_name, last_name, email, phone) SELECT contact_id, first_name, last_name, email, phone FROM …`

## Exercise: Two columns named title

Last week someone added a salutation column called `title` to `implicit_authors`. The book list page
uses `SELECT *` over the join and now shows "Dr." where the book title should be. Return
`book_title, author, salutation, published` for every book, oldest first, with no wildcard.

```sql starter
SELECT *
FROM implicit_books b
JOIN implicit_authors a USING (author_id)
ORDER BY b.published;
```

```sql reference
SELECT b.title, a.name, a.title, b.published
FROM implicit_books b
JOIN implicit_authors a USING (author_id)
ORDER BY b.published
```

```sql solution
SELECT b.title AS book_title, a.name AS author, a.title AS salutation, b.published
FROM implicit_books b
JOIN implicit_authors a USING (author_id)
ORDER BY b.published;
```

```meta
ordered: true
require: ^(?![\s\S]*select\s+(\w+\.)?\*) | No SELECT *
```

> Hint: The starter's result has two columns named `title`. Which one does `row['title']` return?

> Hint: Name the four columns and alias the two titles: `b.title AS book_title`, `a.title AS salutation`.

## Quiz

### Two tables have the same five text columns in different orders. What does `INSERT INTO a SELECT * FROM b` do?

- [ ] Fails with a column mismatch error
- [ ] Matches the columns by name
- [x] Copies by position, putting values into the wrong columns without an error
- [ ] Copies nothing

> SQL matches by position. With compatible types nothing stops the scramble.

### Which use of the wildcard is harmless?

- [ ] `INSERT INTO archive SELECT * FROM contacts`
- [x] `SELECT count(*) FROM bugs`
- [ ] `SELECT * FROM books JOIN authors USING (author_id)` in application code
- [ ] `SELECT * FROM screenshots` on a list page

> `count(*)` counts rows. No column is fetched, so column order and width don't matter.

### What is the benefit of an explicit column list when a column is later dropped?

- [ ] The query keeps working
- [x] The query fails immediately at the statement that names the missing column
- [ ] The database restores the column
- [ ] Nothing changes

> A loud error at the right line beats a silent `undefined` three layers away.
