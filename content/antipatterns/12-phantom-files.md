---
title: Phantom Files
part: Physical Database Design
concept: Data stays with its row | Bytes in a bytea column are deleted, rolled back, backed up and protected together with the row. A path in a varchar is only a promise.
---

## Objective

Store **images and other bulky media** and connect them to rows: an avatar for each account, screenshots for each bug.
When you read the row, the application must be able to get the image.

## The antipattern: assume you must use files

Many teams treat it as a rule that images go on the filesystem, and the database stores only the **path**:

```sql
CREATE TABLE screenshots (
  bug_id          bigint NOT NULL REFERENCES bugs(bug_id),
  image_id        int    NOT NULL,
  screenshot_path varchar(100),     -- '/var/bugs/screenshots/1234-1.png'
  caption         varchar(100),
  PRIMARY KEY (bug_id, image_id)
);
```

That path is just a string. Everything the database normally does for your data now stops at the edge of the column:

- **Files don't obey `DELETE`.** Deleting the row leaves the file on disk. Unless every code path also removes the
  file, **orphan** files pile up.
- **Files don't obey transactions.** If you delete or overwrite a file inside an open transaction, other sessions see
  the change at once, before you commit.
- **Files don't obey `ROLLBACK`.** Roll back the `DELETE` and the row comes back, but the file stays deleted.
- **Files don't obey backups.** `pg_dump` and physical backups copy the database, not `/var/bugs/screenshots`. You
  need a second backup, and even then it won't be consistent with the database snapshot. After a restore you get
  **phantom** rows: rows whose path points at nothing.
- **Files don't obey `GRANT`.** SQL privileges and row-level security don't protect a file someone can read
  straight from the web server.
- **A path is not a file.** Nothing checks that the file exists, and a rename or a move silently breaks the link.

## How to recognize it

Ask the people who run the system how they:

- back up and restore the images, and check after a restore that every referenced file came back;
- remove files that are no longer referenced by any row;
- keep users from seeing images they aren't allowed to see;
- undo an image change that was cancelled.

If nobody has an answer, files were chosen by habit, not by design.

## Legitimate uses

External storage has real advantages: the database and its backups stay small, files can be served directly by a
web server or CDN, and batch tools can edit them in place. Today this usually means **object storage** (S3 and
similar) with the object key in the database. That is a fine choice if you **accept the trade-offs on purpose**:
store the size and a checksum next to the key, write objects before you commit and delete them only after,
and run a regular **reconciliation** job that compares the bucket with the table, as in the first exercise.

## Solution: use bytea when you need integrity

PostgreSQL stores binary data in a **`bytea`** column (the BLOB of other databases), up to 1 GB per value:

```sql
ALTER TABLE screenshots ADD COLUMN screenshot_image bytea;
-- Images are already compressed: skip TOAST's compression attempt, still store out of line
ALTER TABLE screenshots ALTER COLUMN screenshot_image SET STORAGE EXTERNAL;

SELECT bug_id, image_id, octet_length(screenshot_image) AS bytes
FROM screenshots WHERE bug_id = 1234;
```

Now the image **is** part of the row. `DELETE` removes it, `ROLLBACK` restores it, other sessions see a new version
only after `COMMIT`, an `UPDATE` locks it against concurrent writers, `pg_dump` and replicas include it, and
`GRANT` controls it. Large values are moved out of the main table automatically (TOAST), so
`SELECT bug_id, caption` stays fast as long as you don't select the bytea column.

How do the bytes get in? From the application, send them as a **bind parameter** like any other value (no hex
strings built by hand). `pg_read_binary_file()` reads a file on the *database server*, so it needs superuser or
the `pg_read_server_files` role. Use it for one-off migrations only.

Postgres also has **large objects** (`lo_import`, `lo_export`, an `oid` column). They allow streaming and seeking
up to 4 TB, but they bring the phantom problem back *inside* the database: deleting the row doesn't delete the large
object. You need `lo_unlink()`, the `lo` extension's `lo_manage` trigger, or the `vacuumlo` tool. For images, `bytea`
is the simpler choice.

## Exercise: Reconcile after the restore

The server was restored from backup. `phantom_screenshots` stores paths, and `phantom_file_store` lists what is
really on disk now (one row per file, with its bytes in `content`). Return every inconsistency as `path, problem`:

- `'missing file'` for a screenshot row whose path has no file,
- `'orphan file'` for a file that no screenshot row references.

A screenshot with a `NULL` path never had a file (the upload failed). It is neither missing nor an orphan.

```sql starter
SELECT s.screenshot_path AS path, 'missing file' AS problem
FROM phantom_screenshots s
LEFT JOIN phantom_file_store f ON f.path = s.screenshot_path
WHERE f.path IS NULL;
```

```sql reference
SELECT coalesce(s.screenshot_path, f.path) AS path,
       CASE WHEN f.path IS NULL THEN 'missing file' ELSE 'orphan file' END AS problem
FROM (SELECT screenshot_path FROM phantom_screenshots WHERE screenshot_path IS NOT NULL) s
FULL JOIN phantom_file_store f ON f.path = s.screenshot_path
WHERE s.screenshot_path IS NULL OR f.path IS NULL
```

