// Sign-in and password pages.
import { useEffect, useState } from 'preact/hooks'
import { loadContext, sb } from '../lib'
import { Logo } from '../ui'

function safeNext() {
  const n = new URLSearchParams(location.search).get('next') || '/portal/'
  return n.startsWith('/portal/') && !n.startsWith('//') ? n : '/portal/'
}

export function Login() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    loadContext().then((c) => c && location.replace(c.profile.must_change_password ? '/portal/password/' : safeNext()))
  }, [])

  async function submit(e: Event) {
    e.preventDefault()
    const f = new FormData(e.currentTarget as HTMLFormElement)
    setBusy(true)
    setError('')
    const { error } = await sb().auth.signInWithPassword({ email: String(f.get('email')).trim(), password: String(f.get('password')) })
    if (error) {
      setBusy(false)
      setError(/invalid/i.test(error.message) ? 'That email and password don’t match.' : /banned/i.test(error.message) ? 'This account is disabled. Contact Tomorrow Web.' : error.message)
      return
    }
    const c = await loadContext()
    location.replace(c?.profile.must_change_password ? '/portal/password/' : safeNext())
  }

  return (
    <div class="p-auth">
      <form class="p-auth-card p-form" onSubmit={submit}>
        <Logo />
        <h1>Sign in</h1>
        <p class="p-muted" style={{ margin: 0 }}>For Tomorrow Web clients and their teams.</p>
        <label class="p-field">
          <span>Email</span>
          <input name="email" type="email" autoComplete="username" required />
        </label>
        <label class="p-field">
          <span>Password</span>
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        {error && <div class="p-notice" data-tone="bad" role="alert">{error}</div>}
        <button class="btn btn-ink" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p class="p-small p-muted" style={{ margin: 0 }}>
          Forgot your password? Ask Tomorrow Web (or your business owner) to reset it. Accounts are created by Tomorrow Web — there’s no public sign-up.
        </p>
        <a class="p-small" href="/">← Back to the website</a>
      </form>
    </div>
  )
}

export function Password() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [forced, setForced] = useState<boolean | null>(null)

  useEffect(() => {
    loadContext().then((c) => {
      if (!c) location.replace('/portal/login/')
      else setForced(c.profile.must_change_password)
    })
  }, [])

  async function submit(e: Event) {
    e.preventDefault()
    const f = new FormData(e.currentTarget as HTMLFormElement)
    const p1 = String(f.get('password'))
    const p2 = String(f.get('confirm'))
    setError('')
    if (p1.length < 10) return setError('Use at least 10 characters.')
    if (!/[A-Za-z]/.test(p1) || !/\d/.test(p1)) return setError('Include at least one letter and one number.')
    if (p1 !== p2) return setError('The two passwords don’t match.')
    setBusy(true)
    const { error } = await sb().auth.updateUser({ password: p1 })
    if (error) {
      setBusy(false)
      return setError(/different/i.test(error.message) ? 'Choose a password different from the temporary one.' : error.message)
    }
    await sb().rpc('mark_password_changed')
    location.replace('/portal/')
  }

  if (forced === null) return <div class="p-loading">Loading…</div>
  return (
    <div class="p-auth">
      <form class="p-auth-card p-form" onSubmit={submit}>
        <Logo />
        <h1>{forced ? 'Choose your password' : 'Change password'}</h1>
        <p class="p-muted" style={{ margin: 0 }}>
          {forced ? 'You signed in with a temporary password. Choose your own to continue.' : 'Choose a new password for your account.'}
        </p>
        <label class="p-field">
          <span>New password</span>
          <input name="password" type="password" autoComplete="new-password" minLength={10} required />
          <small>At least 10 characters, with a letter and a number.</small>
        </label>
        <label class="p-field">
          <span>Repeat new password</span>
          <input name="confirm" type="password" autoComplete="new-password" minLength={10} required />
        </label>
        {error && <div class="p-notice" data-tone="bad" role="alert">{error}</div>}
        <button class="btn btn-ink" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
        {!forced && <a class="p-small" href="/portal/account/">Cancel</a>}
      </form>
    </div>
  )
}
