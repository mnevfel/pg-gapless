import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createSeries, issue, peek, TransactionAbortedError } from '../src/index.js'
import { setup, sleep, terminate } from './db.js'

let db

before(async () => {
  db = await setup()
})

after(async () => {
  await db.cleanup()
})

test('a failed query that fn catches does not hand out a number', async () => {
  const key = { scope: 'tenant-f', series: 'caught' }
  await createSeries(db.pool, key)
  const err = await issue(db.pool, key, async (client, n) => {
    await client.query('SELECT 1 / 0').catch(() => {})
    return n
  }).catch((e) => e)
  assert.ok(err instanceof TransactionAbortedError)
  assert.equal(err.code, 'GAPLESS_TX_ABORTED')
  assert.equal(await peek(db.pool, key), 0)

  // A savepoint is the way to recover from a failed query inside fn.
  const n = await issue(db.pool, key, async (client, n) => {
    await client.query('SAVEPOINT attempt')
    await client.query('SELECT 1 / 0').catch(() => client.query('ROLLBACK TO SAVEPOINT attempt'))
    return n
  })
  assert.equal(n, 1)
  assert.equal(await peek(db.pool, key), 1)
})

test('a COMMIT that fails gives the number back', async () => {
  const key = { scope: 'tenant-f', series: 'deferred' }
  await createSeries(db.pool, key)
  await db.pool.query('CREATE TABLE owners (id int PRIMARY KEY)')
  await db.pool.query(
    'CREATE TABLE owned (seq_no bigint PRIMARY KEY, owner int REFERENCES owners DEFERRABLE INITIALLY DEFERRED)'
  )
  const err = await issue(db.pool, key, (client, n) =>
    client.query('INSERT INTO owned VALUES ($1, 42)', [n])
  ).catch((e) => e)
  assert.equal(err.code, '23503')
  assert.equal(await peek(db.pool, key), 0)
  assert.equal(await issue(db.pool, key, async (_, n) => n), 1)
})

test('a connection that dies while fn runs rejects the call and is not reused', async () => {
  const key = { scope: 'tenant-f', series: 'dropped' }
  await createSeries(db.pool, key)
  const small = db.newPool('', 2)
  const err = await issue(small, key, async (client, n) => {
    await terminate(db.pool, client)
    await sleep(200) // the connection drops while fn awaits something else
    return n
  }).catch((e) => e)
  assert.ok(err instanceof Error)
  assert.equal(small.totalCount, 0)
  assert.equal(await peek(db.pool, key), 0)
  assert.equal(await issue(small, key, async (_, n) => n), 1)
})

test('when ROLLBACK fails too, the original error is thrown and the client destroyed', async () => {
  const key = { scope: 'tenant-f', series: 'unreachable' }
  await createSeries(db.pool, key)
  const small = db.newPool('', 2)
  const boom = new Error('render failed')
  await assert.rejects(
    issue(small, key, async (client) => {
      await terminate(db.pool, client)
      await sleep(200)
      throw boom
    }),
    boom
  )
  assert.equal(small.totalCount, 0)
  assert.equal(await peek(db.pool, key), 0)
})
