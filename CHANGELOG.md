# Changelog

Versions follow semantic versioning. Dates are ISO dates.

## Unreleased

- `issue(pool, key, fn, { lockTimeout })`: a waiter behind a stuck issuer now fails with SQLSTATE 55P03 after `lockTimeout` milliseconds and gives its connection back, instead of waiting forever. Without the option nothing changes.

## 0.1.0 (2026-11-13)

- `issue()`, `nextNumber()`, `createSeries()`, `peek()` and `install()`: gapless numbers per scope and series on a counter row, given back on rollback.
- `isUniqueViolation()`, `SeriesNotFoundError` and `TransactionAbortedError`; `createSeries()` takes a `startAt`; TypeScript types; ESM only, Node 22 or newer.
- `gapless_next(scope, series)` for SQL callers, with the schema as `sql/schema.sql` and `schemaSql`.
- Tests on a real PostgreSQL for concurrency, rollbacks, failed commits, dropped connections and isolation levels, and a mutation check of the tests.
