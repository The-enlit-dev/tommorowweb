/**
 * Motion graphics: the interactive dot field, text scramble, spotlight cards
 * and magnetic buttons. Every effect checks prefers-reduced-motion and works
 * with touch as well as a mouse.
 */
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const finePointer = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches

/* ── Dot field ────────────────────────────────────────────────────────────────
   A grid of dots behind the hero. Dots shimmer gently, brighten and part
   around the pointer, and ripples run outwards from taps and clicks. With no
   pointer (phones) ripples start on their own every few seconds. */
export function initDotField() {
  const canvas = document.querySelector<HTMLCanvasElement>('[data-dotfield]')
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  const host = canvas.parentElement ?? canvas
  const GAP = 30
  const R = 170
  let w = 0
  let h = 0
  let dpr = 1
  let dots: { x: number; y: number }[] = []
  const pointer = { x: -9999, y: -9999, on: false }
  const ripples: { x: number; y: number; t: number }[] = []
  let raf = 0
  let visible = true
  let lastAuto = 0

  const resize = () => {
    const r = canvas.getBoundingClientRect()
    dpr = Math.min(2, window.devicePixelRatio || 1)
    w = r.width
    h = r.height
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    dots = []
    const ox = (w % GAP) / 2 + GAP / 2
    const oy = (h % GAP) / 2 + GAP / 2
    for (let y = oy; y < h; y += GAP) for (let x = ox; x < w; x += GAP) dots.push({ x, y })
    if (reduced()) draw(0)
  }

  const draw = (t: number) => {
    ctx.clearRect(0, 0, w, h)
    const still = reduced()
    for (const d of dots) {
      let a = 0.13
      let rad = 1
      let x = d.x
      let y = d.y
      if (!still) {
        // slow diagonal shimmer
        a += 0.07 * (0.5 + 0.5 * Math.sin(t * 0.0011 - d.x * 0.011 - d.y * 0.007))
        if (pointer.on) {
          const dx = d.x - pointer.x
          const dy = d.y - pointer.y
          const dist = Math.hypot(dx, dy)
          if (dist < R) {
            const k = (1 - dist / R) ** 2
            a += 0.75 * k
            rad += 1.5 * k
            const push = (8 * k) / (dist || 1)
            x += dx * push
            y += dy * push
          }
        }
        for (const rp of ripples) {
          const age = t - rp.t
          const ring = age * 0.42
          const off = Math.abs(Math.hypot(d.x - rp.x, d.y - rp.y) - ring)
          if (off < 34) {
            const k = (1 - off / 34) * Math.max(0, 1 - age / 1800)
            a += 0.6 * k
            rad += 1.1 * k
          }
        }
      }
      ctx.fillStyle = `rgba(255,255,255,${Math.min(1, a).toFixed(3)})`
      ctx.beginPath()
      ctx.arc(x, y, rad, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  const loop = (t: number) => {
    raf = 0
    if (!visible || document.hidden) return
    while (ripples.length && t - ripples[0].t > 1800) ripples.shift()
    // Phones (and idle mice): a ripple every few seconds keeps the field alive.
    if (!pointer.on && t - lastAuto > 3200) {
      lastAuto = t
      ripples.push({ x: w * (0.2 + Math.random() * 0.6), y: h * (0.25 + Math.random() * 0.5), t })
    }
    draw(t)
    raf = requestAnimationFrame(loop)
  }
  const start = () => {
    if (!raf && !reduced()) raf = requestAnimationFrame(loop)
  }

  const toLocal = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return
    Object.assign(pointer, toLocal(e), { on: true })
  }
  const onLeave = () => {
    pointer.on = false
  }
  const onDown = (e: PointerEvent) => {
    const p = toLocal(e)
    ripples.push({ ...p, t: performance.now() })
    lastAuto = performance.now()
  }
  const io = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    if (visible) start()
  })
  const ro = new ResizeObserver(resize)
  const onVis = () => !document.hidden && start()

  resize()
  io.observe(canvas)
  ro.observe(canvas)
  host.addEventListener('pointermove', onMove, { passive: true })
  host.addEventListener('pointerleave', onLeave)
  host.addEventListener('pointerdown', onDown, { passive: true })
  document.addEventListener('visibilitychange', onVis)
  start()

  return () => {
    cancelAnimationFrame(raf)
    io.disconnect()
    ro.disconnect()
    host.removeEventListener('pointermove', onMove)
    host.removeEventListener('pointerleave', onLeave)
    host.removeEventListener('pointerdown', onDown)
    document.removeEventListener('visibilitychange', onVis)
  }
}

/* ── Text scramble ────────────────────────────────────────────────────────────
   Small mono labels decode from random characters when they scroll into view.
   Screen readers get the real text straight away from a visually hidden copy. */
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=<>/'

export function initScramble() {
  const els = Array.from(document.querySelectorAll<HTMLElement>('[data-scramble]:not([data-scrambled])'))
  if (!els.length) return
  const timers: number[] = []

  const run = (el: HTMLElement) => {
    const text = el.textContent?.trim() ?? ''
    el.dataset.scrambled = ''
    if (reduced() || !text) return
    el.textContent = ''
    const sr = document.createElement('span')
    sr.className = 'sr-only'
    sr.textContent = text
    const vis = document.createElement('span')
    vis.setAttribute('aria-hidden', 'true')
    el.append(sr, vis)
    const start = performance.now()
    const dur = 700 + text.length * 18
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / dur)
      const shown = Math.floor(p * text.length)
      let out = ''
      for (let i = 0; i < text.length; i++) {
        const c = text[i]
        out += i < shown || c === ' ' || c === '·' ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0]
      }
      vis.textContent = out
      if (p < 1) timers.push(requestAnimationFrame(tick))
    }
    timers.push(requestAnimationFrame(tick))
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        io.unobserve(e.target)
        run(e.target as HTMLElement)
      }
    },
    { threshold: 0.6 },
  )
  els.forEach((el) => io.observe(el))
  return () => {
    io.disconnect()
    timers.forEach((t) => cancelAnimationFrame(t))
  }
}

/* ── Spotlight ────────────────────────────────────────────────────────────────
   A soft light follows the pointer across cards marked data-spotlight. */
export function initSpotlight() {
  if (!finePointer()) return
  const onMove = (e: PointerEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-spotlight]')
    if (!el) return
    const r = el.getBoundingClientRect()
    el.style.setProperty('--mx', `${e.clientX - r.left}px`)
    el.style.setProperty('--my', `${e.clientY - r.top}px`)
  }
  document.addEventListener('pointermove', onMove, { passive: true })
  return () => document.removeEventListener('pointermove', onMove)
}

/* ── Magnetic buttons ─────────────────────────────────────────────────────────
   Buttons marked data-magnetic lean gently towards the cursor. */
export function initMagnetic() {
  if (!finePointer() || reduced()) return
  const els = Array.from(document.querySelectorAll<HTMLElement>('[data-magnetic]'))
  const handlers = els.map((el) => {
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      const x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2)
      const y = (e.clientY - (r.top + r.height / 2)) / (r.height / 2)
      el.style.translate = `${(x * 6).toFixed(1)}px ${(y * 5).toFixed(1)}px`
    }
    const leave = () => {
      el.style.translate = ''
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', leave)
    return () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerleave', leave)
      el.style.translate = ''
    }
  })
  return () => handlers.forEach((fn) => fn())
}