```sql solution
SELECT s.screenshot_path AS path, 'missing file' AS problem
FROM phantom_screenshots s
WHERE s.screenshot_path IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM phantom_file_store f WHERE f.path = s.screenshot_path)
UNION ALL
SELECT f.path, 'orphan file'
FROM phantom_file_store f
WHERE NOT EXISTS (SELECT 1 FROM phantom_screenshots s WHERE s.screenshot_path = f.path);
```

> Hint: The starter finds one direction. The other direction is the same anti-join from the file store's side. Glue the two with `UNION ALL`, or use a single `FULL JOIN`.

> Hint: The upload that failed has `screenshot_path IS NULL`. A plain anti-join reports it as a missing file with a NULL path. Filter it out.

> Hint: Use `NOT EXISTS` for the orphan check. `path NOT IN (SELECT screenshot_path ...)` returns **nothing** here, because the subquery contains a NULL (see chapter 14).

## Exercise: Move the bytes into the database

Make the screenshots safe from the next restore. Add a `bytea` column `screenshot_image` to `phantom_screenshots`,
copy each file's bytes into it from `phantom_file_store`, and delete the screenshot rows whose file is gone (they can't
be recovered, and that includes the failed upload). Then report, **from `phantom_screenshots`**, how many screenshots each bug has and how much
space they take: `bug_id, screenshots, total_bytes`, with the size from `octet_length(screenshot_image)`.

```sql starter-setup
-- ALTER TABLE phantom_screenshots ADD COLUMN ...;
-- UPDATE phantom_screenshots s SET ... FROM phantom_file_store f WHERE ...;
-- DELETE FROM phantom_screenshots WHERE ...;
```

```sql starter
SELECT bug_id, count(*) AS screenshots, NULL::bigint AS total_bytes
FROM phantom_screenshots
GROUP BY bug_id;
```

```sql reference
SELECT s.bug_id, count(*) AS screenshots, sum(octet_length(f.content)) AS total_bytes
FROM phantom_screenshots s
JOIN phantom_file_store f ON f.path = s.screenshot_path
GROUP BY s.bug_id
```

```sql solution-setup
ALTER TABLE phantom_screenshots ADD COLUMN screenshot_image bytea;

UPDATE phantom_screenshots s
SET screenshot_image = f.content
FROM phantom_file_store f
WHERE f.path = s.screenshot_path;

DELETE FROM phantom_screenshots WHERE screenshot_image IS NULL;

ALTER TABLE phantom_screenshots ALTER COLUMN screenshot_image SET NOT NULL;
```

```sql solution
SELECT bug_id, count(*) AS screenshots, sum(octet_length(screenshot_image)) AS total_bytes
FROM phantom_screenshots
GROUP BY bug_id
ORDER BY bug_id;
```

```meta
require: screenshot_image\s+bytea | Add a bytea column named screenshot_image
require: octet_length\s*\(\s*(\w+\.)?screenshot_image | Measure the stored bytes with octet_length(screenshot_image)
```

> Hint: `UPDATE ... SET screenshot_image = f.content FROM phantom_file_store f WHERE f.path = s.screenshot_path` copies the bytes in one statement. Rows without a file keep `NULL`.

> Hint: After the copy, `DELETE ... WHERE screenshot_image IS NULL` removes the phantom rows and the failed upload. A `SET NOT NULL` afterwards keeps new phantoms out.

> Hint: `octet_length(bytea)` is the size in bytes. All of this ran in one transaction: had any step failed, nothing would have changed. Files can't give you that.

## Quiz

### A transaction deletes a screenshot row and the application deletes the file, then the transaction rolls back. What is the result?

- [ ] Both the row and the file are restored
- [x] The row is back, but the file is still gone
- [ ] The row stays deleted and the file is restored
- [ ] Postgres refuses to roll back

> The filesystem is not part of the transaction. That is exactly the problem a `bytea` column avoids.

### Which statement about Postgres large objects (`lo_import`, `oid` columns) is true?

- [ ] Deleting the referencing row also deletes the large object
- [x] Deleting the referencing row leaves the large object behind unless you unlink it (or use `lo_manage` / `vacuumlo`)
- [ ] Large objects are not included in `pg_dump`
- [ ] Large objects are limited to 1 GB

> Large objects live in `pg_largeobject` and are referenced only by an `oid` number, so they can be orphaned just like files. `bytea` values belong to the row.

### Why is `ALTER COLUMN screenshot_image SET STORAGE EXTERNAL` a good idea for PNG or JPEG data?

- [ ] It stores the images outside the database, as files
- [ ] It makes the column read-only
- [x] It keeps the value out of line but skips compression, which can't shrink already-compressed images
- [ ] It enables streaming reads

> `EXTERNAL` is TOAST storage without compression. The bytes are still in the database, so transactions and backups cover them.

### When is storing a path or object key (instead of the bytes) a reasonable design?

- [ ] Always: databases can't store binary data
- [ ] Never: it is always an antipattern
- [x] When you choose it knowingly, for example to serve files from a CDN, and you handle orphans, consistency and backups yourself
- [ ] Only when the files are smaller than 1 KB

> The antipattern is assuming you *must* use files. External storage is fine when you take on the work the database would have done for you.
