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
    for (const hit of chart.querySelectorAll<SVGElement>('.hit')) {
        hit.addEventListener('pointerenter', () => show(hit))
        hit.addEventListener('focus', () => show(hit))
        hit.addEventListener('blur', hide)
    }
    chart.addEventListener('pointerleave', hide)
}
