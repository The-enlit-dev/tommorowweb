/**
 * Prints the SHA-256 hash for a friends & family code.
 * Usage: node scripts/hash-code.mjs MY-CODE
 * Paste the output into `friendsCode.hash` in src/config/site.ts.
 * Codes are compared in capitals with spaces removed, so "my code" matches "MYCODE".
 */
import { createHash } from 'node:crypto'

const code = process.argv[2]
if (!code) {
  console.error('Usage: node scripts/hash-code.mjs MY-CODE')
  process.exit(1)
}
const normalised = code.trim().toUpperCase().replace(/\s+/g, '')
console.log(createHash('sha256').update(normalised).digest('hex'))
