/**
 * Enquiry form on /contact/.
 *
 * Without JavaScript the form posts straight to Netlify and lands on /thanks/.
 * With JavaScript it validates inline, submits in the background and shows the
 * result in place. Netlify Forms accepts URL-encoded POSTs to any page path.
 */
export function initEnquiryForm() {
  const form = document.querySelector<HTMLFormElement>('form[data-enquiry]')
  if (!form) return
  const status = form.querySelector<HTMLElement>('[data-form-status]')
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')
  const success = document.querySelector<HTMLElement>('[data-form-success]')
  const waButton = form.querySelector<HTMLButtonElement>('[data-wa-send]')
  form.noValidate = true

  // Pre-select the website type from ?type=restaurant etc. (links on /services/).
  const type = new URLSearchParams(location.search).get('type')
  if (type) {
    const radio = form.querySelector<HTMLInputElement>(`input[name="website-type"][data-slug="${CSS.escape(type)}"]`)
    if (radio) radio.checked = true
  }

  const fields = () => Array.from(form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input:not([type=hidden]), textarea, select'))

  const messageFor = (el: HTMLInputElement | HTMLTextAreaElement) => {
    const v = el.validity
    const name = el.dataset.label ?? 'This field'
    if (v.valueMissing) return el.type === 'radio' ? `Please choose ${name.toLowerCase()}.` : `Please enter ${name.toLowerCase()}.`
    if (v.typeMismatch && el.type === 'email') return 'Please enter a valid email address, like name@example.com.'
    if (v.patternMismatch) return el.dataset.patternMessage ?? `Please check ${name.toLowerCase()}.`
    if (v.tooShort) return `Please add a little more detail (at least ${el.getAttribute('minlength')} characters).`
    if (v.tooLong) return `That’s a bit long — please keep it under ${el.getAttribute('maxlength')} characters.`
    return ''
  }

  const errorEl = (el: HTMLInputElement | HTMLTextAreaElement) => {
    const key = el.type === 'radio' ? el.name : el.id
    return form.querySelector<HTMLElement>(`[data-error-for="${key}"]`)
  }

  const showError = (el: HTMLInputElement | HTMLTextAreaElement) => {
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
    if (!el.matches('input, textarea') || el.name === 'bot-field') return
    if (el.getAttribute('aria-invalid') === 'true' || (el.value && el.type !== 'radio')) showError(el)
  }
  const onChange = (e: Event) => {
    const el = e.target as HTMLInputElement
    if (el.type === 'radio' && el.getAttribute('aria-invalid') === 'true') showError(el)
    if (el.matches('input, textarea') && el.getAttribute('aria-invalid') === 'true') showError(el)
  }

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
      form.reset()
      form.hidden = true
      if (success) {
        const who = success.querySelector('[data-success-name]')
        if (who && name) who.textContent = `, ${name}`
        success.hidden = false
        success.querySelector<HTMLElement>('h2')?.focus()
      }
    } catch {
      setStatus('Sorry — your enquiry couldn’t be sent just now. Please try again, or email us directly.')
    } finally {
      submit?.removeAttribute('disabled')
      submit?.removeAttribute('aria-busy')
      if (label && original) label.textContent = original
    }
  }

  // "Send on WhatsApp instead": turns the filled-in form into a WhatsApp message.
  const onWhatsApp = () => {
    const number = waButton?.dataset.number
    if (!number) return
    const get = (n: string) => {
      const el = form.elements.namedItem(n)
      if (el instanceof RadioNodeList) return el.value
      return (el as HTMLInputElement | null)?.value.trim() ?? ''
    }
    const lines = [
      'Hi Tomorrow Web, I’d like to talk about a website.',
      get('name') && `Name: ${get('name')}`,
      get('business') && `Business: ${get('business')}`,
      get('website-type') && `Looking for: ${get('website-type')}`,
      get('budget') && `Budget: ${get('budget')}`,
      get('current-site') && `Current site: ${get('current-site')}`,
      get('message') && `\n${get('message')}`,
    ].filter(Boolean)
    window.open(`https://wa.me/${number}?text=${encodeURIComponent(lines.join('\n'))}`, '_blank', 'noopener')
  }

  form.addEventListener('submit', onSubmit)
  form.addEventListener('focusout', onBlur)
  form.addEventListener('change', onChange)
  form.addEventListener('input', onChange)
  waButton?.addEventListener('click', onWhatsApp)

  const again = document.querySelector<HTMLButtonElement>('[data-form-again]')
  const onAgain = () => {
    if (success) success.hidden = true
    form.hidden = false
    form.querySelector<HTMLInputElement>('input:not([type=hidden])')?.focus()
  }
  again?.addEventListener('click', onAgain)

  return () => {
    form.removeEventListener('submit', onSubmit)
    form.removeEventListener('focusout', onBlur)
    form.removeEventListener('change', onChange)
    form.removeEventListener('input', onChange)
    waButton?.removeEventListener('click', onWhatsApp)
    again?.removeEventListener('click', onAgain)
  }
}
