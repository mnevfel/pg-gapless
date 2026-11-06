import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { promisify } from 'node:util'
import pg from 'pg'

const root = new URL('..', import.meta.url)
const readme = readFileSync(new URL('README.md', root), 'utf8')

test('the README Quick start is examples/quick-start.js and prints what the README says', async () => {
  const code = readme.match(/## Quick start\n[\s\S]*?```js\n([\s\S]*?)```/)[1]
  const printed = readme.match(/On an empty database it prints:\n\n```\n([\s\S]*?)```/)[1]
  assert.equal(code, readFileSync(new URL('examples/quick-start.js', root), 'utf8'))

  // An empty schema stands in for the empty database.
  const schema = 'gapless_readme_' + randomBytes(4).toString('hex')
  const url = new URL(process.env.DATABASE_URL)
  url.searchParams.set('options', `-c search_path=${schema}`)
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await admin.connect()
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    const { stdout } = await promisify(execFile)(process.execPath, ['examples/quick-start.js'], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: url.href },
    })
    assert.equal(stdout, printed)
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
})
