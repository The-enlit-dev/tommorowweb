/**
 * Category filter on /work/. Without JavaScript every project is shown and the
 * filter buttons stay hidden.
 */
export function initWorkFilter() {
  const bar = document.querySelector<HTMLElement>('[data-filter]')
  const items = Array.from(document.querySelectorAll<HTMLElement>('[data-filter-item]'))
  if (!bar || !items.length) return
  bar.hidden = false
  const buttons = Array.from(bar.querySelectorAll<HTMLButtonElement>('button[data-value]'))
  const status = document.querySelector<HTMLElement>('[data-filter-status]')

  const apply = (value: string) => {
    let shown = 0
    for (const item of items) {
      const match = value === 'All' || (item.dataset.filterItem ?? '').split('|').includes(value)
      item.hidden = !match
      if (match) shown++
    }
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)))
    if (status) status.textContent = `Showing ${shown} ${shown === 1 ? 'project' : 'projects'}${value === 'All' ? '' : ` in ${value}`}.`
  }

  const onClick = (e: Event) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-value]')
    if (btn) apply(btn.dataset.value ?? 'All')
  }
  bar.addEventListener('click', onClick)
  return () => bar.removeEventListener('click', onClick)
}
