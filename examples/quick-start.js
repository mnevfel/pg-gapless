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
