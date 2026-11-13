# Changelog

Versions follow semantic versioning. Dates are ISO dates.

## 0.1.0 (2026-11-16)

- `issue()`, `nextNumber()`, `createSeries()`, `peek()` and `install()`: gapless numbers per scope and series on a counter row, given back on rollback.
- `isUniqueViolation()`, `SeriesNotFoundError` and `TransactionAbortedError`; `createSeries()` takes a `startAt`; TypeScript types; ESM only, Node 22 or newer.
- `gapless_next(scope, series)` for SQL callers, with the schema as `sql/schema.sql` and `schemaSql`.
- Tests on a real PostgreSQL for concurrency, rollbacks, failed commits, dropped connections and isolation levels, and a mutation check of the tests.
