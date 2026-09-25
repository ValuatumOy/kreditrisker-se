// Swedish organisationsnummer: 10 digits, NNNNNN-NNNC, Luhn check digit.
// First digit is the group (5 = aktiebolag, 9 = handels-/kommanditbolag,
// 7 = ekonomisk förening, 8 = ideell förening/stiftelse, 2 = stat/region/kommun,
// 1 = dödsbo, 6 = enkla bolag, 3 = utländska företag). Third digit is >= 2 for
// legal persons so an orgnr can never be a valid personnummer date.
// Enskild firma uses the owner's personnummer: that is personal data.
//
// Group 0 does not exist in the register. Synthetic fixtures use it so a fixture
// can never collide with a real company.

export type Orgnr = string & { readonly __brand: 'Orgnr' }

export const SYNTHETIC_GROUP = '0'

export function luhnValid(digits: string): boolean {
    let sum = 0
    for (let i = 0; i < digits.length; i++) {
        let d = Number(digits[digits.length - 1 - i])
        if (i % 2 === 1) {
            d *= 2
            if (d > 9) d -= 9
        }
        sum += d
    }
    return sum % 10 === 0
}

export function luhnCheckDigit(nineDigits: string): string {
    for (let c = 0; c <= 9; c++) {
        if (luhnValid(nineDigits + c)) return String(c)
    }
    throw new Error('unreachable')
}

export type OrgnrParse =
    | { ok: true; orgnr: Orgnr; kind: 'legal_person' | 'personnummer' | 'synthetic' }
    | { ok: false; error: 'format' | 'checksum' | 'group' }

/** Accepts 556677-8899, 5566778899, 16556677-8899 (century prefix 16). */
export function parseOrgnr(input: string): OrgnrParse {
    let digits = input.replace(/[\s-]/g, '')
    if (/^16\d{10}$/.test(digits)) digits = digits.slice(2)
    if (!/^\d{10}$/.test(digits)) return { ok: false, error: 'format' }
    if (!luhnValid(digits)) return { ok: false, error: 'checksum' }
    const orgnr = digits as Orgnr
    if (digits[0] === SYNTHETIC_GROUP) return { ok: true, orgnr, kind: 'synthetic' }
    if (Number(digits[2]) >= 2) return { ok: true, orgnr, kind: 'legal_person' }
    // Month digits 0-1 at position 3: looks like a personnummer (enskild firma).
    return { ok: true, orgnr, kind: 'personnummer' }
}

export function formatOrgnr(orgnr: string): string {
    return `${orgnr.slice(0, 6)}-${orgnr.slice(6)}`
}

/** Looks like an orgnr the user is typing (for search routing). */
export function looksLikeOrgnr(q: string): boolean {
    return /^\s*\d{6}-?\d{4}\s*$/.test(q)
}
