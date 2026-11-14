/**
 * Site-wide behaviour. Runs once per page load — including navigations made by
 * Astro's ClientRouter, which fires `astro:page-load` after every swap.
 * Each feature looks for its own markup and does nothing if it isn't there.
 */
import Lenis from 'lenis'
import { initCompare } from './compare'
import { initEnquiryForm } from './enquiry'
import { initWorkFilter } from './filter'

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
let lenis: Lenis | null = null
let cleanups: Array<() => void> = []

/* ── Smooth scrolling ─────────────────────────────────────────────────────── */

function initLenis() {
  if (lenis || reducedMotion.matches) return
  lenis = new Lenis({ duration: 1.1, anchors: { offset: -80 }, autoRaf: true })
  lenis.on('scroll', onScroll)
}

/* ── Scroll-driven effects ────────────────────────────────────────────────── */

type ScrollFx = () => void
let scrollFx: ScrollFx[] = []
let ticking = false

function onScroll() {
  if (ticking) return
  ticking = true
  requestAnimationFrame(() => {
    ticking = false
    for (const fx of scrollFx) fx()
  })
}

/** 0 when the element's top hits the bottom of the viewport, 1 when its bottom hits the top. */
function progress(el: Element, start = 1, end = 0) {
  const r = el.getBoundingClientRect()
  const vh = window.innerHeight
  const from = vh * start
  const to = vh * end - r.height
  return Math.min(1, Math.max(0, (from - r.top) / (from - to)))
}

function initScrollFx() {
  scrollFx = []

  // Header: solid once scrolled, hides on the way down, returns on the way up.
  const header = document.querySelector<HTMLElement>('[data-header]')
  let lastY = window.scrollY
  if (header) {
    scrollFx.push(() => {
      const y = window.scrollY
      header.classList.toggle('is-scrolled', y > 8)
      const menuOpen = document.documentElement.classList.contains('menu-open')
      header.classList.toggle('is-hidden', !menuOpen && y > 400 && y > lastY + 2)
      if (Math.abs(y - lastY) > 2) lastY = y
    })
  }

  if (!reducedMotion.matches) {
    // Hero sun rises as you scroll away from it.
    document.querySelectorAll<HTMLElement>('[data-sunrise]').forEach((el) => {
      const host = el.closest('section') ?? el
      scrollFx.push(() => {
        const p = progress(host, 1, 0)
        el.style.setProperty('--rise', p.toFixed(4))
      })
    })

    // Statement text lights up word by word as it scrolls through the viewport.
    document.querySelectorAll<HTMLElement>('[data-scrub]').forEach((el) => {
      const words = Array.from(el.querySelectorAll<HTMLElement>('.w'))
      scrollFx.push(() => {
        const p = progress(el, 0.85, 0.35)
        const lit = p * words.length
        words.forEach((w, i) => w.classList.toggle('is-lit', i < lit))
      })
    })

    // Generic 0→1 progress variable for CSS (e.g. process line).
    document.querySelectorAll<HTMLElement>('[data-progress]').forEach((el) => {
      scrollFx.push(() => el.style.setProperty('--p', progress(el, 0.7, 0.5).toFixed(4)))
    })

    // Stacked work cards shrink slightly as the next card covers them.
    const stack = Array.from(document.querySelectorAll<HTMLElement>('[data-stack-card]'))
    if (stack.length > 1) {
      scrollFx.push(() => {
        stack.forEach((card, i) => {
          const next = stack[i + 1]
          if (!next) return
          const top = next.getBoundingClientRect().top
          const vh = window.innerHeight
          const p = Math.min(1, Math.max(0, 1 - (top - 120) / (vh * 0.85)))
          card.style.setProperty('--cover', p.toFixed(4))
        })
      })
    }
  } else {
    // With reduced motion, everything is shown in its final state.
    document.querySelectorAll<HTMLElement>('[data-scrub] .w').forEach((w) => w.classList.add('is-lit'))
    document.querySelectorAll<HTMLElement>('[data-progress]').forEach((el) => el.style.setProperty('--p', '1'))
  }

  onScroll()
  if (!lenis) {
    window.addEventListener('scroll', onScroll, { passive: true })
    cleanups.push(() => window.removeEventListener('scroll', onScroll))
  }
  window.addEventListener('resize', onScroll, { passive: true })
  cleanups.push(() => window.removeEventListener('resize', onScroll))
}

