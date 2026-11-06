import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { install } from '../src/index.js'

const url = process.env.DATABASE_URL

// Each test file gets its own schema, so files can run in parallel against one database.
export async function setup() {
  if (!url) throw new Error('Set DATABASE_URL to a database the tests may create schemas in')
  const schema = 'gapless_test_' + randomBytes(4).toString('hex')
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pools = []
  const pool = (options = '', max = 10) => {
    const p = new pg.Pool({ connectionString: url, max, options: `-c search_path=${schema} ${options}` })
    pools.push(p)
    return p
  }
  const main = pool()
  await install(main)
  await main.query(`
    CREATE TABLE documents (
      id              serial      PRIMARY KEY,
      scope           text        NOT NULL,
      series          text        NOT NULL,
      seq_no          bigint      NOT NULL,
      idempotency_key text        NOT NULL,
      issued_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (scope, series, seq_no),
      UNIQUE (scope, idempotency_key)
    )`)
  return {
    pool: main,
    newPool: pool,
    async cleanup() {
      await Promise.all(pools.map((p) => p.end()))
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    },
  }
}

export function insertDocument(client, { scope, series }, number, key) {
  return client.query(
    'INSERT INTO documents (scope, series, seq_no, idempotency_key) VALUES ($1, $2, $3, $4)',
    [scope, series, number, key]
  )
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

// Polls until check() returns true, so a test can wait for a state in another session.
export async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`condition not met within ${ms} ms`)
    await sleep(20)
  }
}

// Ends the server session behind client from another connection, the way a
// failover or a server restart would.
export async function terminate(pool, client) {
  const { rows } = await client.query('SELECT pg_backend_pid() AS pid')
  await pool.query('SELECT pg_terminate_backend($1)', [rows[0].pid])
}
