import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { schemaSql } from '../src/index.js'

const root = new URL('..', import.meta.url)

test('src/schema.js matches sql/schema.sql', () => {
  assert.equal(schemaSql, readFileSync(new URL('sql/schema.sql', root), 'utf8'))
})

test('the package ships only the library', async () => {
  const { stdout } = await promisify(execFile)('npm', ['pack', '--dry-run', '--json'], { cwd: root })
  const files = JSON.parse(stdout)[0].files.map((f) => f.path).sort()
  assert.deepEqual(files, [
    'LICENSE',
    'README.md',
    'package.json',
    'sql/schema.sql',
    'src/index.d.ts',
    'src/index.js',
    'src/schema.js',
  ])
})
