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

test('the README names the versions CI tests, and the peer range starts at the oldest', () => {
  const workflow = readFileSync(new URL('.github/workflows/test.yml', root), 'utf8')
  const list = (key) => {
    const items = workflow.match(new RegExp(`^\\s+${key}: \\[([^\\]]+)\\]`, 'm'))[1].split(', ')
    return items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
  }
  const oldest = workflow.match(/^\s+pg: (\d+\.\d+\.\d+)$/m)[1]
  const readme = readFileSync(new URL('README.md', root), 'utf8')
  assert.ok(
    readme.includes(
      `Tested in CI on Node ${list('node')} with PostgreSQL ${list('postgres')}, and with pg ${oldest} as the oldest driver.`
    )
  )
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
  assert.equal(pkg.peerDependencies.pg, `^${oldest}`)
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
