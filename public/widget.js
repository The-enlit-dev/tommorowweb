/*! Tomorrow Web assistant widget
 * Embed:  <script src="https://YOUR-TOMORROW-WEB-SITE/widget.js" data-site="SITE_KEY" defer></script>
 * Options: data-theme="dark|light" (default light), data-accent="#111111", data-position="right|left"
 * Shows nothing unless the assistant is switched on for this site in the Tomorrow Web portal.
 * Answers come from AI when available, otherwise from the site's FAQs. If the AI service is
 * unreachable, the widget asks the FAQ database directly, so FAQ answers keep working.
 */
;(function () {
  'use strict'
  var script = document.currentScript
  if (!script || window.__twWidget) return
  window.__twWidget = true
  var KEY = script.getAttribute('data-site')
  if (!KEY) return
  var API = (script.getAttribute('data-api') || 'https://rijxesngcmhpxhoptsck.supabase.co').replace(/\/$/, '')
  var ANON = script.getAttribute('data-key') || 'sb_publishable_z9ilwxZjkoAOQB4p6GljiQ_iRRJK7y1'
  var DARK = script.getAttribute('data-theme') === 'dark'
  var ACCENT = /^#[0-9a-f]{3,8}$/i.test(script.getAttribute('data-accent') || '') ? script.getAttribute('data-accent') : DARK ? '#ffffff' : '#111111'
  var LEFT = script.getAttribute('data-position') === 'left'
  var STORE = 'tw-chat-' + KEY
  var cfg = null
  var history = []
  try { history = JSON.parse(sessionStorage.getItem(STORE) || '[]') } catch (e) { history = [] }

  function rpc(fn, args) {
    return fetch(API + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: { apikey: ANON, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    }).then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json() })
  }
  function save() { try { sessionStorage.setItem(STORE, JSON.stringify(history.slice(-20))) } catch (e) {} }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }

  var host, root, panel, list, input, sendBtn, launcher

  var css =
    ':host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '.tw{--bg:' + (DARK ? '#0b0b0b' : '#ffffff') + ';--ink:' + (DARK ? '#f4f4f4' : '#111111') + ';--muted:' + (DARK ? '#a3a3a3' : '#5b5b5b') + ';--line:' + (DARK ? '#262626' : '#e5e5e5') +
    ';--soft:' + (DARK ? '#161616' : '#f4f4f4') + ';--accent:' + ACCENT + ';position:fixed;bottom:16px;' + (LEFT ? 'left' : 'right') + ':16px;z-index:2147483000;color:var(--ink)}' +
    '.launch{display:flex;align-items:center;gap:8px;height:52px;padding:0 18px;border:0;border-radius:999px;background:var(--accent);color:' + (DARK ? '#0b0b0b' : '#ffffff') + ';font:600 15px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 28px rgba(0,0,0,.25)}' +
    '.launch:focus-visible,.send:focus-visible,.x:focus-visible,.chip:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}' +
    '.panel{position:absolute;bottom:64px;' + (LEFT ? 'left' : 'right') + ':0;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100vh - 110px));display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--line);border-radius:18px;box-shadow:0 18px 60px rgba(0,0,0,.3);overflow:hidden}' +
    '.panel[hidden]{display:none}.head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line)}.head b{font-size:15px}.head small{display:block;color:var(--muted);font-size:12px}' +
    '.x{margin-left:auto;width:32px;height:32px;border:0;border-radius:8px;background:transparent;color:var(--ink);font-size:20px;cursor:pointer}' +
    '.list{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}' +
    '.msg{max-width:88%;padding:10px 12px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}' +
    '.me{align-self:flex-end;background:var(--accent);color:' + (DARK ? '#0b0b0b' : '#ffffff') + ';border-bottom-right-radius:4px}' +
    '.bot{align-self:flex-start;background:var(--soft);border-bottom-left-radius:4px}.tag{display:block;margin-top:6px;color:var(--muted);font-size:11px}' +
    '.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{border:1px solid var(--line);background:transparent;color:var(--ink);border-radius:999px;padding:6px 10px;font-size:12px;cursor:pointer;text-align:left}' +
    '.foot{border-top:1px solid var(--line);padding:10px 12px}.row{display:flex;gap:8px;align-items:flex-end}' +
    'textarea{flex:1;resize:none;max-height:110px;min-height:42px;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--ink);font-size:14px}' +
    '.send{height:42px;padding:0 14px;border:0;border-radius:12px;background:var(--accent);color:' + (DARK ? '#0b0b0b' : '#ffffff') + ';font-weight:600;cursor:pointer}.send:disabled{opacity:.5;cursor:default}' +
    '.links{display:flex;gap:12px;margin-top:8px;font-size:12px}.links a{color:var(--ink)}.note{margin-top:6px;color:var(--muted);font-size:11px}' +
    '.dots::after{content:"…";animation:d 1s steps(3,end) infinite}@keyframes d{0%{content:"."}33%{content:".."}66%{content:"…"}}' +
    '@media (max-width:480px){.tw{bottom:12px;' + (LEFT ? 'left' : 'right') + ':12px}.panel{position:fixed;inset:auto 8px 76px 8px;width:auto;height:min(75vh,560px)}}' +
    '@media (prefers-reduced-motion:reduce){.dots::after{animation:none}}'

  function bubble(text, who, tag) {
    var m = el('div', 'msg ' + (who === 'me' ? 'me' : 'bot'), text)
    if (tag) m.appendChild(el('span', 'tag', tag))
    list.appendChild(m)
    list.scrollTop = list.scrollHeight
    return m
  }
  function chips(items) {
    if (!items || !items.length) return
    var wrap = el('div', 'chips')
    items.forEach(function (f) {
      var c = el('button', 'chip', f.question)
      c.type = 'button'
      c.addEventListener('click', function () { bubble(f.question, 'me'); bubble(f.answer, 'bot', 'From our FAQs'); history.push({ role: 'user', content: f.question }, { role: 'assistant', content: f.answer }); save() })
      wrap.appendChild(c)
    })
    list.appendChild(wrap)
    list.scrollTop = list.scrollHeight
  }
  function noAnswer() {
    var t = 'Sorry, I don’t have an answer for that.'
    if (cfg.whatsapp || cfg.contact_url) t += ' Please contact us — we’ll be happy to help.'
    bubble(t, 'bot')
  }
  function showFaq(faq, lead) {
    if (faq && faq.length) {
      bubble((lead ? lead + '\n\n' : '') + faq[0].answer, 'bot', 'From our FAQs')
      history.push({ role: 'assistant', content: faq[0].answer })
      if (faq.length > 1) chips(faq.slice(1))
    } else noAnswer()
  }

  function ask(q) {
    bubble(q, 'me')
    history.push({ role: 'user', content: q })
    save()
    var wait = bubble('', 'bot')
    wait.classList.add('dots')
    sendBtn.disabled = true
    fetch(API + '/functions/v1/ai', {
      method: 'POST',
      headers: { apikey: ANON, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'chat', site_key: KEY, messages: history.slice(-8) }),
    })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then(function (d) {
        wait.remove()
        if (d.available && d.reply) {
          bubble(d.reply, 'bot', 'AI answer — may be imperfect')
          history.push({ role: 'assistant', content: d.reply })
          save()
        } else showFaq(d.faq)
      })
      .catch(function () {
        // AI service unreachable: ask the FAQ database directly (works without the AI service).
        return rpc('faq_answer', { p_key: KEY, p_question: q, p_limit: 3 })
          .then(function (faq) { wait.remove(); showFaq(faq) })
          .catch(function () { wait.remove(); noAnswer() })
      })
      .then(function () { sendBtn.disabled = false; save() })
  }

  function open(on) {
    panel.hidden = !on
    launcher.setAttribute('aria-expanded', String(on))
    if (on) setTimeout(function () { input.focus() }, 30)
    else launcher.focus()
  }

  function build() {
    host = document.createElement('div')
    host.id = 'tw-assistant'
    root = host.attachShadow({ mode: 'open' })
    var style = el('style')
    style.textContent = css
    var wrap = el('div', 'tw')
    launcher = el('button', 'launch', 'Ask us')
    launcher.type = 'button'
    launcher.setAttribute('aria-expanded', 'false')
    launcher.setAttribute('aria-controls', 'tw-panel')
    panel = el('div', 'panel')
    panel.id = 'tw-panel'
    panel.hidden = true
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', (cfg.name || 'Website') + ' assistant')
    var head = el('div', 'head')
    var title = el('div')
    title.appendChild(el('b', null, cfg.name || 'Assistant'))
    title.appendChild(el('small', null, 'Usually answers instantly'))
    var x = el('button', 'x', '×')
    x.type = 'button'
    x.setAttribute('aria-label', 'Close')
    head.appendChild(title)
    head.appendChild(x)
    list = el('div', 'list')
    list.setAttribute('aria-live', 'polite')
    var foot = el('div', 'foot')
    var form = el('form', 'row')
    input = el('textarea')
    input.rows = 1
    input.maxLength = 1000
    input.placeholder = 'Type your question…'
    input.setAttribute('aria-label', 'Your question')
    sendBtn = el('button', 'send', 'Send')
    sendBtn.type = 'submit'
    form.appendChild(input)
    form.appendChild(sendBtn)
    foot.appendChild(form)
    var links = el('div', 'links')
    if (cfg.whatsapp) { var w = el('a', null, 'WhatsApp us'); w.href = 'https://wa.me/' + cfg.whatsapp; w.target = '_blank'; w.rel = 'noopener'; links.appendChild(w) }
    if (cfg.contact_url) { var c = el('a', null, 'Contact page'); c.href = cfg.contact_url; links.appendChild(c) }
    if (links.childNodes.length) foot.appendChild(links)
    foot.appendChild(el('div', 'note', 'Answers can be imperfect. For bookings and prices, please confirm with us.'))
    panel.appendChild(head)
    panel.appendChild(list)
    panel.appendChild(foot)
    wrap.appendChild(panel)
    wrap.appendChild(launcher)
    root.appendChild(style)
    root.appendChild(wrap)

    bubble(cfg.greeting || 'Hi! Ask me anything about ' + (cfg.name || 'us') + '.', 'bot')
    history.forEach(function (m) { bubble(m.content, m.role === 'user' ? 'me' : 'bot') })

    launcher.addEventListener('click', function () { open(panel.hidden) })
    x.addEventListener('click', function () { open(false) })
    panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') open(false) })
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit() } })
    form.addEventListener('submit', function (e) {
      e.preventDefault()
      var q = input.value.trim()
      if (!q || sendBtn.disabled) return
      input.value = ''
      ask(q)
    })
    attach()
  }

  function attach() { if (host && !host.isConnected) document.body.appendChild(host) }
  // Astro view transitions replace <body>; put the widget back after each navigation.
  document.addEventListener('astro:after-swap', attach)

  function init() {
    rpc('ai_widget_config', { p_key: KEY })
      .then(function (c) { if (c && c.enabled) { cfg = c; build() } })
      .catch(function () {})
  }
  if ('requestIdleCallback' in window) requestIdleCallback(init, { timeout: 3000 })
  else setTimeout(init, 1200)
})()
