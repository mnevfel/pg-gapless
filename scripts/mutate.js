// Breaks the library on purpose, one guard at a time, and checks that the
// tests notice every break. Needs DATABASE_URL like npm test: npm run mutate
import { execFile } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const tests = ['test/issue.test.js', 'test/isolation.test.js', 'test/failure.test.js', 'test/readme.test.js']

const mutants = [
  ['transaction at the session default level', 'src/index.js',
    "'BEGIN ISOLATION LEVEL READ COMMITTED'", "'BEGIN'"],
  ['no ROLLBACK when fn throws', 'src/index.js',
    "await client.query('ROLLBACK')", ''],
  ['COMMIT answered with ROLLBACK passes as success', 'src/index.js',
    "done.command === 'ROLLBACK'", 'false'],
  ['no error listener on the checked-out client', 'src/index.js',
    "client.on('error', onError)", ''],
  ['issue() connects before checking its arguments', 'src/index.js',
    "const { scope, series } = checkKey(key)\n  if (typeof fn", "const { scope, series } = key ?? {}\n  if (typeof fn"],
  ['counter steps by two', 'src/index.js',
    'SET last_value = last_value + 1', 'SET last_value = last_value + 2'],
  ['createSeries resets an existing series', 'src/index.js',
    'ON CONFLICT (scope, series) DO NOTHING',
    'ON CONFLICT (scope, series) DO UPDATE SET last_value = EXCLUDED.last_value'],
  ['no safe integer check', 'src/index.js',
    'if (!Number.isSafeInteger(n))', 'if (false)'],
  ['gapless_next() returns NULL for an unknown series', 'src/schema.js',
    'IF n IS NULL THEN', 'IF false THEN'],
  ['schema without its version marker', 'src/schema.js',
    "COMMENT ON TABLE gapless_counters IS 'pg-gapless schema 1';", ''],
  ['error listener left on the client', 'src/index.js',
    "client.off('error', onError)", ''],
  ['peek() locks the row', 'src/index.js',
    "WHERE scope = $1 AND series = $2',", "WHERE scope = $1 AND series = $2 FOR UPDATE',"],
  ['peek() gives 0 for an unknown series', 'src/index.js',
    'res.rowCount === 0 ? null :', 'res.rowCount === 0 ? 0 :'],
  ['isUniqueViolation() accepts any error code', 'src/index.js',
    "err?.code === '23505'", 'err?.code'],
]

// Resolves to the first failing test, so a mutant that only breaks the
// syntax or times out shows as such instead of passing for a real catch.
const run = (cwd) =>
  new Promise((resolve) => {
    const args = ['--test', '--test-reporter=tap', '--test-timeout=20000', ...tests]
    execFile(process.execPath, args, { cwd, timeout: 120_000, maxBuffer: 1 << 24 }, (err, stdout) => {
      if (!err) return resolve(null)
      const failed = stdout.match(/^\s*not ok \d+ - (.+)$/m)
      resolve(failed ? failed[1] : err.killed ? 'timed out' : 'no test result')
    })
  })

let survived = 0
for (const [name, file, from, to] of mutants) {
  const dir = mkdtempSync(join(tmpdir(), 'pg-gapless-mutant-'))
  try {
    cpSync(root, dir, { recursive: true, filter: (src) => !/[/\\](node_modules|\.git)$/.test(src) })
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir')
    const path = join(dir, file)
    const source = readFileSync(path, 'utf8')
    if (source.split(from).length !== 2) throw new Error(`mutant "${name}" does not match ${file} exactly once`)
    writeFileSync(path, source.replace(from, to))
    const failed = await run(dir)
    if (failed === null) survived++
    console.log(failed === null ? `SURVIVED ${name}` : `caught   ${name}\n           by: ${failed}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
if (survived > 0) {
  console.error(`${survived} of ${mutants.length} mutants survived`)
  process.exitCode = 1
}
