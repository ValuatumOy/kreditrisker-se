const el = (id) => document.getElementById(id)
let state
let selectionVersion = 0
let busy = false
let activeJob
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
    if (!company) return
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
    const previousPeriod = el('period').value
    state = next
    el('company').replaceChildren(...state.companies.map(c => new Option(`${c.name} · ${c.orgnr}`, c.id)))
    if (preserve && state.companies.some(c => String(c.id) === previous)) el('company').value = previous
    periods()
    if (preserve && [...el('period').options].some(p => p.value === previousPeriod)) el('period').value = previousPeriod
    const docs = state.documents || []
    el('document').replaceChildren(...docs.map((d, i) => new Option(d.kind === 'annual' ? 'Tilinpäätös' : d.kind === 'audit' ? 'Tilintarkastuskertomus' : d.title || d.name, i)))
    el('original-frame').hidden = !docs.length
    el('filing-empty').hidden = !!docs.length
    el('document').disabled = !docs.length
    el('compare').disabled = busy || !el('period').options.length
    el('data-mode').textContent = state.apiReady ? 'Valuatumin luvut haetaan API:sta. Tilinpäätös haetaan automaattisesti Bolagsverketistä.'
        : 'Valuatumin API-tunnus puuttuu. Käytössä ovat tallennetut luvut; tilinpäätös haetaan automaattisesti Bolagsverketistä.'
    if (docs.length) showDocument(Math.max(0, docs.findIndex(d => d.kind === 'annual')))
    else { el('original-frame').removeAttribute('src'); link('open-filing', '') }
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
    el('report-meta').textContent = `${report.company.name} · tilikausi päättyy ${report.periodEnd}. Valuatumin data (${report.provenance.backendMode === 'live' ? 'API-haku' : 'tallennettu'}): ${report.provenance.backendRetrievedAt || 'hakuaika puuttuu'}. Nettisivu tarkistettu: ${new Date(report.provenance.checkedAt).toLocaleString('fi-FI')}. Lähde: ${report.provenance.filingName}.`
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
function setBusy(value) {
    busy = value
    for (const id of ['compare', 'company', 'period', 'website-url', 'search', 'company-query', 'filing-file', 'backend-file', 'manual-mode']) el(id).disabled = value
    if (!value) el('compare').disabled = !el('period').options.length
    el('cancel').hidden = !value || !activeJob
}
async function completed(next) {
    const id = next.job?.id
    activeJob = id
    el('cancel').hidden = !id || next.job?.status !== 'running'
    while (next.job?.status === 'running') {
        message(next.job.message)
        await new Promise(resolve => setTimeout(resolve, 600))
        next = await api('/api/state')
        if (next.job?.id !== id) throw new Error('Haku muuttui toisessa ikkunassa. Tee valinta uudelleen.')
    }
    activeJob = null
    el('cancel').hidden = true
    renderState(next, true)
    if (next.job?.status === 'error') throw new Error(next.job.message)
    return next
}
async function selectCompany() {
    const id = el('company').value
    setBusy(true)
    invalidate()
    clearSourceView()
    try {
        const next = await completed(await api('/api/company', { company: id }))
        renderState(next, true)
        message('Valitse tilikausi ja paina Hae ja vertaa.')
    } catch (error) { message(error.message, true) }
    finally { setBusy(false) }
}
async function compare() {
    const version = selectionVersion
    setBusy(true)
    state.report = null; renderReport()
    if (!el('manual-mode').checked) clearSourceView()
    message('Haetaan tilinpäätös ja vertaillaan luvut…')
    try {
        const selected = { company: el('company').value, period: el('period').value, websiteUrl: el('website-url').value, automatic: !el('manual-mode').checked }
        const next = await completed(await api('/api/compare', selected))
        if (version !== selectionVersion) return
        renderState(next, true)
        el('website-url').value = selected.websiteUrl
        link('open-website', selected.websiteUrl)
        message('Vertailu valmis. Avaa lähdeluku ja tarkista mahdolliset erot alkuperäisestä tilinpäätöksestä.')
    } catch (error) { message(error.message, true) }
    finally { setBusy(false) }
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
        el('manual-mode').checked = true
        renderState(next, kind === 'filing')
        if (kind === 'backend') { el('company').value = String(next.companies.at(-1).id); periods() }
        message('Tiedosto luettu. Valitse tilikausi ja paina Hae ja vertaa.')
    } catch (error) { message(error.message, true) }
}
el('compare-form').addEventListener('submit', event => { event.preventDefault(); compare() })
el('cancel').addEventListener('click', async () => {
    if (activeJob) await api('/api/cancel', { id: activeJob })
})
function invalidate() { selectionVersion++; state.report = null; renderReport(); message('Valinta muuttui. Paina Hae ja vertaa uudelleen.') }
function clearSourceView() {
    state.documents = []; state.sourcePeriods = []
    el('original-frame').hidden = true; el('original-frame').removeAttribute('src')
    el('filing-empty').hidden = false
    el('document').replaceChildren(); el('document').disabled = true
    link('open-filing', ''); link('open-audit', '')
}
el('company').addEventListener('change', () => { periods(); selectCompany() })
el('period').addEventListener('change', () => { invalidate(); if (!el('manual-mode').checked) clearSourceView() })
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
el('search-form').addEventListener('submit', async event => {
    event.preventDefault(); setBusy(true)
    try {
        const found = await api('/api/search?q=' + encodeURIComponent(el('company-query').value))
        if (!found.length) { message(state.apiReady ? 'Yritystä ei löytynyt tuontimallilla. Kokeile organisationsnummeria.' : 'Yritystä ei löytynyt tallennetusta aineistosta. Laajempi haku tarvitsee Valuatumin API-tunnuksen.', true); return }
        const byId = new Map(state.companies.map(c => [String(c.id), c]))
        for (const c of found) byId.set(String(c.id), c)
        state.companies = [...byId.values()]
        el('company').replaceChildren(...found.map(c => new Option(`${c.name} · ${c.orgnr}`, c.id)))
        periods()
        await selectCompany()
    } catch (error) { message(error.message, true) }
    finally { setBusy(false) }
})
api('/api/state').then(async next => {
    renderState(next)
    if (next.job?.status === 'running') { setBusy(true); try { renderState(await completed(next), true) } finally { setBusy(false) } }
    else if (next.job?.status === 'error') message(next.job.message, true)
    else if (!next.report && !next.job && next.documents.length) { el('manual-mode').checked = true; compare() }
}).catch(error => message(error.message, true))
