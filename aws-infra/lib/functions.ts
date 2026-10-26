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
