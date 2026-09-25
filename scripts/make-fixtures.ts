// Generates the synthetic development fixtures in data/fixtures/.
// Every record is synthetic: orgnr group 0 (does not exist in the register),
// names start with "Exempel", source "synthetic". Never publish as real.
//
//   node scripts/make-fixtures.ts

import fs from 'node:fs'
import path from 'node:path'
import { luhnCheckDigit } from '../src/lib/orgnr.ts'
import type { CompanyRecord, FiscalPeriod, MissingReason, SourceRef, Value } from '../src/lib/contract/types.ts'

const SRC: SourceRef = { source: 'synthetic', retrievedAt: '2026-09-01' }
const orgnr = (n: number) => {
    const nine = '002' + String(n).padStart(6, '0')
    return nine + luhnCheckDigit(nine)
}
const v = (n: number): Value => ({ status: 'reported', value: Math.round(n), source: SRC })
const miss = (reason: MissingReason = 'not_in_source'): Value => ({ status: 'missing', reason })

interface Fig {
    year: number
    sales: number
    ebit: number
    fin?: number
    tax?: number
    assets: number
    equity: number
    ur?: number
    inv?: number
    cash?: number
    ca?: number
    cl?: number
    ltl?: number
    emp?: number
    staff?: number
    months?: number
    end?: string
    omit?: string[]
    consolidated?: boolean
    framework?: FiscalPeriod['framework']
}

function period(f: Fig): FiscalPeriod {
    const months = f.months ?? 12
    const end = f.end ?? `${f.year}-12-31`
    const endD = new Date(end + 'T00:00:00Z')
    const startD = new Date(Date.UTC(endD.getUTCFullYear(), endD.getUTCMonth() - months + 1, 1))
    const fin = f.fin ?? -0.01 * f.sales
    const pafi = f.ebit + fin
    const net = pafi - (pafi > 0 ? (f.tax ?? 0.206) * pafi : 0)
    const o = new Set(f.omit ?? [])
    const val = (k: string, n: number | undefined) => (o.has(k) || n === undefined ? miss() : v(n))
    const ca = f.ca ?? f.assets * 0.55
    return {
        start: startD.toISOString().slice(0, 10),
        end,
        months,
        currency: 'SEK',
        consolidated: f.consolidated ?? false,
        framework: f.framework ?? 'K2',
        filedAt: new Date(Date.UTC(endD.getUTCFullYear(), endD.getUTCMonth() + 5, 15)).toISOString().slice(0, 10),
        source: { ...SRC, documentId: `SYN-${f.year}` },
        income: {
            netSales: val('sales', f.sales),
            operatingProfit: val('ebit', f.ebit),
            financialNet: val('fin', fin),
            profitAfterFinancialItems: val('pafi', pafi),
            netProfit: val('net', net),
            personnelCosts: val('staff', f.staff ?? (f.emp ? f.emp * 560_000 : undefined)),
        },
        balance: {
            totalAssets: val('assets', f.assets),
            equity: val('equity', f.equity),
            untaxedReserves: val('ur', f.ur ?? 0),
            inventories: val('inv', f.inv ?? 0),
            cash: val('cash', f.cash ?? ca * 0.4),
            currentAssets: val('ca', ca),
            currentLiabilities: val('cl', f.cl ?? f.assets * (0.3 + ((f.year % 3) - 1) * 0.035)),
            longTermLiabilities: val('ltl', f.ltl ?? Math.max(0, f.assets - f.equity - (f.cl ?? f.assets * (0.3 + ((f.year % 3) - 1) * 0.035)))),
        },
        employees: val('emp', f.emp),
    }
}

