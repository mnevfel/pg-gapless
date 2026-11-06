import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createSeries, issue, isUniqueViolation, nextNumber, peek, SeriesNotFoundError } from '../src/index.js'
import { insertDocument, range, setup, sleep, waitFor } from './db.js'

let db

before(async () => {
  db = await setup()
})

after(async () => {
  await db.cleanup()
})

test('50 concurrent issuers get 1 to 50 with no gap or duplicate', async () => {
  const key = { scope: 'tenant-a', series: 'INV' }
  await createSeries(db.pool, key)
  const numbers = await Promise.all(
    range(1, 50).map((i) =>
      issue(db.pool, key, async (client, n) => {
        await sleep(Math.random() * 5)
        await insertDocument(client, key, n, `req-${i}`)
        return n
      })
    )
  )
  assert.deepEqual([...numbers].sort((a, b) => a - b), range(1, 50))

  const { rows } = await db.pool.query(
    "SELECT seq_no::int, issued_at FROM documents WHERE scope = 'tenant-a' AND series = 'INV' ORDER BY seq_no"
  )
  assert.deepEqual(rows.map((r) => r.seq_no), range(1, 50))
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].issued_at >= rows[i - 1].issued_at, `issued_at goes back at seq_no ${rows[i].seq_no}`)
  }
})

test('a rolled back transaction gives its number back', async () => {
  const key = { scope: 'tenant-a', series: 'rollback' }
  await createSeries(db.pool, key)
  assert.equal(await issue(db.pool, key, async (_, n) => n), 1)

  const boom = new Error('render failed')
  await assert.rejects(
    issue(db.pool, key, async () => {
      throw boom
    }),
    boom
  )
  assert.equal(await peek(db.pool, key), 1)
  assert.equal(await issue(db.pool, key, async (_, n) => n), 2)
})

test('committed numbers stay contiguous when every fifth issuer fails', async () => {
  const key = { scope: 'tenant-a', series: 'mixed' }
  await createSeries(db.pool, key)
  const results = await Promise.allSettled(
    range(1, 40).map((i) =>
      issue(db.pool, key, async (client, n) => {
        await sleep(Math.random() * 5)
        if (i % 5 === 0) throw new Error(`issuer ${i} failed`)
        await insertDocument(client, key, n, `mixed-${i}`)
        return n
      })
    )
  )
  assert.equal(results.filter((r) => r.status === 'rejected').length, 8)
  const { rows } = await db.pool.query(
    "SELECT seq_no::int FROM documents WHERE scope = 'tenant-a' AND series = 'mixed' ORDER BY seq_no"
  )
  assert.deepEqual(rows.map((r) => r.seq_no), range(1, 32))
  assert.equal(await peek(db.pool, key), 32)
})

test('a retried request hits the idempotency key and does not consume a number', async () => {
  const key = { scope: 'tenant-b', series: 'INV' }
  await createSeries(db.pool, key)
  const store = (client, n) => insertDocument(client, key, n, 'order-7')
  await issue(db.pool, key, store)

  const err = await issue(db.pool, key, store).catch((e) => e)
  assert.ok(isUniqueViolation(err, 'documents_scope_idempotency_key_key'))
  assert.equal(isUniqueViolation(err, 'some_other_constraint'), false)
  assert.equal(await peek(db.pool, key), 1)
})

test('a second issuer on the same series waits for the first to commit', async () => {
  const key = { scope: 'tenant-c', series: 'wait' }
  await createSeries(db.pool, key)
  const holder = await db.pool.connect()
  try {
    await holder.query('BEGIN')
    assert.equal(await nextNumber(holder, key), 1)
    const { rows } = await holder.query('SELECT pg_backend_pid() AS pid')
    const second = issue(db.pool, key, async (_, n) => n)
    await waitFor(async () => {
      const res = await db.pool.query(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))',
        [rows[0].pid]
      )
      return res.rows[0].n === 1
    })
    await holder.query('COMMIT')
    assert.equal(await second, 2)
  } finally {
    await holder.query('ROLLBACK').catch(() => {})
    holder.release()
  }
})

test('now() can run backwards across numbers, clock_timestamp() does not', async () => {
  const key = { scope: 'tenant-c', series: 'dates' }
  await createSeries(db.pool, key)
  const stamp = async (client, n) => {
    const { rows } = await client.query('SELECT now() AS tx, clock_timestamp() AS clock')
    return { n, ...rows[0] }
  }
  const early = await db.pool.connect()
  try {
    await early.query('BEGIN') // starts first, takes its number second
    await sleep(20)
    const first = await issue(db.pool, key, stamp)
    await sleep(20)
    const second = await stamp(early, await nextNumber(early, key))
    await early.query('COMMIT')
    assert.deepEqual([first.n, second.n], [1, 2])
    assert.ok(second.tx < first.tx)
    assert.ok(second.clock > first.clock)
  } finally {
    await early.query('ROLLBACK').catch(() => {})
    early.release()
  }
})

