/**
 * Netlify forms: the project enquiry (/contact/) and the call booking (/book/).
 *
 * Without JavaScript each form posts straight to Netlify and lands on /thanks/.
 * With JavaScript it validates inline, submits in the background and shows the
 * result in place. Netlify Forms accepts URL-encoded POSTs to any page path.
 */
type Field = HTMLInputElement | HTMLTextAreaElement

export function initForms() {
  const forms = Array.from(document.querySelectorAll<HTMLFormElement>('form[data-enquiry]'))
  const cleanups = forms.map(initForm)
  if (!cleanups.length) return
  return () => cleanups.forEach((fn) => fn())
}

/** Normalises a code the same way scripts/hash-code.mjs does, then hashes it. */
async function sha256(text: string) {
  const data = new TextEncoder().encode(text.trim().toUpperCase().replace(/\s+/g, ''))
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Replaces the no-JS date input with chips for the next few weekend days. */
function buildDayChips(form: HTMLFormElement) {
  const box = form.querySelector<HTMLElement>('[data-day-chips]')
  if (!box || box.dataset.built) return
  const days = (box.dataset.days ?? '6,0').split(',').map(Number)
  const weeks = Number(box.dataset.weeks ?? 4)
  const label = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
  const value = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const out: Date[] = []
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() + 1) // from tomorrow onwards
  while (out.length < days.length * weeks) {
    if (days.includes(d.getDay())) out.push(new Date(d))
    d.setDate(d.getDate() + 1)
  }
  box.innerHTML = ''
  out.forEach((date, i) => {
    const l = document.createElement('label')
    l.className = 'choice'
    const input = document.createElement('input')
    input.type = 'radio'
    input.name = 'preferred-date'
    input.value = value.format(date)
    input.dataset.label = 'A day'
    if (i === 0) input.required = true
    const span = document.createElement('span')
    span.textContent = label.format(date)
    l.append(input, span)
    box.append(l)
  })
  box.dataset.built = 'true'
}

