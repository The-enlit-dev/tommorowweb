// Publishes a site's CMS drafts and/or asks its host to rebuild (Netlify/Vercel/Cloudflare deploy hook).
// JWT required (verify_jwt: true). Permission checks run as the caller through RLS-protected RPCs;
// the deploy hook URL is read from Vault with the service role and never returned to the browser.
import { audit, clean, getCaller, handler, HttpError, json, serviceClient, userClient, UUID_RE } from '../_shared/util.ts'

const admin = serviceClient()
const MIN_GAP_MS = 60_000

Deno.serve(handler(async (req, body) => {
  const caller = await getCaller(req, admin)
  const siteId = clean(body.site_id, 40)
  if (!UUID_RE.test(siteId)) throw new HttpError(400, 'Missing website.')
  const scope = body.scope === 'build' ? 'build' : 'content'
  const sb = userClient(req)

  const { data: can, error: canErr } = await sb.rpc('can_manage_site', { p_site: siteId })
  if (canErr || !can) throw new HttpError(403, 'You don’t have permission to publish this website.')

  let published = 0
  if (scope === 'content') {
    const r = await sb.rpc('publish_site_content', { p_site: siteId })
    if (r.error) throw new HttpError(400, r.error.message)
    published = r.data as number
  }

  const { data: site } = await admin.from('sites').select('id, business_id, build_hook_secret_id, last_build_at').eq('id', siteId).single()
  let build = 'not_configured'
  if (site?.build_hook_secret_id) {
    if (site.last_build_at && Date.now() - Date.parse(site.last_build_at) < MIN_GAP_MS) {
      build = 'rate_limited'
    } else {
      const { data: hook } = await admin.rpc('svc_site_build_hook', { p_site: siteId })
      try {
        const r = await fetch(hook as string, { method: 'POST', signal: AbortSignal.timeout(10_000) })
        build = r.ok ? 'triggered' : `failed (${r.status})`
      } catch {
        build = 'failed (host unreachable)'
      }
      await admin.from('sites').update({ last_build_at: new Date().toISOString(), last_build_status: build }).eq('id', siteId)
      await audit(admin, caller, 'site:build', { status: build, scope }, { business_id: site.business_id, entity: 'sites', entity_id: siteId })
    }
  }
  return json({ published, build })
}))
