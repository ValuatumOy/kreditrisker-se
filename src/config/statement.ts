// Rows of the Bokslut table, in the order of the Valuatum company view (CV)
// pages. Labels use the Swedish annual-report terms that the Bolagsverket
// linking rules map to each CV variable (see src/lib/valuatum/map.ts). Until
// the Swedish translations are fixed in sweden-db, the labels live here, like
// the Finnish site's src/config/financialStatementRows.ts.
//
// A row is hidden when it is 0 or missing in every shown year, unless `always`
// is set. `sum` rows are subtotals, printed in bold; the rows without a flag
// are their items, printed indented.
// - Income statement: each subtotal is the previous subtotal plus the items
//   between them; net sales starts the chain. An `ifItAddsUp` subtotal is shown
//   only when it does so in every shown year (see addsUp).
// - Balance sheet: each subtotal is the sum of the items right above it, and a
//   `total` is the sum of the subtotals and `standalone` rows since the last total.

import type { BalanceSheet, FiscalPeriod, IncomeStatement } from '../lib/contract/types.ts'
import { numeric } from '../lib/metrics.ts'

export interface StatementRow<K extends string> {
    key: K
    label: string
    sum?: boolean
    total?: boolean
    standalone?: boolean
    always?: boolean
    ifItAddsUp?: boolean
}

/** The part of a subtotal that the annual report does not break down. */
const UNSPECIFIED = 'Övrigt, ej specificerat'

export const INCOME_ROWS: StatementRow<keyof IncomeStatement>[] = [
    { key: 'netSales', label: 'Nettoomsättning', sum: true, always: true },
    { key: 'changeInInventories', label: 'Förändring av lager av produkter i arbete och färdiga varor' },
    { key: 'ownWorkCapitalised', label: 'Aktiverat arbete för egen räkning' },
    { key: 'otherOperatingIncome', label: 'Övriga rörelseintäkter' },
    { key: 'rawMaterialsAndGoods', label: 'Råvaror, förnödenheter och handelsvaror' },
    { key: 'costOfGoodsSold', label: 'Kostnad för sålda varor' },
    // Bolagsverket's Bruttoresultat. It leaves out the other operating income in function-format
    // reports, and some filings give it without the costs behind it.
    { key: 'grossProfit', label: 'Bruttoresultat', sum: true, ifItAddsUp: true },
    { key: 'sellingExpenses', label: 'Försäljningskostnader' },
    { key: 'administrativeExpenses', label: 'Administrationskostnader' },
    { key: 'wagesAndSalaries', label: 'Löner och andra ersättningar' },
    { key: 'socialSecurityCosts', label: 'Sociala kostnader inkl. pensionskostnader' },
    { key: 'otherOperatingExpenses', label: 'Övriga externa kostnader och rörelsekostnader' },
    { key: 'shareOfAssociatesResult', label: 'Andelar i intresseföretags resultat' },
    { key: 'ebitda', label: 'Rörelseresultat före avskrivningar (EBITDA)', sum: true },
    { key: 'depreciation', label: 'Av- och nedskrivningar av anläggningstillgångar' },
    { key: 'operatingProfit', label: 'Rörelseresultat', sum: true, always: true },
    { key: 'interestIncome', label: 'Ränteintäkter och liknande resultatposter' },
    { key: 'otherFinancialIncome', label: 'Övriga finansiella intäkter' },
    { key: 'interestExpenses', label: 'Räntekostnader och liknande resultatposter' },
    { key: 'otherFinancialExpenses', label: 'Övriga finansiella kostnader' },
    { key: 'incomeFromOtherFinancialAssets', label: 'Resultat från övriga finansiella anläggningstillgångar' },
    { key: 'incomeFromGroupCompanies', label: 'Resultat från andelar i koncernföretag' },
    { key: 'incomeFromAssociates', label: 'Resultat från andelar i intresseföretag' },
    { key: 'financialAssetWriteDowns', label: 'Nedskrivningar av finansiella tillgångar' },
    { key: 'profitAfterFinancialItems', label: 'Resultat efter finansiella poster', sum: true, always: true },
    { key: 'changeInAcceleratedDepreciation', label: 'Förändring av överavskrivningar' },
    { key: 'changeInUntaxedReserves', label: 'Förändring av periodiseringsfonder m.m.' },
    { key: 'groupContributions', label: 'Koncernbidrag' },
    { key: 'incomeTaxes', label: 'Skatt' },
    { key: 'minorityShareOfProfit', label: 'Minoritetens andel av årets resultat' },
    { key: 'netProfit', label: 'Årets resultat', sum: true, always: true },
]