test('a held series does not block another scope', async () => {
  const held = { scope: 'tenant-c', series: 'INV' }
  const other = { scope: 'tenant-d', series: 'INV' }
  await createSeries(db.pool, held)
  await createSeries(db.pool, other)

  const client = await db.pool.connect()
  try {
    await client.query('BEGIN')
    assert.equal(await nextNumber(client, held), 1)
    const timeout = sleep(2000).then(() => 'blocked')
    const done = issue(db.pool, other, async (_, n) => n)
    assert.equal(await Promise.race([done, timeout]), 1)
    await client.query('ROLLBACK')
  } finally {
    client.release()
  }
  assert.equal(await peek(db.pool, held), 0)
})

test('peek() reads without waiting for a held series and gives null for an unknown one', async () => {
  const key = { scope: 'tenant-d', series: 'peek' }
  await createSeries(db.pool, key)
  const holder = await db.pool.connect()
  try {
    await holder.query('BEGIN')
    await nextNumber(holder, key)
    const timeout = sleep(1000).then(() => 'blocked')
    assert.equal(await Promise.race([peek(db.pool, key), timeout]), 0)
  } finally {
    await holder.query('ROLLBACK').catch(() => {})
    holder.release()
  }
  assert.equal(await peek(db.pool, { scope: 'tenant-d', series: 'missing' }), null)
})

test('isUniqueViolation() is true only for 23505', () => {
  assert.equal(isUniqueViolation({ code: '23505' }), true)
  assert.equal(isUniqueViolation({ code: '23503' }), false)
  assert.equal(isUniqueViolation(null), false)
  assert.equal(isUniqueViolation(undefined), false)
})

test('issue() leaves no listener behind on a reused connection', async () => {
  const single = db.newPool('', 1)
  const key = { scope: 'tenant-d', series: 'reuse' }
  await createSeries(single, key)
  for (let i = 0; i < 3; i++) await issue(single, key, async (_, n) => n)
  const client = await single.connect()
  try {
    assert.equal(client.listenerCount('error'), 0)
  } finally {
    client.release()
  }
})

test('an unknown series throws and releases the connection', async () => {
  const err = await issue(db.pool, { scope: 'nobody', series: 'INV' }, async (_, n) => n).catch((e) => e)
  assert.ok(err instanceof SeriesNotFoundError)
  assert.equal(err.code, 'GAPLESS_SERIES_NOT_FOUND')
  assert.equal(db.pool.waitingCount, 0)
  assert.equal(db.pool.idleCount, db.pool.totalCount)
})

test('createSeries starts at startAt and never resets an existing series', async () => {
  const key = { scope: 'tenant-e', series: '2027' }
  assert.equal(await createSeries(db.pool, { ...key, startAt: 1000 }), true)
  assert.equal(await issue(db.pool, key, async (_, n) => n), 1000)
  assert.equal(await createSeries(db.pool, { ...key, startAt: 1 }), false)
  assert.equal(await issue(db.pool, key, async (_, n) => n), 1001)
  await assert.rejects(createSeries(db.pool, { ...key, startAt: 0 }), RangeError)
})

test('a counter past Number.MAX_SAFE_INTEGER throws and keeps the last safe number', async () => {
  const key = { scope: 'tenant-e', series: 'max' }
  await createSeries(db.pool, { ...key, startAt: Number.MAX_SAFE_INTEGER })
  assert.equal(await issue(db.pool, key, async (_, n) => n), Number.MAX_SAFE_INTEGER)
  await assert.rejects(issue(db.pool, key, async (_, n) => n), RangeError)
  assert.equal(await peek(db.pool, key), Number.MAX_SAFE_INTEGER)
})

test('bad arguments are rejected before any query', async () => {
  const untouched = {
    connect: () => assert.fail('connected'),
    query: () => assert.fail('queried'),
  }
  await assert.rejects(nextNumber(untouched, { scope: '', series: 'INV' }), TypeError)
  await assert.rejects(nextNumber(untouched, undefined), TypeError)
  await assert.rejects(peek(untouched, { scope: 'a' }), TypeError)
  await assert.rejects(createSeries(untouched, { scope: 'a', series: 'b', startAt: 1.5 }), RangeError)
  await assert.rejects(issue({}, { scope: 'a', series: 'b' }, async () => {}), TypeError)
  await assert.rejects(issue(untouched, undefined, async () => {}), TypeError)
  await assert.rejects(issue(untouched, { scope: 'a', series: 'b' }), TypeError)
})
