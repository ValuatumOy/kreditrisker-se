// CloudFront Function sources (cloudfront-js-2.0). Plain JS strings so the
// tests in ../test can run the exact code that is deployed.

const qs = `
function qs(q) {
    var parts = []
    for (var k in q) {
        var v = q[k]
        if (v.multiValue) for (var i = 0; i < v.multiValue.length; i++) parts.push(k + '=' + v.multiValue[i].value)
        else parts.push(k + '=' + v.value)
    }
    return parts.length ? '?' + parts.join('&') : ''
}
function redirect(location) {
    return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: location }, 'cache-control': { value: 'max-age=3600' } } }
}
`

/** apex -> www; /a/b/ -> /a/b/index.html; /a/b -> /a/b/ (the site uses trailing slashes). */
export function siteRequestCode(domain?: string): string {
    return `${qs}
function handler(event) {
    var r = event.request
    var host = r.headers.host ? r.headers.host.value : ''
    if (${JSON.stringify(domain ?? '')} && host === ${JSON.stringify(domain ?? '')}) return redirect('https://www.' + host + r.uri + qs(r.querystring))
    var last = r.uri.split('/').pop()
    if (r.uri.endsWith('/')) r.uri += 'index.html'
    else if (last.indexOf('.') === -1) return redirect(r.uri + '/' + qs(r.querystring))
    return r
}`
}

/**
 * /api/search?q=... -> CloudSearch /2013-01-01/search with a structured query:
 * digits search the orgnr prefix, words must all prefix-match the name or a
 * former name. Clients cannot send their own CloudSearch parameters.
 */
export function searchRewriteCode(): string {
    return `
function handler(event) {
    var r = event.request
    var raw = r.querystring.q ? decodeURIComponent(r.querystring.q.value.replace(/\\+/g, ' ')) : ''
    var size = r.querystring.size && /^[0-9]{1,2}$/.test(r.querystring.size.value) ? r.querystring.size.value : '8'
    var digits = raw.replace(/[\\s-]/g, '')
    var query
    if (/^[0-9]{2,10}$/.test(digits)) {
        query = "(prefix field=orgnr '" + digits + "')"
    } else {
        var words = raw.toLowerCase().replace(/[^0-9a-zåäöéüæø ]+/g, ' ').split(' ').filter(function (w) { return w.length > 0 && ['ab', 'hb', 'kb', 'publ'].indexOf(w) === -1 }).slice(0, 6)
        if (!words.length || words.join('').length < 2) {
            return { statusCode: 200, statusDescription: 'OK', headers: { 'content-type': { value: 'application/json' } }, body: '{"hits":{"found":0,"hit":[]}}' }
        }
        var on = function (field) { return '(and ' + words.map(function (w) { return "(prefix field=" + field + " '" + w + "')" }).join(' ') + ')' }
        query = '(or ' + on('name') + ' ' + on('former') + ')'
    }
    r.uri = '/2013-01-01/search'
    r.querystring = {
        q: { value: encodeURIComponent(query) },
        'q.parser': { value: 'structured' },
        size: { value: size },
        sort: { value: encodeURIComponent('_score desc,sales desc') },
        'return': { value: 'orgnr,name,former,kommun,sni,path,status,year,fresh' },
    }
    return r
}`
}