export const BALANCE_ROWS: StatementRow<keyof BalanceSheet>[] = [
    { key: 'developmentExpenditure', label: 'Balanserade utgifter för utvecklingsarbeten' },
    { key: 'intangibleRights', label: 'Koncessioner, patent, licenser, varumärken m.m.' },
    { key: 'goodwill', label: 'Goodwill' },
    { key: 'otherIntangibleAssets', label: 'Övriga immateriella anläggningstillgångar' },
    { key: 'intangibleAdvancePayments', label: 'Pågående utvecklingsarbeten och förskott' },
    { key: 'intangibleAssetsUnspecified', label: UNSPECIFIED },
    { key: 'intangibleAssets', label: 'Summa immateriella anläggningstillgångar', sum: true },
    { key: 'buildingsAndLand', label: 'Byggnader och mark' },
    { key: 'machineryAndEquipment', label: 'Maskiner och inventarier' },
    { key: 'constructionInProgress', label: 'Pågående nyanläggningar och förskott' },
    { key: 'otherTangibleAssets', label: 'Övriga materiella anläggningstillgångar' },
    { key: 'tangibleAssetsUnspecified', label: UNSPECIFIED },
    { key: 'tangibleAssets', label: 'Summa materiella anläggningstillgångar', sum: true },
    { key: 'sharesInGroupCompanies', label: 'Andelar i koncernföretag' },
    { key: 'sharesInAssociates', label: 'Andelar i intresseföretag' },
    { key: 'otherShareholdings', label: 'Ägarintressen i övriga företag' },
    { key: 'receivablesFromGroupCompaniesLongTerm', label: 'Fordringar hos koncernföretag' },
    { key: 'receivablesFromAssociatesLongTerm', label: 'Fordringar hos intresseföretag' },
    { key: 'otherLongTermSecurities', label: 'Andra långfristiga värdepappersinnehav' },
    { key: 'otherLongTermReceivables', label: 'Andra långfristiga fordringar' },
    { key: 'financialAssetsUnspecified', label: UNSPECIFIED },
    { key: 'financialAssets', label: 'Summa finansiella anläggningstillgångar', sum: true },
    { key: 'deferredTaxAssets', label: 'Uppskjuten skattefordran', standalone: true },
    { key: 'longTermReceivablesUnspecified', label: 'Övriga långfristiga fordringar, ej specificerat', standalone: true },
    { key: 'rawMaterials', label: 'Råvaror och förnödenheter' },
    { key: 'workInProgress', label: 'Varor under tillverkning' },
    { key: 'otherInventories', label: 'Övriga lagertillgångar' },
    { key: 'finishedGoods', label: 'Färdiga varor och handelsvaror' },
    { key: 'advancesToSuppliers', label: 'Förskott till leverantörer' },
    { key: 'inventoriesUnspecified', label: UNSPECIFIED },
    { key: 'inventories', label: 'Summa varulager m.m.', sum: true, always: true },
    { key: 'tradeReceivables', label: 'Kundfordringar' },
    { key: 'receivablesFromGroupCompanies', label: 'Fordringar hos koncernföretag' },
    { key: 'receivablesFromAssociates', label: 'Fordringar hos intresseföretag' },
    { key: 'unpaidShareCapital', label: 'Tecknat men ej inbetalt kapital' },
    { key: 'prepaidExpenses', label: 'Förutbetalda kostnader och upplupna intäkter' },
    { key: 'otherReceivables', label: 'Övriga fordringar' },
    { key: 'shortTermReceivablesUnspecified', label: UNSPECIFIED },
    { key: 'shortTermReceivables', label: 'Summa kortfristiga fordringar', sum: true },
    { key: 'otherShortTermInvestments', label: 'Övriga kortfristiga placeringar' },
    { key: 'shortTermSharesInGroupCompanies', label: 'Andelar i koncernföretag' },
    { key: 'shortTermInvestmentsUnspecified', label: UNSPECIFIED },
    { key: 'shortTermInvestments', label: 'Summa kortfristiga placeringar', sum: true },
    { key: 'cash', label: 'Kassa och bank', standalone: true },
    { key: 'totalAssets', label: 'Summa tillgångar', sum: true, total: true, always: true },
    { key: 'shareCapital', label: 'Aktiekapital' },
    { key: 'sharePremiumReserve', label: 'Överkursfond' },
    { key: 'revaluationReserve', label: 'Uppskrivningsfond' },
    { key: 'fairValueReserve', label: 'Fond för verkligt värde' },
    { key: 'statutoryReserve', label: 'Reservfond' },
    { key: 'otherReserves', label: 'Övriga fonder' },
    { key: 'unregisteredShareCapital', label: 'Ej registrerat aktiekapital' },
    { key: 'otherEquity', label: 'Övrigt eget kapital' },
    { key: 'retainedEarnings', label: 'Balanserat resultat' },
    { key: 'profitForTheYear', label: 'Årets resultat' },
    { key: 'equity', label: 'Summa eget kapital', sum: true, always: true },
    { key: 'minorityInterest', label: 'Minoritetsintresse', standalone: true },
    { key: 'accumulatedAcceleratedDepreciation', label: 'Ackumulerade överavskrivningar' },
    { key: 'taxAllocationReserves', label: 'Periodiseringsfonder m.m.' },
    { key: 'untaxedReservesUnspecified', label: UNSPECIFIED },
    { key: 'untaxedReserves', label: 'Summa obeskattade reserver', sum: true, always: true },
    { key: 'provisions', label: 'Avsättningar', standalone: true },
    { key: 'bondLoans', label: 'Obligationslån' },
    { key: 'liabilitiesToCreditInstitutions', label: 'Skulder till kreditinstitut' },
    { key: 'liabilitiesToGroupCompaniesLongTerm', label: 'Skulder till koncernföretag' },
    { key: 'liabilitiesToAssociatesLongTerm', label: 'Skulder till intresseföretag' },
    { key: 'otherLongTermLiabilities', label: 'Övriga långfristiga skulder' },
    { key: 'longTermLiabilitiesUnspecified', label: UNSPECIFIED },
    { key: 'longTermLiabilities', label: 'Summa långfristiga skulder', sum: true, always: true },
    { key: 'shortTermBondLoans', label: 'Obligationslån' },
    { key: 'shortTermLiabilitiesToCreditInstitutions', label: 'Skulder till kreditinstitut' },
    { key: 'advancesFromCustomers', label: 'Förskott från kunder' },
    { key: 'tradePayables', label: 'Leverantörsskulder' },
    { key: 'billsOfExchange', label: 'Växelskulder' },
    { key: 'liabilitiesToAssociates', label: 'Skulder till intresseföretag' },
    { key: 'liabilitiesToGroupCompanies', label: 'Skulder till koncernföretag' },
    { key: 'otherCurrentLiabilities', label: 'Övriga kortfristiga skulder' },
    { key: 'accruedExpenses', label: 'Upplupna kostnader och förutbetalda intäkter' },
    { key: 'currentLiabilitiesUnspecified', label: UNSPECIFIED },
    { key: 'currentLiabilities', label: 'Summa kortfristiga skulder', sum: true, always: true },
    { key: 'totalEquityAndLiabilities', label: 'Summa eget kapital och skulder', sum: true, total: true, always: true },
]

/** Whether an income-statement subtotal equals the previous subtotal plus the items between, to the krona tolerance of rounding. */
export function addsUp(p: FiscalPeriod, key: keyof IncomeStatement): boolean {
    const v = (k: keyof IncomeStatement) => numeric(p.income[k]) ?? 0
    let chain = 0
    for (const r of INCOME_ROWS) {
        if (r.key === key) return Math.abs(chain - v(key)) <= 1500
        if (r.key === 'netSales') chain = v(r.key)
        else if (r.sum && !r.ifItAddsUp) chain = v(r.key)
        else if (!r.sum) chain += v(r.key)
    }
    return false
}
