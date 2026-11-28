import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'
import { createSeries, install, nextNumber } from '../src/index.js'
import { backendPid, waitUntilBlocked } from './db.js'

const url = process.env.DATABASE_URL
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

let admin
const schemas = []

before(async () => {
  admin = new pg.Client({ connectionString: url })
  await admin.connect()
})

after(async () => {
  for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await admin.end()
})

// An empty schema and a pool that resolves the unqualified names in it.
async function emptySchema(max) {
  const schema = 'gapless_install_' + randomBytes(4).toString('hex')
  await admin.query(`CREATE SCHEMA ${schema}`)
  schemas.push(schema)
  return new pg.Pool({ connectionString: url, max, options: `-c search_path=${schema}` })
}

const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }))

test('five installs at once on an empty schema all succeed and leave one working install', { timeout: 60_000 }, async () => {
  // One round can get lucky, so the race is run on several empty schemas.
  for (let round = 0; round < 10; round++) {
    const pool = await emptySchema(5)
    try {
      const results = await Promise.all(Array.from({ length: 5 }, () => settle(install(pool))))
      assert.deepEqual(
        results.filter((r) => r.error).map((r) => r.error.message),
        [],
        `round ${round}: every install must succeed`
      )
      const { rows } = await pool.query(
        `SELECT obj_description('gapless_counters'::regclass, 'pg_class') AS marker,
                (SELECT count(*)::int FROM pg_proc WHERE proname = 'gapless_next' AND pronamespace = current_schema()::regnamespace) AS functions`
      )
      assert.deepEqual(rows, [{ marker: 'pg-gapless schema 1', functions: 1 }])
      assert.equal(await createSeries(pool, { scope: 's', series: 'INV' }), true)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        assert.equal(await nextNumber(client, { scope: 's', series: 'INV' }), 1)
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }
    } finally {
      await pool.end()
    }
  }
})

test('install() waits for the advisory lock the README documents, and runs once it is released', { timeout: 30_000 }, async () => {
  const key = readme.match(/pg_advisory_xact_lock\((\d+)\)/)[1]
  const pool = await emptySchema(1)
  const [{ schema }] = (await pool.query('SELECT current_schema() AS schema')).rows
  const probe = await pool.connect()
  const waiterPid = await backendPid(probe)
  probe.release()
  const holder = new pg.Client({ connectionString: url })
  await holder.connect()
  try {
    await holder.query('BEGIN')
    await holder.query('SELECT pg_advisory_xact_lock($1)', [key])
    const holderPid = await backendPid(holder)

    let finished = false
    const installing = install(pool).then(() => { finished = true })
    await waitUntilBlocked(admin, waiterPid, holderPid)
    assert.equal(finished, false)
    const before = await admin.query('SELECT to_regclass($1) AS t', [`${schema}.gapless_counters`])
    assert.equal(before.rows[0].t, null, 'nothing is created while the lock is held')

    await holder.query('COMMIT')
    await installing
    const after = await admin.query('SELECT to_regclass($1) AS t', [`${schema}.gapless_counters`])
    assert.notEqual(after.rows[0].t, null)
  } finally {
    await holder.end()
    await pool.end()
  }
})