function initForm(form: HTMLFormElement) {
  const status = form.querySelector<HTMLElement>('[data-form-status]')
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')
  const scope = form.parentElement ?? document
  const success = scope.querySelector<HTMLElement>('[data-form-success]')
  const again = scope.querySelector<HTMLButtonElement>('[data-form-again]')
  const waButton = form.querySelector<HTMLButtonElement>('[data-wa-send]')
  const codeInput = form.querySelector<HTMLInputElement>('[data-code-input]')
  const codeStatus = form.querySelector<HTMLElement>('[data-code-status]')
  const codeValid = form.querySelector<HTMLInputElement>('input[name="code-valid"]')
  form.noValidate = true
  buildDayChips(form)

  // Pre-select the website type from ?type=restaurant etc. (links on /services/).
  const type = new URLSearchParams(location.search).get('type')
  if (type) {
    const radio = form.querySelector<HTMLInputElement>(`input[name="website-type"][data-slug="${CSS.escape(type)}"]`)
    if (radio) radio.checked = true
  }

  const fields = () => Array.from(form.querySelectorAll<Field>('input:not([type=hidden]), textarea'))

  const messageFor = (el: Field) => {
    const v = el.validity
    const name = el.dataset.label ?? 'This field'
    if (v.valueMissing) return el.type === 'radio' ? `Please choose ${name.toLowerCase()}.` : `Please enter ${name.toLowerCase()}.`
    if (v.typeMismatch && el.type === 'email') return 'Please enter a valid email address, like name@example.com.'
    if (v.patternMismatch) return el.dataset.patternMessage ?? `Please check ${name.toLowerCase()}.`
    if (v.tooShort) return `Please add a little more detail (at least ${el.getAttribute('minlength')} characters).`
    if (v.tooLong) return `That’s a bit long — please keep it under ${el.getAttribute('maxlength')} characters.`
    return ''
  }

  const errorEl = (el: Field) => form.querySelector<HTMLElement>(`[data-error-for="${el.type === 'radio' ? el.name : el.id}"]`)

  const showError = (el: Field) => {
    const msg = messageFor(el)
    const target = errorEl(el)
    const group = el.type === 'radio' ? form.querySelectorAll<HTMLInputElement>(`input[name="${el.name}"]`) : [el]
    group.forEach((g) => g.setAttribute('aria-invalid', msg ? 'true' : 'false'))
    if (target) {
      target.textContent = msg
      target.hidden = !msg
    }
    return !msg
  }

  const validate = () => {
    let firstInvalid: HTMLElement | null = null
    const seen = new Set<string>()
    for (const el of fields()) {
      if (el.name === 'bot-field') continue
      if (el instanceof HTMLInputElement && el.type === 'radio') {
        if (seen.has(el.name)) continue
        seen.add(el.name)
      }
      if (!showError(el) && !firstInvalid) firstInvalid = el
    }
    return firstInvalid
  }

  // Re-check a field once the visitor has moved on from it.
  const onBlur = (e: Event) => {
    const el = e.target as HTMLInputElement
    if (!el.matches('input, textarea') || el.name === 'bot-field' || el === codeInput) return
    if (el.getAttribute('aria-invalid') === 'true' || (el.value && el.type !== 'radio')) showError(el)
  }
  const onChange = (e: Event) => {
    const el = e.target as HTMLInputElement
    if (el.matches('input, textarea') && el.getAttribute('aria-invalid') === 'true') showError(el)
  }

  // Friends & family code: compares a hash, so the code never appears in the page source.
  let codeTimer = 0
  const checkCode = async (announceMiss: boolean) => {
    if (!codeInput || !codeStatus) return
    const value = codeInput.value.trim()
    const expected = codeInput.dataset.hash ?? ''
    if (!value) {
      codeStatus.hidden = true
      codeStatus.dataset.state = ''
      if (codeValid) codeValid.value = ''
      return
    }
    let ok = false
    try {
      ok = (await sha256(value)) === expected
    } catch {
      ok = false // crypto.subtle needs HTTPS; the code is still sent with the enquiry.
    }
    if (codeValid) codeValid.value = ok ? 'yes' : 'no'
    if (ok) {
      codeStatus.textContent = codeInput.dataset.okMessage ?? 'Code applied.'
      codeStatus.dataset.state = 'ok'
      codeStatus.hidden = false
    } else if (announceMiss) {
      codeStatus.textContent = 'That code isn’t recognised. Check it, or leave this blank.'
      codeStatus.dataset.state = 'miss'
      codeStatus.hidden = false
    } else if (codeStatus.dataset.state === 'ok') {
      codeStatus.hidden = true
      codeStatus.dataset.state = ''
    }
  }
  const onCodeInput = () => {
    clearTimeout(codeTimer)
    codeTimer = window.setTimeout(() => checkCode(false), 250)
  }
  const onCodeBlur = () => checkCode(true)

  const setStatus = (msg: string, kind: 'error' | 'info' = 'error') => {
    if (!status) return
    status.hidden = !msg
    status.dataset.kind = kind
    const text = status.querySelector('[data-status-text]')
    if (text) text.textContent = msg
  }

  const onSubmit = async (e: SubmitEvent) => {
    e.preventDefault()
    setStatus('')
    const invalid = validate()
    if (invalid) {
      setStatus('A few details need another look — see the highlighted fields.')
      invalid.focus()
      return
    }
    await checkCode(false)

    if (import.meta.env.DEV) {
      setStatus('Forms only send from the deployed Netlify site. Nothing was sent from the local dev server.', 'info')
      return
    }

    submit?.setAttribute('disabled', '')
    submit?.setAttribute('aria-busy', 'true')
    const label = submit?.querySelector('[data-label]')
    const original = label?.textContent
    if (label) label.textContent = 'Sending…'

    try {
      const body = new URLSearchParams()
      new FormData(form).forEach((value, key) => body.append(key, String(value)))
      const res = await fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
        body: body.toString(),
      })
      if (!res.ok) throw new Error(`Status ${res.status}`)
      const name = (form.elements.namedItem('name') as HTMLInputElement | null)?.value.trim().split(/\s+/)[0]
      const summary = success?.querySelector('[data-success-summary]')
      if (summary) {
        const get = (n: string) => {
          const el = form.elements.namedItem(n)
          return el instanceof RadioNodeList ? el.value : ((el as HTMLInputElement | null)?.value ?? '')
        }
        summary.textContent = [get('preferred-date'), get('preferred-time')].filter(Boolean).join(' · ')
      }
      form.reset()
      if (codeStatus) codeStatus.hidden = true
      form.hidden = true
      if (success) {
        const who = success.querySelector('[data-success-name]')
        if (who && name) who.textContent = `, ${name}`
        success.hidden = false
        success.querySelector<HTMLElement>('h2')?.focus()
      }
    } catch {
      setStatus('Sorry — that couldn’t be sent just now. Please try again, or email us directly.')
    } finally {
      submit?.removeAttribute('disabled')
      submit?.removeAttribute('aria-busy')
      if (label && original) label.textContent = original
    }
  }

  // "Send on WhatsApp instead": turns the filled-in form into a WhatsApp message.
  // Fields marked data-wa="Label" are included, in page order.
  const onWhatsApp = () => {
    const number = waButton?.dataset.number
    if (!number) return
    const lines = [form.dataset.waIntro ?? 'Hi Tomorrow Web!']
    const seen = new Set<string>()
    form.querySelectorAll<Field>('[data-wa]').forEach((el) => {
      if (seen.has(el.name)) return
      const node = form.elements.namedItem(el.name)
      const value = (node instanceof RadioNodeList ? node.value : el.value).trim()
      seen.add(el.name)
      if (value) lines.push(el.tagName === 'TEXTAREA' ? `\n${value}` : `${el.dataset.wa}: ${value}`)
    })
    window.open(`https://wa.me/${number}?text=${encodeURIComponent(lines.join('\n'))}`, '_blank', 'noopener')
  }

  const onAgain = () => {
    if (success) success.hidden = true
    form.hidden = false
    form.querySelector<HTMLInputElement>('input:not([type=hidden])')?.focus()
  }

  form.addEventListener('submit', onSubmit)
  form.addEventListener('focusout', onBlur)
  form.addEventListener('change', onChange)
  form.addEventListener('input', onChange)
  codeInput?.addEventListener('input', onCodeInput)
  codeInput?.addEventListener('blur', onCodeBlur)
  waButton?.addEventListener('click', onWhatsApp)
  again?.addEventListener('click', onAgain)

  return () => {
    clearTimeout(codeTimer)
    form.removeEventListener('submit', onSubmit)
    form.removeEventListener('focusout', onBlur)
    form.removeEventListener('change', onChange)
    form.removeEventListener('input', onChange)
    codeInput?.removeEventListener('input', onCodeInput)
    codeInput?.removeEventListener('blur', onCodeBlur)
    waButton?.removeEventListener('click', onWhatsApp)
    again?.removeEventListener('click', onAgain)
  }
}
