import type { ReportProduct, ReportState, UnavailableReason } from './types.ts'

export const PRODUCT_NAME: Record<ReportProduct, string> = { basic: 'Basrapport', ai: 'AI-rapport' }

export const STATE_LABEL: Record<ReportState['kind'], string> = {
    unavailable: 'Inte lanserad',
    sample: 'Exempel finns',
    available: 'Kan beställas',
    processing: 'Skapas',
    success: 'Klar',
    failure: 'Misslyckades',
}

export const UNAVAILABLE_TEXT: Record<UnavailableReason, string> = {
    not_launched: 'Rapporten för svenska företag är under utveckling och kan inte beställas ännu.',
    company_not_supported: 'Rapporten kan inte tas fram för den här företagsformen.',
    insufficient_data: 'Det finns inget bokslut att bygga rapporten på.',
    backend_unreachable: 'Beställningstjänsten svarar inte just nu. Försök igen om en stund.',
}
