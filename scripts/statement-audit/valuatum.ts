import path from 'node:path'
import { fetchBundle, type ApiCompany } from '../../src/lib/valuatum/api.ts'
import { parseOrgnr } from '../../src/lib/orgnr.ts'

const [mode, query] = process.argv.slice(2)
const base = process.env.PUBLIC_VALUATUM_API_BASE_URL
const token = process.env.SECRET_VALUATUM_API_TOKEN
try {
    if (!base || !token) throw new Error('Valuatumin API:n osoite ja tunnus puuttuvat paikallisista asetuksista.')
    if (mode === 'bundle') {
        if (!/^\d+$/.test(query)) throw new Error('Tuntematon yritys.')
        process.env.SE_API_REFRESH = '1'
        process.env.SE_API_CACHE_DIR = process.env.SE_AUDIT_REST_CACHE ?? path.resolve('data/statement-audit/rest')
        const bundle = await fetchBundle(query)
        if (!bundle) throw new Error('Yritykselle ei löytynyt tilinpäätöslukuja Valuatumista.')
        process.stdout.write(JSON.stringify(bundle))
    } else if (mode === 'search') {
        if (!query || query.length < 2 || query.length > 150) throw new Error('Kirjoita vähintään kaksi merkkiä.')
        const code = parseOrgnr(query)
        const params = new URLSearchParams(code.ok ? { code: code.orgnr } : { name: query })
        const response = await fetch(`${base.replace(/\/$/, '')}/rest/company?${params}`, {
            headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) throw new Error('Valuatumin yrityshaku epäonnistui. Tarkista API-tunnuksen käyttöoikeus.')
        const companies: ApiCompany[] = await response.json()
        const accounts = (process.env.SE_AUDIT_MODEL_ACCOUNTS ?? 'Data Import,Bolagsverket data import').split(',').map(s => s.trim().toLowerCase())
        process.stdout.write(JSON.stringify(companies.flatMap(company => {
            const orgnr = parseOrgnr(company.companyCode)
            if (!orgnr.ok || company.companyCode.endsWith('K')) return []
            const models = company.models.filter(model => accounts.includes(model.analystName?.toLowerCase()))
            if (models.length !== 1 || !/^\d+$/.test(String(models[0].followedModelId))) return []
            return [{ fid: String(models[0].followedModelId), orgnr: orgnr.orgnr, name: company.companyName }]
        }).slice(0, 30)))
    } else throw new Error('Tuntematon hakutapa.')
} catch (error) {
    process.stdout.write(JSON.stringify({ error: error instanceof Error && !error.message.startsWith('POST ') && !error.message.startsWith('GET ')
        ? error.message : 'Valuatumin API-haku epäonnistui. Tarkista osoite, tunnus ja käyttöoikeus.' }))
    process.exitCode = 1
}
