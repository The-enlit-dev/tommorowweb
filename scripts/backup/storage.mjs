// Copies every Supabase Storage file into ./storage-files/<bucket>/<path> and writes
// storage-files.sha256. Optional step of the nightly backup; needs SUPABASE_SERVICE_ROLE_KEY
// (a GitHub secret — never commit it). Usage: OUT=backup-out node scripts/backup/storage.mjs
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SUPABASE_URL } from '../../src/lib/supabase-config.js'

const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!key) { console.log('SUPABASE_SERVICE_ROLE_KEY not set: skipping storage file copy'); process.exit(0) }
const out = join(process.env.OUT || 'backup-out', 'storage-files')
const h = { apikey: key, authorization: `Bearer ${key}` }

async function api(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1${path}`, { ...init, headers: { ...h, ...(init.headers || {}) } })
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`)
  return r
}
async function list(bucket, prefix = '') {
  const files = []
  for (let offset = 0; ; offset += 1000) {
    const r = await api(`/object/list/${bucket}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix, limit: 1000, offset }) })
    const items = await r.json()
    for (const it of items) {
      const p = prefix ? `${prefix}/${it.name}` : it.name
      if (it.id === null) files.push(...(await list(bucket, p))) // folder
      else files.push(p)
    }
    if (items.length < 1000) break
  }
  return files
}

const lines = []
let count = 0
for (const b of await (await api('/bucket')).json()) {
  for (const path of await list(b.id)) {
    const buf = Buffer.from(await (await api(`/object/${b.id}/${path.split('/').map(encodeURIComponent).join('/')}`)).arrayBuffer())
    const file = join(out, b.id, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, buf)
    lines.push(`${createHash('sha256').update(buf).digest('hex')}  ${b.id}/${path}`)
    count++
  }
}
mkdirSync(out, { recursive: true })
writeFileSync(join(out, '..', 'storage-files.sha256'), lines.join('\n') + (lines.length ? '\n' : ''))
console.log(`copied ${count} storage files`)
