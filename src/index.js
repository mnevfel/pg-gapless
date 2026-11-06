import { schemaSql } from './schema.js'

export { schemaSql }

export class SeriesNotFoundError extends Error {
  constructor(scope, series) {
    super(`gapless series ${scope} / ${series} does not exist`)
    this.name = 'SeriesNotFoundError'
    this.code = 'GAPLESS_SERIES_NOT_FOUND'
    this.scope = scope
    this.series = series
  }
}

export class TransactionAbortedError extends Error {
  constructor(scope, series) {
    super(`transaction for gapless series ${scope} / ${series} was aborted by an earlier error and rolled back`)
    this.name = 'TransactionAbortedError'
    this.code = 'GAPLESS_TX_ABORTED'
    this.scope = scope
    this.series = series
  }
}

export async function install(db) {
  await db.query(schemaSql)
}

export async function createSeries(db, key) {
  const { scope, series } = checkKey(key)
  const { startAt = 1 } = key
  if (!Number.isSafeInteger(startAt) || startAt < 1) {
    throw new RangeError('startAt must be a positive safe integer')
  }
  // DO NOTHING keeps an existing series untouched, so this is safe to run on every deploy.
  const res = await db.query(
    `INSERT INTO gapless_counters (scope, series, last_value)
     VALUES ($1, $2, $3)
     ON CONFLICT (scope, series) DO NOTHING`,
    [scope, series, startAt - 1]
  )
  return res.rowCount === 1
}

// Must run inside the caller's transaction: the row lock it takes is what
// orders concurrent issuers, and the rollback of that transaction is what
// gives the number back.
export async function nextNumber(client, key) {
  const { scope, series } = checkKey(key)
  const res = await client.query(
    `UPDATE gapless_counters
        SET last_value = last_value + 1
      WHERE scope = $1 AND series = $2
     RETURNING last_value::text AS n`,
    [scope, series]
  )
  if (res.rowCount === 0) throw new SeriesNotFoundError(scope, series)
  return toNumber(res.rows[0].n)
}

export async function issue(pool, key, fn) {
  if (typeof pool?.connect !== 'function') {
    throw new TypeError('issue() needs a pg Pool; inside your own transaction use nextNumber()')
  }
  const { scope, series } = checkKey(key)
  if (typeof fn !== 'function') throw new TypeError('issue() needs a function that stores the document')

  const client = await pool.connect()
  let broken = false
  // A checked-out client has no 'error' listener of its own, so a connection
  // that dies while fn awaits something else would crash the process.
  const onError = () => {
    broken = true
  }
  client.on('error', onError)
  try {
    let result, done
    try {
      // Explicit READ COMMITTED: under REPEATABLE READ or SERIALIZABLE the
      // second issuer on a series fails with 40001 instead of waiting its turn.
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const number = await nextNumber(client, key)
      result = await fn(client, number)
      done = await client.query('COMMIT')
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        broken = true
      }
      throw err
    }
    // If fn caught a failed query, the transaction was already aborted and
    // PostgreSQL answers COMMIT with ROLLBACK instead of an error.
    if (done.command === 'ROLLBACK') throw new TransactionAbortedError(scope, series)
    return result
  } finally {
    client.off('error', onError)
    client.release(broken)
  }
}

export async function peek(db, key) {
  const { scope, series } = checkKey(key)
  const res = await db.query(
    'SELECT last_value::text AS n FROM gapless_counters WHERE scope = $1 AND series = $2',
    [scope, series]
  )
  return res.rowCount === 0 ? null : toNumber(res.rows[0].n)
}

export function isUniqueViolation(err, constraint) {
  return err?.code === '23505' && (constraint === undefined || err.constraint === constraint)
}

function checkKey(key) {
  const { scope, series } = key ?? {}
  if (typeof scope !== 'string' || scope === '' || typeof series !== 'string' || series === '') {
    throw new TypeError('scope and series must be non-empty strings')
  }
  return { scope, series }
}

function toNumber(text) {
  const n = Number(text)
  if (!Number.isSafeInteger(n)) throw new RangeError(`counter value ${text} is above Number.MAX_SAFE_INTEGER`)
  return n
}
