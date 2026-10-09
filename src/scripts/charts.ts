// Chart read-out: hovering, tapping or tabbing to a year shows its exact value
// in a tooltip and highlights that column. Charts carry one transparent hit
// area per year (.hit) with data-col, data-label, data-text and the anchor
// position as fractions of the chart (data-x, data-y).

for (const chart of document.querySelectorAll<HTMLElement>('[data-chart]')) {
    const tip = chart.querySelector<HTMLElement>('.chart__tip')!
    const cols = chart.querySelectorAll<SVGElement>('[data-col]')
    const show = (hit: SVGElement) => {
        const { col, label, text, x, y } = hit.dataset
        cols.forEach((el) => el.classList.toggle('is-active', el.dataset.col === col && !el.classList.contains('hit')))
        tip.innerHTML = ''
        const l = document.createElement('span')
        l.textContent = label!
        const v = document.createElement('strong')
        v.textContent = text!
        tip.append(l, v)
        tip.hidden = false
        const w = chart.clientWidth
        const left = Math.min(Math.max(Number(x) * w, tip.offsetWidth / 2), w - tip.offsetWidth / 2)
        tip.style.left = `${left}px`
        tip.style.top = `${Number(y) * chart.clientHeight}px`
    }
    const hide = () => {
        tip.hidden = true
        cols.forEach((el) => el.classList.remove('is-active'))
    }
    const hits = [...chart.querySelectorAll<SVGElement>('.hit')]
    for (const [i, hit] of hits.entries()) {
        hit.addEventListener('pointerenter', (event) => {
            if (event.pointerType === 'mouse') show(hit)
        })
        hit.addEventListener('click', () => show(hit))
        hit.addEventListener('focus', () => show(hit))
        hit.addEventListener('blur', hide)
        hit.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                show(hit)
            }
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault()
                hits[Math.max(0, Math.min(hits.length - 1, i + (event.key === 'ArrowRight' ? 1 : -1)))].focus()
            }
        })
    }
    chart.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') hide()
    })
    chart.addEventListener('pointerleave', (event) => {
        if (event.pointerType === 'mouse' && !hits.includes(document.activeElement as SVGElement)) hide()
    })
    document.addEventListener('pointerdown', (event) => {
        if (!chart.contains(event.target as Node)) hide()
    })
}