const KOMMUN = {
    sthlm: { code: '0180', name: 'Stockholm', county: 'Stockholms län' },
    gbg: { code: '1480', name: 'Göteborg', county: 'Västra Götalands län' },
    malmo: { code: '1280', name: 'Malmö', county: 'Skåne län' },
    uppsala: { code: '0380', name: 'Uppsala', county: 'Uppsala län' },
    lkpg: { code: '0580', name: 'Linköping', county: 'Östergötlands län' },
    umea: { code: '2480', name: 'Umeå', county: 'Västerbottens län' },
    orebro: { code: '1880', name: 'Örebro', county: 'Örebro län' },
    vasteras: { code: '1980', name: 'Västerås', county: 'Västmanlands län' },
}
const SNI = {
    software: { version: 'SNI2007', code: '62010', label: 'Dataprogrammering' },
    building: { version: 'SNI2007', code: '41200', label: 'Byggande av bostadshus och andra byggnader' },
    electric: { version: 'SNI2007', code: '43210', label: 'Elinstallationer' },
    restaurant: { version: 'SNI2007', code: '56100', label: 'Restaurangverksamhet' },
    haulage: { version: 'SNI2007', code: '49410', label: 'Vägtransport, godstrafik' },
    holding: { version: 'SNI2007', code: '64202', label: 'Holdingverksamhet i icke-finansiella koncerner' },
    metal: { version: 'SNI2007', code: '25620', label: 'Metallegoarbeten' },
    realestate: { version: 'SNI2007', code: '68201', label: 'Uthyrning och förvaltning av egna eller arrenderade bostäder' },
    dental: { version: 'SNI2007', code: '86230', label: 'Tandläkarverksamhet' },
    wholesale: { version: 'SNI2007', code: '46900', label: 'Icke specialiserad partihandel' },
    engineering: { version: 'SNI2007', code: '71121', label: 'Teknisk konsultverksamhet inom bygg- och anläggningsteknik' },
    hair: { version: 'SNI2007', code: '96021', label: 'Hårvård' },
} as const

function company(
    n: number,
    name: string,
    extra: Partial<CompanyRecord> & { figs?: Fig[] },
): CompanyRecord {
    const { figs, ...rest } = extra
    return {
        schemaVersion: 1,
        orgnr: orgnr(n) as CompanyRecord['orgnr'],
        synthetic: true,
        name,
        formerNames: [],
        legalForm: 'AB',
        status: { code: 'active', source: SRC },
        registeredAt: '2009-03-02',
        sni: [],
        periods: (figs ?? []).map(period),
        provenance: { batchId: 'fixture', importedAt: '2026-09-01T00:00:00Z', sources: [SRC] },
        ...rest,
    }
}

const growth = (base: number, rates: number[]) => rates.reduce<number[]>((a, r) => [...a, (a.at(-1) ?? base) * (1 + r)], [])

// 1. Full five-year history, steady growth, synthetic model output.
const softwareSales = growth(18_400_000, [0, 0.14, 0.11, 0.19, 0.09]).reverse()
const software = company(101, 'Exempel Mjukvara Norr AB', {
    municipality: KOMMUN.umea,
    sni: [SNI.software],
    registeredAt: '2012-05-14',
    businessDescription: { status: 'reported', value: 'Utveckling och försäljning av programvara för logistikföretag samt därmed förenlig verksamhet.', source: SRC },
    figs: [2025, 2024, 2023, 2022, 2021].map((year, i) => ({
        year,
        sales: softwareSales[i],
        ebit: softwareSales[i] * [0.132, 0.118, 0.097, 0.104, 0.081][i],
        assets: softwareSales[i] * 0.62,
        equity: softwareSales[i] * [0.31, 0.29, 0.27, 0.25, 0.22][i],
        ur: softwareSales[i] * 0.04,
        emp: [21, 19, 18, 15, 14][i],
    })),
    model: {
        modelId: 'synthetic-demo',
        modelVersion: '0',
        generatedAt: '2026-09-01',
        inputsPeriodEnd: '2025-12-31',
        horizonMonths: 12,
        score: 71,
        scale: { min: 0, max: 100, higherIsBetter: true },
        source: { source: 'synthetic', retrievedAt: '2026-09-01' },
    },
})

