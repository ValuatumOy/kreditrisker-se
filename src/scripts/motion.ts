// Page motion, shared by every page. Everything is visible without JS and
// with reduced motion; this only adds entrance, count-up and pointer light.

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches

// Scroll reveal
const io = new IntersectionObserver(
    (entries) => {
        for (const e of entries) {
            if (!e.isIntersecting) continue
            e.target.classList.add('in')
            io.unobserve(e.target)
        }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
)
document.querySelectorAll('.reveal').forEach((el) => io.observe(el))

// Count-up: <span data-count="30.2" data-decimals="1" data-suffix=" Mkr">30,2 Mkr</span>
const fmt = (n: number, d: number) => n.toLocaleString('sv-SE', { minimumFractionDigits: d, maximumFractionDigits: d }).replace('-', '−')
const counters = new IntersectionObserver(
    (entries) => {
        for (const e of entries) {
            if (!e.isIntersecting) continue
            counters.unobserve(e.target)
            const el = e.target as HTMLElement
            const to = Number(el.dataset.count)
            const d = Number(el.dataset.decimals ?? 0)
            const pre = el.dataset.prefix ?? ''
            const suf = el.dataset.suffix ?? ''
            const t0 = performance.now()
            const dur = 1400
            const tick = (t: number) => {
                const p = Math.min(1, (t - t0) / dur)
                const eased = 1 - Math.pow(1 - p, 4)
                el.textContent = pre + fmt(to * eased, d) + suf
                if (p < 1) requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
        }
    },
    { threshold: 0.4 },
)
if (!reduce) document.querySelectorAll('[data-count]').forEach((el) => counters.observe(el))

// Pointer light on cards: sets --mx/--my for a radial highlight.
document.querySelectorAll<HTMLElement>('[data-spotlight]').forEach((el) => {
    el.addEventListener('pointermove', (ev) => {
        const r = el.getBoundingClientRect()
        el.style.setProperty('--mx', `${ev.clientX - r.left}px`)
        el.style.setProperty('--my', `${ev.clientY - r.top}px`)
    })
})

// Gentle parallax tilt: [data-tilt] follows the pointer within its parent.
if (!reduce && matchMedia('(pointer: fine)').matches) {
    document.querySelectorAll<HTMLElement>('[data-tilt]').forEach((el) => {
        const host = el.parentElement!
        const max = Number(el.dataset.tilt || 6)
        host.addEventListener('pointermove', (ev) => {
            const r = host.getBoundingClientRect()
            const x = (ev.clientX - r.left) / r.width - 0.5
            const y = (ev.clientY - r.top) / r.height - 0.5
            el.style.transform = `perspective(1400px) rotateY(${x * max}deg) rotateX(${-y * max}deg)`
        })
        host.addEventListener('pointerleave', () => (el.style.transform = ''))
    })
}

// Nav turns solid once the page scrolls past the hero.
const nav = document.querySelector<HTMLElement>('[data-nav]')
if (nav) {
    const onScroll = () => nav.classList.toggle('is-scrolled', scrollY > 24)
    onScroll()
    addEventListener('scroll', onScroll, { passive: true })
}
