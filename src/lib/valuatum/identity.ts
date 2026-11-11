import type { Bundle } from './api.ts'
import type { Param } from './params.ts'
import { parseOrgnr } from '../orgnr.ts'

/** Reject a response for a different model, company or group before mapping its figures. */
export function assertBundleIdentity(bundle: Bundle, param: Param): void {
    const model = bundle.modeldata
    if (bundle.fid !== param.fid || String(model.followedModelId) !== param.fid) throw new Error(`API model fid mismatch for ${param.fid}`)
    const matching = bundle.companies.filter((c) => String(c.companyId) === String(model.companyId))
    if (matching.length !== 1) throw new Error(`API company register identity mismatch for fid ${param.fid}`)
    const company = matching[0]
    if (!company.models.some((m) => String(m.followedModelId) === param.fid)) throw new Error(`API register model mismatch for fid ${param.fid}`)
    const codes = [model.companyCode.trim(), company.companyCode.trim()]
    if (codes.some((code) => /K$/i.test(code))) throw new Error(`API returned group accounts for base fid ${param.fid}`)
    const parsed = codes.map((code) => parseOrgnr(code))
    if (parsed.some((p) => !p.ok) || !parsed[0].ok || !parsed[1].ok || parsed[0].orgnr !== parsed[1].orgnr || (param.orgnr && parsed[0].orgnr !== param.orgnr)) throw new Error(`API orgnr mismatch between requested/model/register company for fid ${param.fid}`)
}
