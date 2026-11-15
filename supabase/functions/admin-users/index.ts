// Administrator account management: create admins and clients (with their business),
// reset passwords and disable accounts. Every action is recorded in the audit log.
import {
  audit, clean, EMAIL_RE, getCaller, handler, HttpError, json, requireAdmin, serviceClient, tempPassword,
} from '../_shared/util.ts'

const admin = serviceClient()

async function createAuthUser(email: string, fullName: string, phone: string, password: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, phone, must_change_password: true },
  })
  if (error) {
    if (/already|registered|exists/i.test(error.message)) throw new HttpError(409, 'An account with this email already exists.')
    throw new HttpError(400, error.message)
  }
  return data.user!
}

async function enablePreset(businessId: string, preset: string, actorId: string | null) {
  const { data: p } = await admin.from('module_presets').select('modules').eq('key', preset).single()
  if (!p) throw new HttpError(400, 'Unknown preset.')
  const rows = (p.modules as string[]).map((m) => ({ business_id: businessId, module_key: m, enabled: true, updated_by: actorId }))
  const { error } = await admin.from('business_modules').upsert(rows, { onConflict: 'business_id,module_key' })
  if (error) throw new HttpError(400, error.message)
  return p.modules as string[]
}

Deno.serve(
  handler(async (req, body) => {
    const action = clean(body.action, 40)

    // One-time setup: creates the first administrator. Requires a single-use token whose hash
    // was stored in private.settings, and only works while no administrator exists.
    if (action === 'bootstrap') {
      const email = clean(body.email).toLowerCase()
      const password = clean(body.password, 200)
      if (!EMAIL_RE.test(email) || password.length < 12) throw new HttpError(400, 'A valid email and a 12+ character password are required.')
      const { data: ok, error } = await admin.rpc('consume_bootstrap_token', { p_token: clean(body.token, 200) })
      if (error || !ok) throw new HttpError(403, 'Setup is not available.')
      const user = await createAuthUser(email, clean(body.full_name) || 'Administrator', '', password)
      await admin.from('profiles').update({ role: 'admin' }).eq('id', user.id)
      await audit(admin, null, 'bootstrap:first_admin', { email }, { entity: 'profiles', entity_id: user.id })
      return json({ user_id: user.id })
    }

    const caller = await getCaller(req, admin)
    requireAdmin(caller)

    switch (action) {
      case 'create_admin': {
        const email = clean(body.email).toLowerCase()
        if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.')
        const password = tempPassword()
        const user = await createAuthUser(email, clean(body.full_name), clean(body.phone, 30), password)
        await admin.from('profiles').update({ role: 'admin' }).eq('id', user.id)
        await audit(admin, caller, 'admin:create_admin', { email }, { entity: 'profiles', entity_id: user.id })
        return json({ user_id: user.id, temp_password: password })
      }

      case 'create_client': {
        const email = clean(body.email).toLowerCase()
        const fullName = clean(body.full_name)
        const phone = clean(body.phone, 30)
        const biz = (body.business ?? {}) as Record<string, unknown>
        const bizName = clean(biz.name)
        const preset = clean(biz.preset, 40) || 'website_only'
        if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.')
        if (!fullName) throw new HttpError(400, 'Enter the client’s name.')
        if (!bizName) throw new HttpError(400, 'Enter the business name.')

        const password = tempPassword()
        const user = await createAuthUser(email, fullName, phone, password)
        const { data: business, error: bErr } = await admin
          .from('businesses')
          .insert({
            name: bizName,
            industry: clean(biz.industry, 80) || null,
            preset,
            city: clean(biz.city, 80) || null,
            locality: clean(biz.locality, 80) || null,
            created_by: caller.profile.id,
          })
          .select('id')
          .single()
        if (bErr || !business) {
          await admin.auth.admin.deleteUser(user.id) // roll back the half-created client
          throw new HttpError(400, bErr?.message ?? 'Could not create the business.')
        }
        await admin.from('business_members').insert({ business_id: business.id, user_id: user.id, role: 'owner', permissions: [] })
        const modules = await enablePreset(business.id, preset, caller.profile.id)
        const siteUrl = clean(biz.site_url, 300)
        if (siteUrl) await admin.from('sites').insert({ business_id: business.id, name: bizName, url: siteUrl })
        await audit(admin, caller, 'admin:create_client', { email, business: bizName, preset, modules }, {
          business_id: business.id, entity: 'profiles', entity_id: user.id,
        })
        return json({ user_id: user.id, business_id: business.id, temp_password: password, modules })
      }

      case 'add_owner': {
        const businessId = clean(body.business_id, 60)
        const email = clean(body.email).toLowerCase()
        if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.')
        const { data: existing } = await admin.from('profiles').select('id').eq('email', email).maybeSingle()
        let userId = existing?.id as string | undefined
        let password: string | null = null
        if (!userId) {
          password = tempPassword()
          userId = (await createAuthUser(email, clean(body.full_name), clean(body.phone, 30), password)).id
        }
        const { error } = await admin.from('business_members')
          .upsert({ business_id: businessId, user_id: userId, role: 'owner', permissions: [], active: true }, { onConflict: 'business_id,user_id' })
        if (error) throw new HttpError(400, error.message)
        await audit(admin, caller, 'admin:add_owner', { email }, { business_id: businessId, entity: 'profiles', entity_id: userId })
        return json({ user_id: userId, temp_password: password })
      }

      case 'apply_preset': {
        const businessId = clean(body.business_id, 60)
        const preset = clean(body.preset, 40)
        const modules = await enablePreset(businessId, preset, caller.profile.id)
        await admin.from('businesses').update({ preset }).eq('id', businessId)
        return json({ modules })
      }

      case 'reset_password': {
        const userId = clean(body.user_id, 60)
        if (userId === caller.profile.id) throw new HttpError(400, 'Change your own password from your account page.')
        const password = tempPassword()
        const { error } = await admin.auth.admin.updateUserById(userId, { password })
        if (error) throw new HttpError(400, error.message)
        await admin.from('profiles').update({ must_change_password: true }).eq('id', userId)
        await audit(admin, caller, 'admin:reset_password', {}, { entity: 'profiles', entity_id: userId })
        return json({ temp_password: password })
      }

      case 'set_disabled': {
        const userId = clean(body.user_id, 60)
        const disabled = body.disabled === true
        if (userId === caller.profile.id) throw new HttpError(400, 'You cannot disable your own account.')
        const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: disabled ? '876000h' : 'none' })
        if (error) throw new HttpError(400, error.message)
        await admin.from('profiles').update({ disabled }).eq('id', userId)
        await audit(admin, caller, disabled ? 'admin:disable_account' : 'admin:enable_account', {}, { entity: 'profiles', entity_id: userId })
        return json({ ok: true })
      }

      default:
        throw new HttpError(400, 'Unknown action.')
    }
  }),
)
