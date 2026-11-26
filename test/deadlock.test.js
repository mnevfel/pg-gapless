import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createSeries, issue, nextNumber, peek } from '../src/index.js'
import { backendPid, insertDocument, range, setup, waitUntilBlocked } from './db.js'

let db

before(async () => {
  db = await setup()
})

after(async () => {
  await db.cleanup()
})

const documents = (scope) =>
  db.pool
    .query('SELECT series, seq_no::int, idempotency_key FROM documents WHERE scope = $1 ORDER BY series, seq_no', [scope])
    .then((res) => res.rows)

// Takes the next number of one series and stores a document with it, inside the caller's transaction.
async function take(client, scope, series, request) {
  const n = await nextNumber(client, { scope, series })
  await insertDocument(client, { scope, series }, n, `${request}-${series}`)
  return n
}

// Settles to { who } or { who, error } instead of rejecting, so the two sessions can be raced.
const outcome = (who, promise) => promise.then(() => ({ who }), (error) => ({ who, error }))

test('opposite order deadlocks: one transaction fails with 40P01, and its retry leaves no gap', { timeout: 30_000 }, async () => {
  const scope = 'tenant-opposite'
  await createSeries(db.pool, { scope, series: 'X' })
  await createSeries(db.pool, { scope, series: 'Y' })
  const a = await db.pool.connect()
  const b = await db.pool.connect()
  try {
    const pid = { a: await backendPid(a), b: await backendPid(b) }
    await a.query('BEGIN')
    await b.query('BEGIN')
    assert.equal(await take(a, scope, 'X', 'a'), 1)
    assert.equal(await take(b, scope, 'Y', 'b'), 1)

    // a asks for Y, which b holds. Once the server reports that, b asks for X, which a holds: a cycle.
    const aDone = outcome('a', take(a, scope, 'Y', 'a'))
    await waitUntilBlocked(db.pool, pid.a, pid.b)
    const bDone = outcome('b', take(b, scope, 'X', 'b'))

    // Neither can finish while the other holds its row, so the first answer is the server breaking the
    // cycle (after deadlock_timeout, one second by default). Which session it picks is its own choice.
    const first = await Promise.race([aDone, bDone])
    assert.equal(first.error?.code, '40P01')
    const [loser, winner, winnerDone] = first.who === 'a' ? [a, b, bDone] : [b, a, aDone]
    const names = first.who === 'a' ? { loser: 'a', winner: 'b' } : { loser: 'b', winner: 'a' }

    // The victim's transaction is aborted but keeps its locks until it rolls back; then the survivor goes on.
    await loser.query('ROLLBACK')
    const second = await winnerDone
    assert.equal(second.error, undefined)
    await winner.query('COMMIT')

    // The loser's numbers were given back: the survivor holds number 1 of both series.
    assert.equal(await peek(db.pool, { scope, series: 'X' }), 1)
    assert.equal(await peek(db.pool, { scope, series: 'Y' }), 1)
    assert.deepEqual(await documents(scope), [
      { series: 'X', seq_no: 1, idempotency_key: `${names.winner}-X` },
      { series: 'Y', seq_no: 1, idempotency_key: `${names.winner}-Y` },
    ])

    // The retry of the loser takes the next number of each series, in the order it used before.
    const order = names.loser === 'a' ? ['X', 'Y'] : ['Y', 'X']
    const retried = await issue(db.pool, { scope, series: order[0] }, async (client, n) => {
      await insertDocument(client, { scope, series: order[0] }, n, `${names.loser}-${order[0]}`)
      return [n, await take(client, scope, order[1], names.loser)]
    })
    assert.deepEqual(retried, [2, 2])
    assert.equal(await peek(db.pool, { scope, series: 'X' }), 2)
    assert.equal(await peek(db.pool, { scope, series: 'Y' }), 2)
    assert.deepEqual(await documents(scope), [
      { series: 'X', seq_no: 1, idempotency_key: `${names.winner}-X` },
      { series: 'X', seq_no: 2, idempotency_key: `${names.loser}-X` },
      { series: 'Y', seq_no: 1, idempotency_key: `${names.winner}-Y` },
      { series: 'Y', seq_no: 2, idempotency_key: `${names.loser}-Y` },
    ])
  } finally {
    await a.query('ROLLBACK').catch(() => {})
    await b.query('ROLLBACK').catch(() => {})
    a.release()
    b.release()
  }
})

test('the same order never deadlocks: the second transaction waits, then both commit with no gap', { timeout: 30_000 }, async () => {
  const scope = 'tenant-same'
  await createSeries(db.pool, { scope, series: 'X' })
  await createSeries(db.pool, { scope, series: 'Y' })
  const a = await db.pool.connect()
  const b = await db.pool.connect()
  try {
    const pid = { a: await backendPid(a), b: await backendPid(b) }
    await a.query('BEGIN')
    await b.query('BEGIN')
    assert.equal(await take(a, scope, 'X', 'a'), 1)

    // The same two moves as above, with b taking X first: it waits behind a and holds nothing a needs.
    const bDone = outcome('b', take(b, scope, 'X', 'b'))
    await waitUntilBlocked(db.pool, pid.b, pid.a)
    assert.equal(await take(a, scope, 'Y', 'a'), 1)
    await a.query('COMMIT')
    assert.deepEqual(await bDone, { who: 'b' })
    assert.equal(await take(b, scope, 'Y', 'b'), 2)
    await b.query('COMMIT')

    assert.equal(await peek(db.pool, { scope, series: 'X' }), 2)
    assert.equal(await peek(db.pool, { scope, series: 'Y' }), 2)
    assert.deepEqual(await documents(scope), [
      { series: 'X', seq_no: 1, idempotency_key: 'a-X' },
      { series: 'X', seq_no: 2, idempotency_key: 'b-X' },
      { series: 'Y', seq_no: 1, idempotency_key: 'a-Y' },
      { series: 'Y', seq_no: 2, idempotency_key: 'b-Y' },
    ])
  } finally {
    await a.query('ROLLBACK').catch(() => {})
    await b.query('ROLLBACK').catch(() => {})
    a.release()
    b.release()
  }
})

test('20 concurrent issuers that take two series in the same order all succeed with matching numbers', async () => {
  const scope = 'tenant-many'
  await createSeries(db.pool, { scope, series: 'X' })
  await createSeries(db.pool, { scope, series: 'Y' })
  const results = await Promise.all(
    range(1, 20).map((i) =>
      issue(db.pool, { scope, series: 'X' }, async (client, n) => {
        await insertDocument(client, { scope, series: 'X' }, n, `r${i}-X`)
        return [n, await take(client, scope, 'Y', `r${i}`)]
      })
    )
  )
  // X is taken first, so the second number of each pair equals the first.
  assert.deepEqual(results.map(([x]) => x).sort((p, q) => p - q), range(1, 20))
  assert.ok(results.every(([x, y]) => x === y))
  assert.equal(await peek(db.pool, { scope, series: 'X' }), 20)
  assert.equal(await peek(db.pool, { scope, series: 'Y' }), 20)
  const { rows } = await db.pool.query(
    'SELECT series, count(*)::int AS n, min(seq_no)::int AS lo, max(seq_no)::int AS hi FROM documents WHERE scope = $1 GROUP BY series ORDER BY series',
    [scope]
  )
  assert.deepEqual(rows, [
    { series: 'X', n: 20, lo: 1, hi: 20 },
    { series: 'Y', n: 20, lo: 1, hi: 20 },
  ])
})
