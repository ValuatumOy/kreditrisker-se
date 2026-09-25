// Redirect manifest for the edge (e.g. a CloudFront Function or S3 routing
// rules) so name changes return real 301s. The HTML redirect pages are the fallback.
import { getSite } from '../lib/store.ts'
export const GET = () => new Response(JSON.stringify(getSite().redirects.map((r) => ({ ...r, status: 301 })), null, 1), { headers: { 'content-type': 'application/json' } })
