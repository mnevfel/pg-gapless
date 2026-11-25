import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createSeries, issue, isUniqueViolation, peek } from '../src/index.js'
import { startFaultProxy } from './fault-proxy.js'
import { insertDocument, setup, waitFor } from './db.js'

let db, proxy, flaky

before(async () => {
  db = await setup()
  proxy = await startFaultProxy(process.env.DATABASE_URL)
  // The same schema as db.pool, reached through the proxy.
  flaky = db.newPool('', 2, proxy.url)
})

after(async () => {
  await db.cleanup()
  await proxy.close()
})

const documents = (key) =>
  db.pool
    .query('SELECT seq_no::int, idempotency_key FROM documents WHERE scope = $1 AND series = $2 ORDER BY seq_no', [
      key.scope,
      key.series,
    ])
    .then((res) => res.rows)

test('a connection cut before COMMIT arrives rejects the call and gives the number back', async () => {
  const key = { scope: 'tenant-x', series: 'before' }
  await createSeries(db.pool, key)
  const store = (requestId) => (client, n) => insertDocument(client, key, n, requestId).then(() => n)

  proxy.cutNextCommit('before')
  const err = await issue(flaky, key, store('req-1')).catch((e) => e)
  assert.ok(err instanceof Error)
  assert.equal(isUniqueViolation(err), false)
  assert.equal(proxy.cuts, 1)
  assert.equal(flaky.totalCount, 0) // the dead connection was discarded, not returned to the pool

  // The server rolls the transaction back once it sees the session is gone.
  assert.equal(await peek(db.pool, key), 0)
  assert.deepEqual(await documents(key), [])

  // The retry takes number 1 and stores the document once.
  assert.equal(await issue(flaky, key, store('req-1')), 1)
  assert.deepEqual(await documents(key), [{ seq_no: 1, idempotency_key: 'req-1' }])
})

test('a COMMIT that succeeds but is never answered stores the document, and the request key makes the retry safe', async () => {
  const key = { scope: 'tenant-y', series: 'after' }
  await createSeries(db.pool, key)
  const store = (requestId) => (client, n) => insertDocument(client, key, n, requestId).then(() => n)
  const before = proxy.cuts

  proxy.cutNextCommit('after')
  const err = await issue(flaky, key, store('req-1')).catch((e) => e)
  assert.ok(err instanceof Error)
  assert.equal(isUniqueViolation(err), false)
  assert.equal(proxy.cuts, before + 1)
  assert.equal(flaky.totalCount, 0)

  // The call rejected, yet the document is there: this is the unknown outcome the README describes.
  await waitFor(async () => (await peek(db.pool, key)) === 1)
  assert.deepEqual(await documents(key), [{ seq_no: 1, idempotency_key: 'req-1' }])

  // The retry fails on the request key inside its transaction and uses no number.
  const retry = await issue(flaky, key, store('req-1')).catch((e) => e)
  assert.ok(isUniqueViolation(retry, 'documents_scope_idempotency_key_key'))
  assert.equal(await peek(db.pool, key), 1)

  // The next request carries on without a gap.
  assert.equal(await issue(flaky, key, store('req-2')), 2)
  assert.deepEqual((await documents(key)).map((d) => d.seq_no), [1, 2])
})
