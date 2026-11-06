import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createSeries, issue, peek } from '../src/index.js'
import { range, setup, sleep } from './db.js'

let db

before(async () => {
  db = await setup()
})

after(async () => {
  await db.cleanup()
})

test('issue() waits its turn when the session default is SERIALIZABLE', async () => {
  const strict = db.newPool('-c default_transaction_isolation=serializable')
  const key = { scope: 'tenant-s', series: 'INV' }
  await createSeries(strict, key)
  const numbers = await Promise.all(
    range(1, 20).map(() =>
      issue(strict, key, async (_, n) => {
        await sleep(Math.random() * 5)
        return n
      })
    )
  )
  assert.deepEqual([...numbers].sort((a, b) => a - b), range(1, 20))
})

for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
  test(`under ${level} the waiting issuer fails with 40001`, async () => {
    const key = { scope: `tenant-${level.toLowerCase().replace(' ', '-')}`, series: 'INV' }
    await createSeries(db.pool, key)
    const first = await db.pool.connect()
    const second = await db.pool.connect()
    try {
      await first.query(`BEGIN ISOLATION LEVEL ${level}`)
      await second.query(`BEGIN ISOLATION LEVEL ${level}`)
      // Take the snapshot of the second transaction before the first one commits.
      await second.query('SELECT 1 FROM gapless_counters LIMIT 1')
      await first.query('SELECT gapless_next($1, $2)', [key.scope, key.series])
      const waiting = second.query('SELECT gapless_next($1, $2)', [key.scope, key.series]).catch((e) => e)
      await sleep(100)
      await first.query('COMMIT')
      const err = await waiting
      assert.equal(err.code, '40001')
      await second.query('ROLLBACK')
    } finally {
      first.release()
      second.release()
    }
    assert.equal(await peek(db.pool, key), 1)
  })
}

test('the schema carries its version marker', async () => {
  const { rows } = await db.pool.query(
    "SELECT obj_description('gapless_counters'::regclass, 'pg_class') AS marker"
  )
  assert.equal(rows[0].marker, 'pg-gapless schema 1')
})

test('gapless_next() in SQL follows the same rules', async () => {
  const key = { scope: 'tenant-q', series: 'INV' }
  await createSeries(db.pool, key)
  const client = await db.pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query("SELECT gapless_next('tenant-q', 'INV')::int AS n")
    assert.equal(rows[0].n, 1)
    await client.query('ROLLBACK')
    assert.equal(await peek(db.pool, key), 0)

    const err = await client.query("SELECT gapless_next('tenant-q', 'missing')").catch((e) => e)
    assert.equal(err.code, 'P0002')
  } finally {
    client.release()
  }
})
