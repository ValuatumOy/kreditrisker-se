'use strict'

// Keep personal identity numbers and synthetic fixtures out of real orders.
function isSwedishCompany(value) {
    if (typeof value !== 'string' || !/^\d{6}-?\d{4}$/.test(value)) return false
    const digits = value.replace('-', '')
    if (digits[0] === '0' || Number(digits[2]) < 2) return false
    let sum = 0
    for (let i = 0; i < digits.length; i++) {
        let digit = Number(digits[digits.length - 1 - i])
        if (i % 2 === 1) {
            digit *= 2
            if (digit > 9) digit -= 9
        }
        sum += digit
    }
    return sum % 10 === 0
}

module.exports = { isSwedishCompany }
