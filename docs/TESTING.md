# Tests

| Suite | Command | Runs against | In CI |
| --- | --- | --- | --- |
| Type check + build | `npm run build` | — | yes |
| Unit (pure logic) | `npm run test:unit` | — | yes |
| Migrations | `DATABASE_URL=… scripts/verify-migrations.sh` | throwaway PostgreSQL + Supabase shim | yes |
| Security (RLS) | `DATABASE_URL=… scripts/test-rls.sh` | migrated scratch DB, or the live project (each suite rolls back) | yes (scratch DB) |
| API | `npm run test:api` | the live Supabase project | no (needs QA admin login) |
| Browser end-to-end | `npm run build && npm run test:e2e` | built site + live project, Chromium desktop & phone | no (needs QA admin login) |

API and browser tests need a QA administrator account:

```bash
export TW_QA_EMAIL=… TW_QA_PASSWORD=…
```

They create businesses and users whose emails end in `@tomorrowweb.test` (names start with
"QA"). Remove them afterwards with the admin portal or `scripts/cleanup-qa.sql`.

The security suites in `supabase/tests/` impersonate anonymous visitors, administrators, owners,
managers and employees of two separate businesses and check every table's isolation rules.
