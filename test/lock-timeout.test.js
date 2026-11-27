import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createSeries, issue, nextNumber, peek } from '../src/index.js'
import { backendPid, insertDocument, setup, waitUntilBlocked } from './db.js'

let db

before(async () => {
  db = await setup()
})

after(async () => {
  await db.cleanup()
})

const documents = (scope) =>
  db.pool
    .query('SELECT seq_no::int AS n FROM documents WHERE scope = $1 ORDER BY seq_no', [scope])
    .then((res) => res.rows.map((row) => row.n))

// Settles to { error } or { value } so a test can wait for the server to give up on a lock.
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }))

// A pool of one connection, so a rejected issue() that did not return its connection would hang the next call,
// plus the pid of that connection to ask the server who blocks it.
async function singleConnectionPool(options) {
  const pool = db.newPool(options, 1)
  const probe = await pool.connect()
  const pid = await backendPid(probe)
  probe.release()
  return { pool, pid }
}

test('a waiter behind a stuck issuer fails with 55P03, gives its connection back and leaves the counter alone', { timeout: 30_000 }, async () => {
  const key = { scope: 'tenant-timeout', series: 'INV' }
  await createSeries(db.pool, key)
  const waiter = await singleConnectionPool()
  const holder = await db.pool.connect()
  try {
    const holderPid = await backendPid(holder)
    await holder.query('BEGIN')
    assert.equal(await nextNumber(holder, key), 1)
    await insertDocument(holder, key, 1, 'holder')

    let ran = false
    const waiting = settle(
      issue(waiter.pool, key, async () => { ran = true }, { lockTimeout: 2000 })
    )
    // The server reports the wait before the limit is reached, so the timeout below is the one that is tested.
    await waitUntilBlocked(db.pool, waiter.pid, holderPid)
    const { error } = await waiting

    assert.equal(error?.code, '55P03')
    assert.equal(ran, false, 'fn must not run when the row lock was never granted')
    assert.equal(waiter.pool.idleCount, 1, 'the connection is back in the pool')
    assert.equal(waiter.pool.waitingCount, 0)
    assert.equal(await peek(db.pool, key), 0, 'the holder has not committed and the waiter took nothing')

    await holder.query('COMMIT')
  } finally {
    await holder.query('ROLLBACK').catch(() => {})
    holder.release()
  }

  assert.equal(await peek(db.pool, key), 1)
  // The same connection serves the next issuer, and the numbers carry on without a gap.
  const next = await issue(waiter.pool, key, async (client, n) => {
    await insertDocument(client, key, n, 'after')
    return { n, pid: await backendPid(client) }
  })
  assert.deepEqual(next, { n: 2, pid: waiter.pid })
  assert.equal(await peek(db.pool, key), 2)
  assert.deepEqual(await documents(key.scope), [1, 2])
})

test('the limit also covers a lock that fn waits for, and the number goes back', { timeout: 30_000 }, async () => {
  const key = { scope: 'tenant-inner', series: 'inner' }
  await createSeries(db.pool, key)
  const waiter = await singleConnectionPool()
  const holder = await db.pool.connect()
  try {
    const holderPid = await backendPid(holder)
    await holder.query('BEGIN')
    // An uncommitted document with the request key that fn is about to insert: the unique index makes fn wait.
    await insertDocument(holder, { scope: 'tenant-inner', series: 'other' }, 1, 'same-request')

    const waiting = settle(
      issue(waiter.pool, key, (client, n) => insertDocument(client, { scope: 'tenant-inner', series: 'other' }, n, 'same-request'), { lockTimeout: 2000 })
    )
    await waitUntilBlocked(db.pool, waiter.pid, holderPid)
    const { error } = await waiting

    assert.equal(error?.code, '55P03')
    assert.equal(await peek(db.pool, key), 0)
  } finally {
    await holder.query('ROLLBACK').catch(() => {})
    holder.release()
  }
  assert.equal(await issue(waiter.pool, key, async (_, n) => n), 1)
})

test('lockTimeout lasts for one transaction and 0 switches the limit off', async () => {
  const key = { scope: 'tenant-timeout', series: 'scope' }
  await createSeries(db.pool, key)
  const read = (client) => client.query('SHOW lock_timeout').then((res) => res.rows[0].lock_timeout)
  const { pool } = await singleConnectionPool('-c lock_timeout=300')

  assert.equal(await issue(pool, key, read), '300ms', 'no option: the session setting applies')
  assert.equal(await issue(pool, key, read, { lockTimeout: 750 }), '750ms')
  assert.equal(await issue(pool, key, read), '300ms', 'the limit ended with its transaction')
  assert.equal(await issue(pool, key, read, { lockTimeout: 0 }), '0', '0 overrides the session setting')
  assert.equal(await issue(pool, key, read, {}), '300ms')
  assert.equal(await issue(pool, key, read, { lockTimeout: 2147483647 }), '2147483647ms')
  assert.equal(await peek(db.pool, key), 6)
})

test('a bad lockTimeout is rejected before any connection is taken', async () => {
  const untouched = {
    connect: () => assert.fail('connected'),
    query: () => assert.fail('queried'),
  }
  const key = { scope: 'a', series: 'b' }
  const fn = async () => {}
  for (const lockTimeout of [-1, 1.5, NaN, Infinity, -Infinity, 2147483648, 1e21, '100', null, true, [], {}]) {
    await assert.rejects(issue(untouched, key, fn, { lockTimeout }), RangeError, `lockTimeout ${String(lockTimeout)}`)
  }
  for (const options of [5, 'lockTimeout', null, true]) {
    await assert.rejects(issue(untouched, key, fn, options), TypeError, `options ${String(options)}`)
  }
})