/* ── Reveal on scroll ─────────────────────────────────────────────────────── */

function initReveals() {
  const els = document.querySelectorAll<HTMLElement>('[data-reveal], [data-lines]')
  if (!('IntersectionObserver' in window) || reducedMotion.matches) {
    els.forEach((el) => el.classList.add('is-in'))
    return
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('is-in')
          io.unobserve(e.target)
        }
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
  )
  els.forEach((el) => io.observe(el))
  cleanups.push(() => io.disconnect())
}

/* ── Mobile menu ──────────────────────────────────────────────────────────── */

function initMenu() {
  const toggle = document.querySelector<HTMLButtonElement>('[data-menu-toggle]')
  const menu = document.querySelector<HTMLElement>('[data-menu]')
  if (!toggle || !menu) return
  const label = toggle.querySelector('.menu-toggle-label')
  const root = document.documentElement

  const setOpen = (open: boolean, restoreFocus = true) => {
    toggle.setAttribute('aria-expanded', String(open))
    if (label) label.textContent = open ? 'Close' : 'Menu'
    root.classList.toggle('menu-open', open)
    if (open) {
      menu.hidden = false
      requestAnimationFrame(() => menu.classList.add('is-open'))
      lenis?.stop()
      document.body.style.overflow = 'hidden'
      menu.querySelector<HTMLElement>('a')?.focus({ preventScroll: true })
    } else {
      menu.classList.remove('is-open')
      lenis?.start()
      document.body.style.overflow = ''
      const done = () => {
        if (!menu.classList.contains('is-open')) menu.hidden = true
      }
      reducedMotion.matches ? done() : setTimeout(done, 700)
      if (restoreFocus) toggle.focus({ preventScroll: true })
    }
  }

  const onToggle = () => setOpen(toggle.getAttribute('aria-expanded') !== 'true')
  const onKey = (e: KeyboardEvent) => {
    if (toggle.getAttribute('aria-expanded') !== 'true') return
    if (e.key === 'Escape') {
      setOpen(false)
      return
    }
    if (e.key === 'Tab') {
      // Keep focus inside the toggle + menu while open.
      const items = [toggle, ...menu.querySelectorAll<HTMLElement>('a, button')]
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }
  const onLink = (e: Event) => {
    if ((e.target as HTMLElement).closest('a')) setOpen(false, false)
  }
  const mq = window.matchMedia('(min-width: 861px)')
  const onMq = () => mq.matches && setOpen(false, false)

  toggle.addEventListener('click', onToggle)
  document.addEventListener('keydown', onKey)
  menu.addEventListener('click', onLink)
  mq.addEventListener('change', onMq)
  cleanups.push(() => {
    toggle.removeEventListener('click', onToggle)
    document.removeEventListener('keydown', onKey)
    menu.removeEventListener('click', onLink)
    mq.removeEventListener('change', onMq)
    root.classList.remove('menu-open')
    document.body.style.overflow = ''
    lenis?.start()
  })
}

/* ── Footer sign-off: "It's Saturday. See you Sunday." ────────────────────── */

function initTomorrow() {
  const el = document.querySelector<HTMLElement>('[data-tomorrow]')
  if (!el) return
  const fmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long' })
  const today = new Date()
  const tomorrow = new Date(today)
  tomorrow.setDate(today.getDate() + 1)
  el.textContent = `It’s ${fmt.format(today)}. See you ${fmt.format(tomorrow)}.`
}

/* ── Boot ─────────────────────────────────────────────────────────────────── */

function init() {
  cleanups.forEach((fn) => fn())
  cleanups = []
  document.documentElement.classList.add('js')
  initLenis()
  if (lenis) {
    // Sync Lenis with the scroll position Astro set after a page swap.
    lenis.resize()
    lenis.scrollTo(window.scrollY, { immediate: true, force: true })
  }
  initReveals()
  initScrollFx()
  initMenu()
  initTomorrow()
  cleanups.push(...[initCompare(), initWorkFilter(), initEnquiryForm()].filter((fn): fn is () => void => !!fn))
}

document.addEventListener('astro:page-load', init)
document.addEventListener('astro:before-swap', () => lenis?.stop())
document.addEventListener('astro:after-swap', () => {
  document.documentElement.classList.add('js')
  lenis?.start()
})
