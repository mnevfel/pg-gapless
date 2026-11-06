import type { DatabaseError, Pool, PoolClient, QueryResult } from 'pg'

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<QueryResult>
}

export interface SeriesKey {
  scope: string
  series: string
}

export declare const schemaSql: string

export declare class SeriesNotFoundError extends Error {
  readonly code: 'GAPLESS_SERIES_NOT_FOUND'
  readonly scope: string
  readonly series: string
}

/** Thrown by issue() when fn caught a failed query: the transaction was already aborted, so nothing was committed and the number was not used. */
export declare class TransactionAbortedError extends Error {
  readonly code: 'GAPLESS_TX_ABORTED'
  readonly scope: string
  readonly series: string
}

/** Creates the gapless_counters table and the gapless_next() SQL function if they are missing. */
export declare function install(db: Queryable): Promise<void>

/** Creates a series whose first number is startAt (default 1). Returns false if it already existed; an existing series is never changed. */
export declare function createSeries(db: Queryable, key: SeriesKey & { startAt?: number }): Promise<boolean>

/** Takes the next number. Call it inside an open transaction; the number returns to the series if that transaction rolls back. */
export declare function nextNumber(client: Queryable, key: SeriesKey): Promise<number>

/** Runs fn in a READ COMMITTED transaction with the next number of the series. Commits when fn resolves, rolls back and rethrows when it rejects. fn must run its queries on the client it is given. */
export declare function issue<T>(pool: Pool, key: SeriesKey, fn: (client: PoolClient, number: number) => Promise<T>): Promise<T>

/** The last number handed out, or null if the series does not exist. Takes no lock. */
export declare function peek(db: Queryable, key: SeriesKey): Promise<number | null>

/** True for a PostgreSQL unique violation (23505), optionally on the named constraint. */
export declare function isUniqueViolation(err: unknown, constraint?: string): err is DatabaseError & { code: '23505' }
