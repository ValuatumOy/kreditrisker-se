// Rows of the Bokslut table, in the order of the Valuatum company view (CV)
// pages. Labels use the Swedish annual-report terms that the Bolagsverket
// linking rules map to each CV variable (see src/lib/valuatum/map.ts). Until
// the Swedish translations are fixed in sweden-db, the labels live here, like
// the Finnish site's src/config/financialStatementRows.ts.
//
// A row is hidden when it has no value in any shown year, unless `always` is
// set. `sum` rows are subtotals and are printed in bold.

import type { BalanceSheet, IncomeStatement } from '../lib/contract/types.ts'

export interface StatementRow<K extends string> {
    key: K
    label: string
    sum?: boolean
    always?: boolean
}

export const INCOME_ROWS: StatementRow<keyof IncomeStatement>[] = [
    { key: 'netSales', label: 'Nettoomsättning', sum: true, always: true },
    { key: 'personnelCosts', label: 'Personalkostnader' },
    { key: 'operatingProfit', label: 'Rörelseresultat', sum: true, always: true },
    { key: 'incomeFromGroupCompanies', label: 'Resultat från andelar i koncernföretag' },
    { key: 'incomeFromAssociates', label: 'Resultat från andelar i intresseföretag' },
    { key: 'incomeFromOtherFinancialAssets', label: 'Resultat från övriga finansiella anläggningstillgångar' },
    { key: 'interestIncome', label: 'Ränteintäkter och liknande resultatposter' },
    { key: 'otherFinancialIncome', label: 'Övriga finansiella intäkter' },
    { key: 'financialAssetWriteDowns', label: 'Nedskrivningar av finansiella tillgångar' },
    { key: 'interestExpenses', label: 'Räntekostnader och liknande resultatposter' },
    { key: 'otherFinancialExpenses', label: 'Övriga finansiella kostnader' },
    { key: 'profitAfterFinancialItems', label: 'Resultat efter finansiella poster', sum: true, always: true },
    { key: 'changeInAcceleratedDepreciation', label: 'Förändring av överavskrivningar' },
    { key: 'changeInUntaxedReserves', label: 'Förändring av periodiseringsfonder m.m.' },
    { key: 'groupContributions', label: 'Koncernbidrag' },
    { key: 'incomeTaxes', label: 'Skatt' },
    { key: 'minorityShareOfProfit', label: 'Minoritetens andel av årets resultat' },
    { key: 'netProfit', label: 'Årets resultat', sum: true, always: true },
]

export const BALANCE_ROWS: StatementRow<keyof BalanceSheet>[] = [
    { key: 'intangibleAssets', label: 'Immateriella anläggningstillgångar' },
    { key: 'tangibleAssets', label: 'Materiella anläggningstillgångar' },
    { key: 'financialAssets', label: 'Finansiella anläggningstillgångar' },
    { key: 'deferredTaxAssets', label: 'Uppskjuten skattefordran' },
    // Absent inventories and untaxed reserves are 0, so these two rows always show.
    { key: 'inventories', label: 'Varulager m.m.', always: true },
    { key: 'shortTermReceivables', label: 'Kortfristiga fordringar' },
    { key: 'shortTermInvestments', label: 'Kortfristiga placeringar' },
    { key: 'cash', label: 'Kassa och bank' },
    { key: 'totalAssets', label: 'Summa tillgångar', sum: true, always: true },
    { key: 'equity', label: 'Eget kapital', always: true },
    { key: 'minorityInterest', label: 'Minoritetsintresse' },
    { key: 'untaxedReserves', label: 'Obeskattade reserver', always: true },
    { key: 'provisions', label: 'Avsättningar' },
    { key: 'longTermLiabilities', label: 'Långfristiga skulder', always: true },
    { key: 'currentLiabilities', label: 'Kortfristiga skulder', always: true },
    { key: 'totalEquityAndLiabilities', label: 'Summa eget kapital och skulder', sum: true, always: true },
]
