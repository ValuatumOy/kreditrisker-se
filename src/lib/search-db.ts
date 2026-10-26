// Company search over a read-only SQLite file, built by the site build and
// queried by the search Lambda. Same matching and ranking as searchIndex():
// orgnr prefix; else every word prefix-matches a word of the name, then the
// words appear anywhere in the name (trigram index, 3+ characters), then the
// same against former names. Ties: name starting with the query, net sales.

import { DatabaseSync } from 'node:sqlite'
import { LEGAL_SUFFIX, norm, type SearchHit } from './search.ts'

export interface SearchRow {
    hit: SearchHit
    /** net sales, for ranking ties only */
    sales?: number
}

const words = (s: string) => norm(s).replace(LEGAL_SUFFIX, ' ').split(' ').filter(Boolean)

const SCHEMA = `
create table c (id integer primary key, o text not null, n text not null, f text, slug text not null, k integer, s integer,
    st text, y text, fr text, nn text not null, sales integer not null);
create index c_o on c (o);
create table lbl (id integer primary key, v text not null unique);
create table w (w text not null, fld integer not null, id integer not null, primary key (w, fld, id)) without rowid;
create virtual table t using fts5 (n, f, content='', tokenize='trigram');
`

/** Writes rows into a new database file (which must not exist). */
export function buildSearchDb(file: string, rows: Iterable<SearchRow>): number {
    const db = new DatabaseSync(file)
    db.exec('pragma journal_mode = off; pragma synchronous = off; pragma page_size = 4096;')
    db.exec(SCHEMA)
    const c = db.prepare('insert into c values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const labels = new Map<string, number>()
    const lbl = db.prepare('insert into lbl (id, v) values (?, ?)')
    const label = (v?: string) => {
        if (!v) return null
        let i = labels.get(v)
        if (!i) lbl.run((i = labels.size + 1), v), labels.set(v, i)
        return i
    }
    const w = db.prepare('insert or ignore into w (w, fld, id) values (?, ?, ?)')
    const t = db.prepare('insert into t (rowid, n, f) values (?, ?, ?)')
    let id = 0
    db.exec('begin')
    for (const { hit, sales } of rows) {
        id++
        const n = words(hit.n)
        const f = hit.f ? words(hit.f) : []
        const slug = hit.p.split('/')[3]
        if (hit.p !== `/foretag/${hit.o}/${slug}/`) throw new Error(`unexpected path ${hit.p}`)
        c.run(id, hit.o, hit.n, hit.f ?? null, slug, label(hit.k), label(hit.s), hit.st ?? null, hit.y ?? null, hit.fr ?? null, n.join(' '), Math.round(sales ?? 0))
        for (const x of new Set(n)) w.run(x, 0, id)
        for (const x of new Set(f)) w.run(x, 1, id)
        t.run(id, n.join(' '), f.join(' '))
    }
    db.exec("commit; insert into t (t) values ('optimize'); analyze; vacuum;")
    db.close()
    return id
}

export function openSearchDb(file: string): DatabaseSync {
    const db = new DatabaseSync(file, { readOnly: true })
    db.exec('pragma query_only = 1; pragma mmap_size = 1073741824;')
    return db
}

/** Upper bound for a prefix range: every string starting with s sorts below it. */
const after = (s: string) => s + '￿'

export function searchDb(db: DatabaseSync, query: string, limit = 8): SearchHit[] {
    limit = Math.max(1, Math.min(limit, 99))
    const digits = query.replace(/[\s-]/g, '')
    if (/^\d{2,10}$/.test(digits)) {
        return db.prepare(`select ${HIT} from c where o >= ? and o < ? order by o limit ?`).all(digits, after(digits), limit).map(toHit)
    }
    const tokens = [...new Set(words(query))].slice(0, 6)
    if (!tokens.length || tokens.join('').length < 2) return []
    const q = tokens.join(' ')

    const out: SearchHit[] = []
    const seen: number[] = []
    const run = (cand: string, args: (string | number)[]) => {
        if (out.length >= limit) return
        const sql = `with cand(id) as (${cand}) select c.id, ${HIT} from c join cand using (id)
            where c.id not in (${seen.map(() => '?').join(',')})
            order by (c.nn >= ? and c.nn < ?) desc, c.sales desc, c.nn limit ?`
        for (const r of db.prepare(sql).all(...args, ...seen, q, after(q), limit - out.length) as { id: number }[]) {
            seen.push(r.id)
            out.push(toHit(r))
        }
    }
    // every token prefix-matches a word of the field
    const prefix = (fld: number) => {
        const sql = tokens.map(() => 'select id from w where w >= ? and w < ? and fld = ' + fld).join(' intersect ')
        return [sql, tokens.flatMap((x) => [x, after(x)])] as const
    }
    // every token of 3+ characters appears anywhere in the field; shorter ones prefix-match a word
    const anywhere = (fld: number) => {
        const long = tokens.filter((x) => x.length >= 3)
        if (!long.length) return null
        const col = fld ? 'f' : 'n'
        const parts = ['select rowid from t where t match ?']
        const args: string[] = [long.map((x) => `{${col}} : "${x}"`).join(' AND ')]
        for (const x of tokens.filter((x) => x.length < 3)) {
            parts.push(`select id from w where w >= ? and w < ? and fld = ${fld}`)
            args.push(x, after(x))
        }
        return [parts.join(' intersect '), args] as const
    }
    for (const fld of [0, 1]) {
        run(...prefix(fld))
        const a = anywhere(fld)
        if (a) run(...a)
    }
    return out
}

const HIT = `c.o, c.n, c.f, c.slug, (select v from lbl where id = c.k) k, (select v from lbl where id = c.s) s, c.st, c.y, c.fr`

function toHit(r: unknown): SearchHit {
    const { o, n, slug, ...opt } = r as Record<string, string | null>
    const h: SearchHit = { o: o!, n: n!, p: `/foretag/${o}/${slug}/` }
    for (const k of ['f', 'k', 's', 'st', 'y', 'fr'] as const) if (opt[k]) h[k] = opt[k]!
    return h
}
