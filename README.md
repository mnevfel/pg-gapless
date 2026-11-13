# pg-gapless

Gapless (gap-free) sequential document numbers in PostgreSQL for Node.js: invoice and receipt numbers that never skip, even when a transaction fails or a request is retried. ESM only, Node 22 or newer. No runtime dependencies; `pg` is a peer.

## Quick start

```sh
npm install pg-gapless pg
```

```js
import pg from 'pg'
import { createSeries, install, issue } from 'pg-gapless'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
await install(pool) // in an application, run this from a migration
await pool.query('CREATE TABLE IF NOT EXISTS invoices (number bigint PRIMARY KEY, total_cents bigint NOT NULL)')

const key = { scope: 'acme', series: '2026' }
await createSeries(pool, key)
const store = (cents) => async (client, number) => {
  await client.query('INSERT INTO invoices VALUES ($1, $2)', [number, cents])
  return number
}

console.log(await issue(pool, key, store(12000)))
await issue(pool, key, async () => { throw new Error('PDF render failed') }).catch((e) => console.log(e.message))
console.log(await issue(pool, key, store(7550)))
await pool.end()
```

On an empty database it prints:

```
1
PDF render failed
2
```

The invoice that failed did not use up a number.

## Why

A PostgreSQL sequence cannot give gapless numbers. `nextval()` is never rolled back, so every aborted transaction, crash and `INSERT ... ON CONFLICT` leaves a hole. Some jurisdictions require invoice numbers to run without gaps, and where they do, a hole is a question from an auditor. The usual fix is a counter row that is incremented inside the transaction that stores the document. I wrote the pattern up in [Gapless invoice numbering in PostgreSQL without a sequence](https://mnevfel.com/snippets/gapless-invoice-numbering-postgresql/); this package is that pattern with its edge cases under test.

## How it works

- Each series is one row in `gapless_counters`, keyed by `scope` (a tenant or company) and `series` (a book or year).
- `issue()` opens a READ COMMITTED transaction, increments the row with `UPDATE ... RETURNING`, calls your function with the number and commits. The row lock makes the next issuer of that series wait until this transaction ends.
- If your function throws, the transaction rolls back and the increment with it, so the next issuer gets the same number.
- If your function catches a failed query and carries on, PostgreSQL has already aborted the transaction and answers COMMIT with a rollback. `issue()` checks for that and throws `TransactionAbortedError` instead of returning a number that was never stored.
- If the connection drops while your function runs, the call rejects and the connection is discarded. The server rolls the transaction back when it sees the session is gone. If it drops while COMMIT is on its way, the outcome is unknown: the document may be stored although the call rejected, and the request key below is what makes the retry safe.
- READ COMMITTED is set explicitly. Under REPEATABLE READ or SERIALIZABLE the waiting issuer would fail with SQLSTATE 40001 instead of waiting; the tests show both.
- Series in different scopes are different rows and never wait for each other.
- `gapless_next(scope, series)` does the same step in SQL, for code outside Node.

Give the number a unique constraint in your document table, such as `UNIQUE (scope, series, number)`. A mistake anywhere else, like a counter restored from an older backup, then fails loudly instead of storing a second document with the same number.

**Retries.** Give each document a unique request key. A retried request then fails with 23505 inside the transaction, the number goes back, and you return the document that was already stored. A sketch, with `insertInvoice` and `findInvoiceByRequestId` standing for your own code:

```js
try {
  return await issue(pool, key, (client, number) => insertInvoice(client, number, requestId))
} catch (err) {
  if (!isUniqueViolation(err, 'invoices_request_id_key')) throw err
  return findInvoiceByRequestId(requestId)
}
```

**Dates.** Stamp the document with `issued_at timestamptz DEFAULT clock_timestamp()`, not `now()`. `now()` is the time the transaction started, and a transaction that starts first can take its number second, so `now()` can run backwards across numbers; a test shows it. `clock_timestamp()` follows the server clock, so only a clock step back can break the order. The number is the order, the time is a label.

## What the tests prove

The tests run against a real PostgreSQL:

- 50 concurrent issuers on one series get 1 to 50, with no gap, no duplicate and `issued_at` in number order.
- When every fifth of 40 concurrent issuers fails, the 32 stored documents are numbered 1 to 32.
- A second issuer on a series waits for the first to commit, then gets the next number.
- A function that throws, a query error it catches, a COMMIT that fails and a connection that drops all leave the counter where it was.
- A retried request with the same request key fails with 23505 and uses no number.
- Under REPEATABLE READ and SERIALIZABLE the waiting issuer fails with 40001. With SERIALIZABLE as the session default, `issue()` still waits its turn.
- `now()` runs backwards across numbers and `clock_timestamp()` does not.
- `peek()` reads a series that another transaction holds without waiting.
- The Quick start above prints what it says.

`npm run mutate` then breaks the library one guard at a time, such as the explicit READ COMMITTED, the ROLLBACK, the COMMIT check and the error listener, and fails if the tests miss any of them. CI runs it on every push to main and on every pull request.

## API

| Function | Returns |
|---|---|
| `install(db)` | Creates the table if it is missing and creates or replaces `gapless_next()`. Run it from a migration, not from every process at start-up, since two installs at once can collide. The same SQL is in `sql/schema.sql`, exported as `schemaSql` and as `pg-gapless/schema.sql` for migration tools. Both are created in the first schema of the `search_path`. |
| `createSeries(db, { scope, series, startAt = 1 })` | `true` if created, `false` if the series existed. An existing series is never changed. |
| `issue(pool, { scope, series }, fn)` | What `fn(client, number)` returns. |
| `nextNumber(client, { scope, series })` | The next number, for code that runs its own transaction. Call it after `BEGIN` on the same client; outside a transaction the increment commits at once and a later failure leaves a gap. |
| `peek(db, { scope, series })` | The last number handed out (`startAt - 1`, so 0 by default, before the first one), or `null` if the series does not exist. Takes no lock. |
| `isUniqueViolation(err, constraint?)` | `true` for a 23505 error, optionally on one constraint. |
| `SeriesNotFoundError` | Thrown for an unknown series; `err.code` is `GAPLESS_SERIES_NOT_FOUND`. |
| `TransactionAbortedError` | Thrown by `issue()` when `fn` caught a failed query, so nothing was committed; `err.code` is `GAPLESS_TX_ABORTED`. |

`db` is anything with a `query()` method (a pool or a client). `issue()` needs a `pg.Pool`, because it holds one connection for the whole transaction.

## Limits

- One issuer per series at a time. Keep the transaction short: render PDFs and call payment gateways after the commit, not inside `fn`.
- `fn` must run its queries on the client it is given and leave COMMIT and ROLLBACK to `issue()`. A `pool.query()` inside `fn` needs a second connection, and with the pool full of waiting issuers it never gets one.
- A failed query inside `fn` aborts the transaction. To recover from one and keep the number, run it inside a `SAVEPOINT`.
- A transaction that takes numbers from several series must take them in the same order every time, or two of them can deadlock (40P01).
- A session left idle inside a transaction holds its series until it ends. Set `idle_in_transaction_session_timeout` and `lock_timeout` for the role that issues numbers.
- With asynchronous replication, a failover can lose the last commits, so numbers already sent to customers can be issued again. Where that matters, issue numbers with synchronous replication.
- Numbers are JavaScript numbers. A counter above `Number.MAX_SAFE_INTEGER` throws.
- Formatting (prefix, padding, the year) is yours to do. Store the integer.
- Deleting a committed document leaves a gap. Cancel or credit it instead.
- Whether a series has to be gapless depends on the jurisdiction. That is usually your accountant's call, and a plain sequence is simpler where gaps are allowed.
- Tested in CI on Node 22 and 24 with PostgreSQL 15, 17 and 18, and with pg 8.8.0 as the oldest driver. Not tested on PostgreSQL 14 or older, or through a connection pooler in transaction mode.

## Development

```sh
npm ci
export DATABASE_URL=postgresql://localhost/postgres
npm test
npm run types
npm run mutate
```

The tests create and drop their own schemas in that database. After editing `sql/schema.sql`, run `npm run schema`.

## License

MIT. See [LICENSE](LICENSE).
