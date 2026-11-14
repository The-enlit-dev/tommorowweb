/**
 * "Today / Tomorrow" comparison slider.
 * Drag (mouse or touch) anywhere on the frame, or use the arrow keys on the
 * focusable range input. Vertical swipes still scroll the page on phones.
 */
export function initCompare() {
  const root = document.querySelector<HTMLElement>('[data-compare]')
  if (!root) return
  const range = root.querySelector<HTMLInputElement>('input[type="range"]')
  if (!range) return
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const set = (v: number) => {
    const clamped = Math.min(100, Math.max(0, v))
    root.style.setProperty('--pos', `${clamped}%`)
    range.value = String(Math.round(clamped))
    range.setAttribute('aria-valuetext', `${Math.round(100 - clamped)}% of the new design showing`)
  }

  let dragging = false
  let interacted = false
  const fromEvent = (e: PointerEvent) => {
    const r = root.getBoundingClientRect()
    set(((e.clientX - r.left) / r.width) * 100)
  }
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return
    dragging = true
    interacted = true
    root.classList.add('is-dragging')
    root.setPointerCapture(e.pointerId)
    fromEvent(e)
  }
  const move = (e: PointerEvent) => dragging && fromEvent(e)
  const up = () => {
    dragging = false
    root.classList.remove('is-dragging')
  }
  const input = () => {
    interacted = true
    set(Number(range.value))
  }

  root.addEventListener('pointerdown', down)
  root.addEventListener('pointermove', move)
  root.addEventListener('pointerup', up)
  root.addEventListener('pointercancel', up)
  range.addEventListener('input', input)
  set(Number(range.value))

  // A one-off sweep the first time it scrolls into view hints that it moves.
  let io: IntersectionObserver | undefined
  let raf = 0
  if (!reduced && 'IntersectionObserver' in window) {
    io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        io?.disconnect()
        const keys = [50, 18, 82, 50]
        const dur = 2400
        const t0 = performance.now() + 400
        const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
        const step = (now: number) => {
          if (interacted) return
          const t = Math.min(1, Math.max(0, (now - t0) / dur))
          const seg = Math.min(keys.length - 2, Math.floor(t * (keys.length - 1)))
          const local = t * (keys.length - 1) - seg
          set(keys[seg] + (keys[seg + 1] - keys[seg]) * ease(local))
          if (t < 1) raf = requestAnimationFrame(step)
        }
        raf = requestAnimationFrame(step)
      },
      { threshold: 0.6 },
    )
    io.observe(root)
  }

  return () => {
    cancelAnimationFrame(raf)
    io?.disconnect()
    root.removeEventListener('pointerdown', down)
    root.removeEventListener('pointermove', move)
    root.removeEventListener('pointerup', up)
    root.removeEventListener('pointercancel', up)
    range.removeEventListener('input', input)
  }
}
