---
title: Readable Passwords
part: Application Development
concept: Salted slow hash | Store crypt(pw, gen_salt('bf')) and check crypt(input, stored) = stored. If you can read a password, so can an attacker.
---

## Objective

Users forget passwords. The application needs a way to get them back into their account
without anyone (support staff included) learning what the password was.

## The antipattern: store the password so it can be read back

The tempting design keeps the password in a `varchar` column and mails it to the user on request.
Anything readable by the application is readable by whoever gets a copy of the data:

- **Backups, logs and replicas** carry the plain text. Backup media is often guarded less carefully than the live server.
- **SQL text** leaks it: `INSERT ... VALUES (..., 'xyzzy')` shows up in statement logs and on an unencrypted wire.
- **Email** travels through servers you don't control.
- **Login checks** like `WHERE account_name = 'bill' AND password = 'opensesame'` also lump "no such user" and
  "wrong password" together, so you can't count failed guesses per account.

A plain hash is better but not enough. `sha256(password)` with no salt means equal passwords give equal hashes,
and an attacker can precompute hashes for millions of common passwords and simply **join**:

```sql
SELECT a.account_name, w.word
FROM accounts a
JOIN wordlist w ON a.password_hash = encode(sha256(w.word::bytea), 'hex');
```

Fast hashes (MD5, SHA-1, SHA-256) are built to be fast, which is exactly what a guesser wants.

## How to recognize it

- "Can you look up my password?" (it is stored readably)
- A "forgot password" feature that sends the old password instead of a reset link
- A hash column with no salt next to it, or a hash function designed for speed

## Legitimate uses

When **your application is the client** of another service, it must present that service's password, so it
needs a reversible form. Encrypt it (with a key kept outside the database) rather than storing plain text.
A small internal tool may only need *identification*, not strong *authentication*, until it leaves the intranet.

## Solution: store a salted, slow hash

Postgres's `pgcrypto` extension has `crypt()` and `gen_salt()`. Bcrypt (`'bf'`) generates a random salt per
password, embeds it and the cost factor in the result, and is deliberately slow:

```sql
-- set or change a password
UPDATE accounts SET password_hash = crypt('new password', gen_salt('bf', 10))
WHERE account_id = 123;

-- verify: hash the input with the stored salt, compare with the stored value
SELECT password_hash = crypt('typed password', password_hash) AS ok
FROM accounts WHERE account_id = 123;
```

Because every row has its own salt, one precomputed table no longer cracks everyone: each guess must be
hashed separately per account, at bcrypt speed. Better still, hash in the application and send only the
result (or use a library such as Argon2 or bcrypt in app code) so the plain text never appears in SQL logs.

For forgotten passwords, **reset instead of recover**: store a random single-use token with an expiry, mail a
link containing it, and let the user choose a new password. Nobody ever needs to read the old one.

## Mini-antipattern: storing hash strings in VARCHAR

A given hash algorithm always produces the same length. SHA-256 is 32 bytes: 64 hex characters, 43 in base64,
or 32 raw bytes. In Postgres, `bytea` holds the raw bytes in half the space of hex (`decode(hex, 'hex')`).
Bcrypt output from `crypt()` is always 60 characters. `varchar(255)` is just a guess, while a fixed type
documents the format.

## Exercise: Crack the unsalted hashes

`accounts.password_hash` holds an **unsalted** SHA-256 hex digest. `pw_wordlist` is a short list of common
passwords. Show why that's dangerous: return `account_id, account_name, word` for every account whose
password is in the wordlist.

```sql starter
SELECT a.account_id, a.account_name, w.word
FROM accounts a
JOIN pw_wordlist w ON a.password_hash = w.word;
```

```sql reference
SELECT a.account_id, a.account_name, w.word
FROM accounts a
JOIN pw_wordlist w ON a.password_hash = encode(sha256(w.word::bytea), 'hex')
```

```sql solution
SELECT a.account_id, a.account_name, w.word
FROM accounts a
JOIN pw_wordlist w ON a.password_hash = encode(sha256(convert_to(w.word, 'UTF8')), 'hex');
```

> Hint: The column stores a hash, not the password. Hash every candidate word the same way and compare.

> Hint: `sha256()` takes `bytea` and returns `bytea`. `encode(..., 'hex')` turns it into the 64-character text stored in the column.

## Exercise: Migrate to bcrypt and verify a login

In Setup, create `pw_accounts(account_id, password_hash)` for accounts 1-20 holding a **bcrypt** hash of each
password (the passwords are `'secret' || account_id`). Then, in the Query, verify a login the right way:
return the `account_id` of every row in `pw_accounts` where the password `secret7` is correct.

```sql starter-setup
CREATE TABLE pw_accounts AS
SELECT account_id, password_hash FROM accounts WHERE account_id <= 20;
```

```sql starter
SELECT account_id FROM pw_accounts
WHERE password_hash = encode(sha256('secret7'::bytea), 'hex');
```

```sql reference
SELECT 7::bigint AS account_id
```

```sql solution-setup
CREATE TABLE pw_accounts AS
SELECT account_id, crypt('secret' || account_id, gen_salt('bf', 4)) AS password_hash
FROM accounts WHERE account_id <= 20;
```

```sql solution
SELECT account_id FROM pw_accounts
WHERE password_hash = crypt('secret7', password_hash);
```

```meta
require: gen_salt\s*\(\s*'bf' | Hash with bcrypt: crypt(pw, gen_salt('bf'))
require: crypt\s*\(\s*'secret7'\s*,\s*password_hash\s*\) | Verify with crypt(input, stored) = stored
```

> Hint: `crypt(password, gen_salt('bf'))` makes a new random salt for each row. A cost of 4 keeps this exercise fast; use 10 or more for real systems.

> Hint: To check a login, pass the **stored hash** as the salt: `crypt(input, password_hash)`. It reads the salt and cost from it.

## Quiz

### Why does an unsalted SHA-256 hash fall to a dictionary attack?

- [ ] SHA-256 can be reversed with the right key
- [x] Equal passwords always give equal hashes, so one precomputed table of common-password hashes matches every account at once
- [ ] 64 hex characters are too short to be secure
- [ ] Postgres stores hashes in plain text in the WAL

> Without a per-row salt, an attacker hashes each candidate once and joins. A salt forces separate work per account.

### How do you verify a password stored as `crypt(pw, gen_salt('bf'))`?

- [ ] `password_hash = crypt(input, gen_salt('bf'))`
- [x] `password_hash = crypt(input, password_hash)`
- [ ] `decrypt(password_hash) = input`
- [ ] `password_hash = sha256(input)`

> A fresh `gen_salt()` makes a different hash every time. Passing the stored value reuses its salt and cost.

### A user forgot their password. What should the application do?

- [ ] Email them the stored password
- [ ] Have support read it to them on the phone after checking their name
- [x] Send a single-use, expiring reset link to the address already on the account
- [ ] Reset it to their username

> Reset, don't recover. The old password is never readable, and the link goes only to the account's owner.

### What's the best Postgres type for a raw SHA-256 digest?

- [ ] `varchar(255)`
- [ ] `text`
- [x] `bytea` (32 bytes), or `char(64)` if you keep hex
- [ ] `numeric`

> The length is fixed by the algorithm. Raw bytes take half the space of hex.
