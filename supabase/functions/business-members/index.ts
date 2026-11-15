// Business owners manage their own staff: create employee/manager accounts, reset their
// passwords and deactivate them. Owners can never create owners or touch other businesses.
import {
  ALL_PERMISSIONS, audit, clean, DEFAULT_PERMISSIONS, EMAIL_RE, getCaller, handler, HttpError, json, serviceClient, tempPassword,
} from '../_shared/util.ts'

const admin = serviceClient()

async function assertCanManage(callerId: string, isAdmin: boolean, businessId: string) {
  if (isAdmin) return
  const { data } = await admin.from('business_members').select('role, active')
    .eq('business_id', businessId).eq('user_id', callerId).maybeSingle()
  if (!data || !data.active || data.role !== 'owner') throw new HttpError(403, 'Only the business owner can manage staff accounts.')
}

/** Staff the caller may reset/deactivate: members of this business who are not owners. */
async function assertManageable(businessId: string, userId: string, callerId: string, isAdmin: boolean) {
  const { data: rows } = await admin.from('business_members').select('business_id, role').eq('user_id', userId)
  const here = rows?.find((r) => r.business_id === businessId)
  if (!here) throw new HttpError(404, 'That person is not part of this business.')
  if (here.role === 'owner' && !isAdmin) throw new HttpError(403, 'Owner accounts can only be changed by Tomorrow Web.')
  if (userId === callerId) throw new HttpError(400, 'Use your account page to manage your own login.')
  if (!isAdmin) {
    // If they also work for another business you don't own, only Tomorrow Web may reset them.
    const others = (rows ?? []).filter((r) => r.business_id !== businessId)
    for (const o of others) {
      const { data: mine } = await admin.from('business_members').select('role')
        .eq('business_id', o.business_id).eq('user_id', callerId).maybeSingle()
      if (mine?.role !== 'owner') throw new HttpError(403, 'This person also works for another business. Ask Tomorrow Web to help.')
    }
  }
}

Deno.serve(
  handler(async (req, body) => {
    const caller = await getCaller(req, admin)
    const isAdmin = caller.profile.role === 'admin'
    const businessId = clean(body.business_id, 60)
    if (!businessId) throw new HttpError(400, 'Missing business.')
    await assertCanManage(caller.profile.id, isAdmin, businessId)
    const action = clean(body.action, 40)

    switch (action) {
      case 'create_member': {
        const email = clean(body.email).toLowerCase()
        const fullName = clean(body.full_name)
        const role = body.role === 'manager' ? 'manager' : 'employee'
        const requested = Array.isArray(body.permissions) ? (body.permissions as string[]) : DEFAULT_PERMISSIONS[role]
        const permissions = requested.filter((p) => (ALL_PERMISSIONS as readonly string[]).includes(p))
        if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.')
        if (!fullName) throw new HttpError(400, 'Enter their name.')

        const { data: existing } = await admin.from('profiles').select('id').eq('email', email).maybeSingle()
        let userId: string
        let password: string | null = null
        if (existing) {
          if (!isAdmin) throw new HttpError(409, 'An account with this email already exists. Ask Tomorrow Web to add them.')
          userId = existing.id
        } else {
          password = tempPassword()
          const { data, error } = await admin.auth.admin.createUser({
            email, password, email_confirm: true,
            user_metadata: { full_name: fullName, phone: clean(body.phone, 30), must_change_password: true },
          })
          if (error) throw new HttpError(400, error.message)
          userId = data.user!.id
        }
        const { error } = await admin.from('business_members').upsert(
          { business_id: businessId, user_id: userId, role, permissions, active: true },
          { onConflict: 'business_id,user_id' },
        )
        if (error) throw new HttpError(400, error.message)
        await audit(admin, caller, 'team:create_member', { email, role, permissions }, { business_id: businessId, entity: 'profiles', entity_id: userId })
        return json({ user_id: userId, temp_password: password })
      }

      case 'reset_member_password': {
        const userId = clean(body.user_id, 60)
        await assertManageable(businessId, userId, caller.profile.id, isAdmin)
        const password = tempPassword()
        const { error } = await admin.auth.admin.updateUserById(userId, { password })
        if (error) throw new HttpError(400, error.message)
        await admin.from('profiles').update({ must_change_password: true }).eq('id', userId)
        await audit(admin, caller, 'team:reset_password', {}, { business_id: businessId, entity: 'profiles', entity_id: userId })
        return json({ temp_password: password })
      }

      case 'set_member_active': {
        const userId = clean(body.user_id, 60)
        const active = body.active === true
        await assertManageable(businessId, userId, caller.profile.id, isAdmin)
        await admin.from('business_members').update({ active }).eq('business_id', businessId).eq('user_id', userId)
        // Block sign-in entirely when they no longer belong anywhere.
        const { data: remaining } = await admin.from('business_members').select('business_id').eq('user_id', userId).eq('active', true)
        const { data: prof } = await admin.from('profiles').select('role').eq('id', userId).single()
        if (prof?.role !== 'admin') {
          const ban = (remaining ?? []).length === 0
          await admin.auth.admin.updateUserById(userId, { ban_duration: ban ? '876000h' : 'none' })
        }
        await audit(admin, caller, active ? 'team:reactivate_member' : 'team:deactivate_member', {}, { business_id: businessId, entity: 'profiles', entity_id: userId })
        return json({ ok: true })
      }

      default:
        throw new HttpError(400, 'Unknown action.')
    }
  }),
)
