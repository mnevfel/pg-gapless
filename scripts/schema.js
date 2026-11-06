// Writes src/schema.js from sql/schema.sql. Run after editing the SQL.
import { readFileSync, writeFileSync } from 'node:fs'

const sql = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8')
if (/[`\\]|\$\{/.test(sql)) throw new Error('sql/schema.sql has a character a template literal would change')

writeFileSync(
  new URL('../src/schema.js', import.meta.url),
  '// Copy of sql/schema.sql, written by `npm run schema`; test/package.test.js checks they match.\n' +
    '// Kept as a module so that bundlers carry it without the sql/ folder.\n' +
    'export const schemaSql = `' + sql + '`\n'
)
