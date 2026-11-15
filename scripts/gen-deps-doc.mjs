// Regenerates docs/DEPENDENCIES.md from src/portal/dependencies.ts (the portal's register).
import { writeFileSync } from 'node:fs'
import { dependencies, CHECKED_ON } from '../src/portal/dependencies.ts'

const cell = (s) => String(s).replace(/\|/g, '\\|')
const rows = dependencies
  .map((d) => `| [${d.service}](${d.link}) | ${d.required ? 'Required' : 'Optional'} | ${cell(d.usedFor)} | ${cell(d.needs)} | ${cell(d.freeLimits)} | ${cell(d.paidRisk)} | ${cell(d.ifUnavailable)} |`)
  .join('\n')

writeFileSync(new URL('../docs/DEPENDENCIES.md', import.meta.url), `# Dependencies and costs

Every third-party service the platform uses, what it costs, and what happens if it is unavailable.
The same table is shown in the portal at **/portal/admin/infrastructure/**. It is generated from
\`src/portal/dependencies.ts\` (run \`npm run docs:deps\`), so the portal and this file always agree.

Free limits are as published on ${CHECKED_ON} and **can change at any time** — follow the links before relying on them.

**Rule:** nothing that can cost money is switched on automatically. Billing, paid plans, credits,
payment providers and APIs that need billing are off until the owner (you) explicitly sets them up.

| Service | Required? | Used for | Needs | Free limits | Could it cost money? | If unavailable |
| --- | --- | --- | --- | --- | --- | --- |
${rows}

## Account ownership

All accounts (Supabase, Netlify, GitHub, Google Cloud, OpenRouter, Brevo) belong to Tomorrow Web.
Razorpay and Printify accounts always belong to **each client business**, never to Tomorrow Web.
`)
console.log('docs/DEPENDENCIES.md updated')