// 2. Full history, loss in the newest year.
const bygg = company(102, 'Exempel Byggnads i Göteborg AB', {
    municipality: KOMMUN.gbg,
    sni: [SNI.building],
    figs: [2025, 2024, 2023, 2022, 2021].map((year, i) => {
        const s = [41_200_000, 47_900_000, 52_300_000, 44_100_000, 39_800_000][i]
        return { year, sales: s, ebit: s * [-0.034, 0.021, 0.048, 0.052, 0.041][i], fin: -s * 0.012, assets: s * 0.48, equity: s * [0.09, 0.13, 0.13, 0.1, 0.08][i], inv: s * 0.06, emp: [34, 38, 41, 36, 33][i] }
    }),
})

// 3. Three years, healthy small firm.
const el = company(103, 'Exempel Elinstallation Syd AB', {
    municipality: KOMMUN.malmo,
    sni: [SNI.electric],
    figs: [2025, 2024, 2023].map((year, i) => {
        const s = [9_600_000, 8_800_000, 8_100_000][i]
        return { year, sales: s, ebit: s * [0.087, 0.079, 0.066][i], assets: s * 0.45, equity: s * [0.24, 0.2, 0.17][i], ur: s * 0.05, inv: s * 0.03, emp: [8, 8, 7][i] }
    }),
})

// 4. Negative equity.
const resto = company(104, 'Exempel Restaurang Kajen AB', {
    municipality: KOMMUN.sthlm,
    sni: [SNI.restaurant],
    figs: [2025, 2024, 2023].map((year, i) => {
        const s = [6_900_000, 7_400_000, 6_100_000][i]
        return { year, sales: s, ebit: s * [-0.061, -0.012, 0.018][i], assets: s * 0.22, equity: [-412_000, 38_000, 131_000][i], inv: s * 0.02, emp: [11, 13, 10][i] }
    }),
})

// 5. Extended 18-month fiscal year -> growth incomparable.
const akeri = company(105, 'Exempel Åkeri & Logistik AB', {
    municipality: KOMMUN.orebro,
    sni: [SNI.haulage],
    figs: [
        { year: 2025, end: '2025-12-31', months: 18, sales: 31_500_000, ebit: 1_310_000, assets: 14_200_000, equity: 4_100_000, ur: 900_000, emp: 22 },
        { year: 2024, end: '2024-06-30', sales: 19_800_000, ebit: 720_000, assets: 12_900_000, equity: 3_500_000, ur: 800_000, emp: 21 },
        { year: 2023, end: '2023-06-30', sales: 18_300_000, ebit: 540_000, assets: 11_700_000, equity: 3_100_000, ur: 650_000, emp: 20 },
    ],
})

// 6. Holding company: net sales reported as exactly zero.
const holding = company(106, 'Exempel Holding Uppsala AB', {
    municipality: KOMMUN.uppsala,
    sni: [SNI.holding],
    figs: [2025, 2024, 2023].map((year, i) => ({ year, sales: 0, ebit: [-48_000, -51_000, -39_000][i], fin: [1_850_000, 1_200_000, 940_000][i], assets: [22_400_000, 20_600_000, 19_500_000][i], equity: [21_900_000, 20_100_000, 19_000_000][i], ca: [3_100_000, 1_600_000, 900_000][i], cl: [120_000, 95_000, 88_000][i], emp: 0 })),
})

// 7. Stale: newest report for 2022.
const metall = company(107, 'Exempel Metall Linköping AB', {
    municipality: KOMMUN.lkpg,
    sni: [SNI.metal],
    figs: [2022, 2021, 2020].map((year, i) => {
        const s = [12_700_000, 11_900_000, 10_200_000][i]
        return { year, sales: s, ebit: s * [0.058, 0.061, 0.032][i], assets: s * 0.7, equity: s * 0.26, inv: s * 0.18, emp: [14, 14, 13][i] }
    }),
})

