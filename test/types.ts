// Compiled by `npm run types`, never run: checks src/index.d.ts against real use.
import pg from 'pg'
import {
  createSeries,
  install,
  isUniqueViolation,
  issue,
  nextNumber,
  peek,
  schemaSql,
  SeriesNotFoundError,
  TransactionAbortedError,
} from 'pg-gapless'

const pool = new pg.Pool()
const key = { scope: 'acme', series: '2026' }

export async function check(): Promise<void> {
  await install(pool)
  const created: boolean = await createSeries(pool, { ...key, startAt: 1000 })
  const id: string = await issue(pool, key, async (client, number: number) => {
    await client.query('INSERT INTO invoices (number) VALUES ($1)', [number])
    return `INV-${number}`
  })
  const client = await pool.connect()
  const n: number = await nextNumber(client, key)
  client.release()
  const last: number | null = await peek(pool, key)
  const sql: string = schemaSql

  try {
    await issue(pool, key, async () => 0)
  } catch (err) {
    if (isUniqueViolation(err, 'invoices_request_id_key')) {
      const constraint: string | undefined = err.constraint
    }
    if (err instanceof SeriesNotFoundError || err instanceof TransactionAbortedError) {
      const code: 'GAPLESS_SERIES_NOT_FOUND' | 'GAPLESS_TX_ABORTED' = err.code
    }
  }

  // @ts-expect-error issue() needs a pool, not a client
  await issue(client, key, async () => 0)
  // @ts-expect-error scope and series are both required
  await peek(pool, { scope: 'acme' })
  // @ts-expect-error fn receives a number
  await issue(pool, key, async (_client, number: string) => number)
  void [created, id, n, last, sql]
}
