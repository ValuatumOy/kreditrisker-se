const el = (id) => document.getElementById(id)
let state
let selectionVersion = 0
const labels = { match: 'Täsmää', difference: 'Ero', manual: 'Tarkista käsin', unavailable: 'Tieto puuttuu' }
const number = new Intl.NumberFormat('fi-FI', { maximumFractionDigits: 2 })
const format = (cell) => cell?.value == null ? '—' : number.format(cell.value)
function message(text, error = false) { el('message').textContent = text; el('message').classList.toggle('error', error) }
async function api(path, body) {
    const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
    const result = await response.json()
    if (!response.ok || result.error) throw new Error(result.error || 'Pyyntö epäonnistui.')
    return result
}
function link(id, url) {
    const node = el(id)
    node.hidden = !url
    if (!url) { node.removeAttribute('href'); return }
    const parsed = new URL(url, location.origin)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) { node.hidden = true; return }
    node.href = parsed.href
}
function showDocument(index, anchor = '') {
    el('document').value = String(index)
    el('original-frame').src = `/filing/${index}${anchor ? '#' + encodeURIComponent(anchor) : ''}`
    link('open-filing', `/filing/${index}`)
}
function periods() {
    const company = state.companies.find(c => String(c.id) === el('company').value)
    el('period').replaceChildren(...company.periods.map(end => new Option(end, end)))
    const sourceDates = new Set((state.sourcePeriods || []).map(p => p.end))
    const shared = company.periods.find(end => sourceDates.has(end))
    if (shared) el('period').value = shared
    // The public orgnr route is an alias; its canonical company name comes from backend metadata.
    const slug = company.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    el('website-url').value = `${state.siteOrigin}/foretag/${company.orgnr}/${slug}/`
    link('open-website', el('website-url').value)
}
function renderState(next, preserve = false) {
    const previous = el('company').value
    state = next
    el('company').replaceChildren(...state.companies.map(c => new Option(`${c.name} · ${c.orgnr}`, c.id)))
    if (preserve && state.companies.some(c => String(c.id) === previous)) el('company').value = previous
    periods()
    const docs = state.documents || []
    el('document').replaceChildren(...docs.map((d, i) => new Option(d.kind === 'annual' ? 'Tilinpäätös' : d.kind === 'audit' ? 'Tilintarkastuskertomus' : d.title || d.name, i)))
    el('original-frame').hidden = !docs.length
    el('filing-empty').hidden = !!docs.length
    el('document').disabled = !docs.length
    el('compare').disabled = !docs.length || !el('period').options.length
    if (docs.length) showDocument(Math.max(0, docs.findIndex(d => d.kind === 'annual')))
    const audit = docs.findIndex(d => d.kind === 'audit')
    link('open-audit', audit >= 0 ? `/filing/${audit}` : '')
    if (!el('system-url').value && state.systemUrl) el('system-url').value = state.systemUrl
    link('open-system', el('system-url').value)
    renderReport()
}
function renderReport() {
    const report = state.report
    el('rows').replaceChildren()
    for (const id of ['summary', 'filter-label', 'technical', 'download', 'report-meta']) el(id).hidden = !report
    el('comparison-empty').hidden = !!report
    el('warnings').replaceChildren()
    el('warnings').hidden = !report?.warnings?.length
    for (const text of report?.warnings || []) { const p = document.createElement('p'); p.textContent = text; el('warnings').append(p) }
    if (!report) return
    const counts = report.rows.reduce((all, row) => { all[row.status] = (all[row.status] || 0) + 1; return all }, {})
    el('summary').textContent = `${counts.match || 0} täsmää · ${counts.difference || 0} eroa · ${(counts.manual || 0) + (counts.unavailable || 0)} tarkistettavaa`
    el('report-meta').textContent = `${report.company.name} · tilikausi päättyy ${report.periodEnd}. Valuatumin data: ${report.provenance.backendRetrievedAt || 'hakuaika puuttuu'}. Nettisivu tarkistettu: ${new Date(report.provenance.checkedAt).toLocaleString('fi-FI')}. Lähde: ${report.provenance.filingName}.`
    for (const row of report.rows) {
        if (el('only-open').checked && row.status === 'match') continue
        const tr = document.createElement('tr')
        const name = document.createElement('th'); name.scope = 'row'; name.textContent = row.label
        const evidence = row.official?.selectedFact
        if (evidence) { const button = document.createElement('button'); button.type = 'button'; button.className = 'evidence'; button.textContent = 'Näytä lähdeluku'; button.addEventListener('click', () => showDocument(evidence.documentIndex, evidence.elementId)); name.append(button) }
        tr.append(name)
        for (const field of ['official', 'backend', 'website']) { const td = document.createElement('td'); td.className = 'number'; td.textContent = format(row[field]); td.title = row[field]?.note || row[field]?.text || ''; tr.append(td) }
        const result = document.createElement('td'); result.className = `result ${row.status}`
        const strong = document.createElement('strong'); strong.textContent = labels[row.status] || row.status
        const detail = document.createElement('small'); detail.textContent = `Lähde → Valuatum: ${labels[row.sourceBackendStatus] || row.sourceBackendStatus}. Valuatum → sivu: ${labels[row.backendWebsiteStatus] || row.backendWebsiteStatus}.`
        result.append(strong, detail)
        if (row.status !== 'match') {
            const note = document.createElement('small')
            note.textContent = row.key === 'grossProfit' && row.official.value == null
                ? 'Bruttotulosta ei ole omana lähderivinään. Tarkista laskentatapa tuloslaskelmasta.'
                : /metadata|company identity|consolidation scope/.test(row.website.note || '')
                ? 'Sivulta ei voitu vahvistaa yritystä ja tarkkaa tilikautta. Tarkista ne käsin; vanha sivuversio tarvitsee uuden rakennuksen.'
                : row.status === 'difference' ? 'Luvuissa on pyöristyksen ylittävä ero. Tarkista lähderivi ja tilikausi.'
                : 'Lukua ei voitu varmistaa automaattisesti. Tarkista asiakirja ja avaa yrityssivu.'
            result.append(note)
        }
        tr.append(result); el('rows').append(tr)
    }
    el('technical-data').textContent = JSON.stringify(report, null, 2)
}
async function compare() {
    const version = selectionVersion
    el('compare').disabled = true
    message('Luetaan julkaistu yrityssivu ja vertaillaan tilikauden luvut…')
    try {
        const selected = { company: el('company').value, period: el('period').value, websiteUrl: el('website-url').value }
        const next = await api('/api/compare', selected)
        if (version !== selectionVersion) return
        state = next; renderReport()
        link('open-website', selected.websiteUrl)
        message('Vertailu valmis. Avaa lähdeluku ja tarkista mahdolliset erot alkuperäisestä tilinpäätöksestä.')
    } catch (error) { message(error.message, true) }
    finally { el('compare').disabled = false }
}
async function importFile(event, kind) {
    const file = event.target.files[0]
    if (!file) return
    if (file.size > 20 * 1024 * 1024) { message('Valitse yrityksen ZIP/XHTML (enintään 20 Mt), ei koko viikkopakettia.', true); return }
    message('Luetaan tiedosto…')
    try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
        const next = await api('/api/import', { kind, name: file.name, data: btoa(binary) })
        renderState(next, kind === 'filing')
        if (kind === 'backend') { el('company').value = String(next.companies.at(-1).id); periods() }
        message('Tiedosto luettu. Valitse tilikausi ja paina Vertaa luvut.')
    } catch (error) { message(error.message, true) }
}
el('compare-form').addEventListener('submit', event => { event.preventDefault(); compare() })
function invalidate() { selectionVersion++; state.report = null; renderReport(); message('Valinta muuttui. Paina Vertaa luvut uudelleen.') }
el('company').addEventListener('change', () => { periods(); invalidate() })
el('period').addEventListener('change', invalidate)
el('document').addEventListener('change', () => showDocument(Number(el('document').value)))
el('system-url').addEventListener('input', () => { try { link('open-system', el('system-url').value) } catch { el('open-system').hidden = true } })
el('website-url').addEventListener('input', () => { invalidate(); try { link('open-website', el('website-url').value) } catch { el('open-website').hidden = true } })
el('filing-file').addEventListener('change', event => importFile(event, 'filing'))
el('backend-file').addEventListener('change', event => importFile(event, 'backend'))
el('only-open').addEventListener('change', renderReport)
el('download').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.report, null, 2)], { type: 'application/json' })
    const href = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = href; a.download = `tarkistus-${state.report.company.orgnr}-${state.report.periodEnd}.json`; a.click(); URL.revokeObjectURL(href)
})
api('/api/state').then(next => { renderState(next); if (next.documents.length) compare(); else el('compare').disabled = true }).catch(error => message(error.message, true))