// 8. Sparse: abridged K2 report, most items absent -> below index threshold.
const fastighet = company(108, 'Exempel Fastigheter Umeå AB', {
    municipality: KOMMUN.umea,
    sni: [SNI.realestate],
    figs: [{ year: 2025, sales: 2_300_000, ebit: 610_000, assets: 18_700_000, equity: 3_200_000, omit: ['ebit', 'fin', 'pafi', 'staff', 'equity', 'ur', 'inv', 'cash', 'ca', 'cl', 'ltl', 'emp'] }],
})

// 9. Renamed company -> old slug redirects.
const tand = company(109, 'Exempel Tandvård Örebro AB', {
    formerNames: [{ name: 'Exempel Tandläkarna Örebro AB', until: '2025-03-01' }],
    municipality: KOMMUN.orebro,
    sni: [SNI.dental],
    figs: [2025, 2024, 2023, 2022].map((year, i) => {
        const s = [14_100_000, 13_300_000, 12_900_000, 12_200_000][i]
        return { year, sales: s, ebit: s * [0.112, 0.108, 0.101, 0.095][i], assets: s * 0.52, equity: s * [0.33, 0.3, 0.27, 0.25][i], ur: s * 0.03, emp: [12, 12, 11, 11][i] }
    }),
})

// 10. Handelsbolag without employee data.
const parti = company(110, 'Exempel Partihandel Malmö HB', {
    legalForm: 'HB',
    municipality: KOMMUN.malmo,
    sni: [SNI.wholesale],
    figs: [2025, 2024].map((year, i) => {
        const s = [5_400_000, 5_900_000][i]
        return { year, sales: s, ebit: s * [0.041, 0.052][i], assets: s * 0.4, equity: s * 0.12, inv: s * 0.16, omit: ['emp', 'staff'] }
    }),
})

// 11. In liquidation.
const konsult = company(111, 'Exempel Konsult Västerås AB', {
    status: { code: 'liquidation', since: '2026-05-12', source: SRC },
    municipality: KOMMUN.vasteras,
    sni: [SNI.engineering],
    figs: [2025, 2024].map((year, i) => {
        const s = [3_100_000, 4_700_000][i]
        return { year, sales: s, ebit: s * [-0.12, 0.03][i], assets: s * 0.35, equity: s * [0.05, 0.14][i], emp: [3, 5][i] }
    }),
})

// 12. Newly registered, no annual report yet.
const ny = company(112, 'Exempel Nystart Stockholm AB', {
    registeredAt: '2025-11-03',
    municipality: KOMMUN.sthlm,
    sni: [SNI.software],
})

// 13. Consolidated group accounts (K3).
const koncern = company(113, 'Exempel Koncern Göteborg AB', {
    municipality: KOMMUN.gbg,
    sni: [SNI.holding, SNI.building],
    figs: [2025, 2024, 2023].map((year, i) => {
        const s = [212_000_000, 198_000_000, 187_000_000][i]
        return { year, sales: s, ebit: s * [0.064, 0.059, 0.071][i], assets: s * 0.81, equity: s * [0.34, 0.33, 0.31][i], ur: 0, inv: s * 0.09, emp: [164, 158, 151][i], consolidated: true, framework: 'K3' as const }
    }),
})

// 14. Enskild näringsidkare: page is not generated while sole-trader publishing is off.
const ef = company(114, 'Exempel Frisör Uppsala', {
    legalForm: 'EF',
    municipality: KOMMUN.uppsala,
    sni: [SNI.hair],
})

