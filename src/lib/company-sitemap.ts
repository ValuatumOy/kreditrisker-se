import type { IndexRow } from './publish.ts'

export function distinctCompanyRows(rows: Pick<IndexRow, 'o' | 'p'>[]): void {
    const ids = new Set<string>()
    const paths = new Set<string>()
    for (const row of rows) {
        if (ids.has(row.o) || paths.has(row.p)) throw new Error(`Duplicate company index row: ${row.o} ${row.p}`)
        if (!/^\/foretag\/\d{10}\/[^/?#]+\/$/.test(row.p) || row.p.split('/')[2] !== row.o || /[\\<>]|(?:^|\/)\.{1,2}(?:\/|$)/.test(row.p))
            throw new Error(`Invalid canonical company path: ${row.p}`)
        ids.add(row.o)
        paths.add(row.p)
    }
}

// The build emits quoted attributes. Ignore comments and raw-text elements so
// strings in scripts cannot stand in for the actual head metadata.
export function verifyCompanyHtml(html: string, canonical: string, indexable: boolean): void {
    const head = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(html.replace(/<!--[\s\S]*?-->/g, ''))?.[1]
        ?.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    if (!head) throw new Error(`Missing HTML head: ${canonical}`)
    const canonicals: string[] = []
    const robots: string[] = []
    for (const tag of head.matchAll(/<(meta|link)\b[^>]*>/gi)) {
        const attrs = new Map([...tag[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1].toLowerCase(), m[2] ?? m[3]]))
        if (tag[1].toLowerCase() === 'link' && attrs.get('rel')?.toLowerCase().split(/\s+/).includes('canonical')) canonicals.push(attrs.get('href') ?? '')
        if (attrs.get('name')?.toLowerCase() === 'robots') robots.push(attrs.get('content')?.toLowerCase().replace(/\s/g, '') ?? '')
        if (attrs.get('http-equiv')?.toLowerCase() === 'refresh') throw new Error(`Redirect HTML: ${canonical}`)
    }
    if (canonicals.length !== 1 || canonicals[0] !== canonical) throw new Error(`Noncanonical HTML: ${canonical}`)
    if (robots.length !== 1 || robots[0] !== (indexable ? 'index,follow' : 'noindex,follow')) throw new Error(`Unexpected robots HTML: ${canonical}`)
}