// 15-18: more companies in the same industries and places, for hubs and rankings.
const extra = [
    company(115, 'Exempel Kod & Data Stockholm AB', { municipality: KOMMUN.sthlm, sni: [SNI.software], figs: [2025, 2024].map((year, i) => ({ year, sales: [27_300_000, 22_100_000][i], ebit: [4_600_000, 2_900_000][i], assets: [16_800_000, 13_400_000][i], equity: [9_100_000, 6_300_000][i], emp: [26, 22][i] })) }),
    company(116, 'Exempel Systemutveckling Uppsala AB', { municipality: KOMMUN.uppsala, sni: [SNI.software], figs: [2025, 2024, 2023].map((year, i) => ({ year, sales: [7_900_000, 8_300_000, 7_100_000][i], ebit: [310_000, 690_000, 450_000][i], assets: [4_300_000, 4_600_000, 3_900_000][i], equity: [1_900_000, 1_800_000, 1_300_000][i], emp: [7, 8, 7][i] })) }),
    company(117, 'Exempel Snickeri & Bygg Umeå AB', { municipality: KOMMUN.umea, sni: [SNI.building], figs: [2025, 2024].map((year, i) => ({ year, sales: [16_200_000, 14_800_000][i], ebit: [1_120_000, 930_000][i], assets: [8_100_000, 7_300_000][i], equity: [2_900_000, 2_300_000][i], inv: [1_200_000, 1_000_000][i], emp: [13, 12][i] })) }),
    company(118, 'Exempel Installationsteknik Göteborg AB', { municipality: KOMMUN.gbg, sni: [SNI.electric], figs: [2025, 2024].map((year, i) => ({ year, sales: [22_600_000, 20_100_000][i], ebit: [1_540_000, 1_690_000][i], assets: [10_900_000, 9_800_000][i], equity: [3_800_000, 3_400_000][i], emp: [19, 18][i] })) }),
]

const batch1 = [software, bygg, el, resto, akeri, holding, metall, fastighet, tand, parti, konsult, ny, koncern, ef, ...extra]

// Batch 2: an incremental update with the kinds of rows the importer must handle.
const byggUpdated = structuredClone(bygg)
byggUpdated.status = { code: 'reconstruction', since: '2026-08-20', source: SRC }
const elRenamed = structuredClone(el)
elRenamed.formerNames = [{ name: el.name, until: '2026-06-01' }]
elRenamed.name = 'Exempel Elteknik Syd AB'
const newCo = company(119, 'Exempel Mekaniska Västerås AB', { municipality: KOMMUN.vasteras, sni: [SNI.metal], figs: [2025, 2024].map((year, i) => ({ year, sales: [18_900_000, 17_600_000][i], ebit: [1_020_000, 880_000][i], assets: [12_100_000, 11_400_000][i], equity: [4_700_000, 4_100_000][i], inv: [2_600_000, 2_400_000][i], emp: [17, 16][i] })) })
const newCoOlder = structuredClone(newCo)
newCoOlder.periods = newCoOlder.periods.slice(1)
const badChecksum = { ...company(120, 'Exempel Felaktigt Orgnr AB', {}), orgnr: '0021234567' }
const zeroForMissing = company(121, 'Exempel Nolla Istället AB', { municipality: KOMMUN.sthlm, sni: [SNI.software], figs: [{ year: 2025, sales: 1_000_000, ebit: 50_000, assets: 600_000, equity: 200_000, emp: 1 }] })
;(zeroForMissing.periods[0].income as unknown as Record<string, unknown>).personnelCosts = 0 // raw 0 instead of a Value -> must be rejected
const hyphenated = { ...structuredClone(software), orgnr: software.orgnr.slice(0, 6) + '-' + software.orgnr.slice(6) }

const batch2 = [byggUpdated, elRenamed, newCoOlder, newCo, badChecksum, zeroForMissing, hyphenated]

const dir = path.join(import.meta.dirname, '..', 'data', 'fixtures')
fs.mkdirSync(dir, { recursive: true })
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
fs.writeFileSync(path.join(dir, 'synthetic-batch-001.jsonl'), jsonl(batch1))
fs.writeFileSync(path.join(dir, 'synthetic-batch-002-update.jsonl'), jsonl(batch2))
console.log(`wrote ${batch1.length} + ${batch2.length} synthetic records to ${dir}`)
