// Local internal verifier. No route or source document is included in the public site build.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { INCOME_VARS, BALANCE_VARS } from '../src/lib/valuatum/map.ts'
import { INCOME_ROWS, BALANCE_ROWS } from '../src/config/statement.ts'
import { fetchBundle } from '../src/lib/valuatum/api.ts'

const args = process.argv.slice(2)
const options: Record<string, string> = {}
for (let i = 0; i < args.length; i += 2) {
    if (!['--bundle', '--filing', '--port', '--site-origin', '--system-url', '--source-url', '--fid'].includes(args[i]) || !args[i + 1])
        throw new Error('Options: --bundle file.json --filing company.zip --port 4332 --site-origin URL --system-url URL --source-url URL --fid number')
    options[args[i].slice(2)] = args[i + 1]
}
const dir = path.resolve('data/statement-audit')
fs.mkdirSync(dir, { recursive: true })
if (options.fid) {
    if (!/^\d+$/.test(options.fid)) throw new Error('--fid must be a followed-model id')
    const bundle = await fetchBundle(options.fid)
    if (!bundle) throw new Error('No financial statements for this model')
    options.bundle = path.join(dir, 'backend.json')
    fs.writeFileSync(options.bundle, JSON.stringify(bundle))
}
const definitions = [
    ['netSales', 'Nettoomsattning', 'duration'],
    ['grossProfit', 'Bruttoresultat', 'duration'],
    ['operatingProfit', 'Rorelseresultat', 'duration'],
    ['profitAfterFinancialItems', 'ResultatEfterFinansiellaPoster', 'duration'],
    ['netProfit', 'AretsResultat', 'duration'],
    ['inventories', 'VarulagerMm', 'instant'],
    ['totalAssets', 'Tillgangar', 'instant'],
    ['equity', 'EgetKapital', 'instant'],
    ['untaxedReserves', 'ObeskattadeReserver', 'instant'],
    ['longTermLiabilities', 'LangfristigaSkulder', 'instant'],
    ['currentLiabilities', 'KortfristigaSkulder', 'instant'],
    ['totalEquityAndLiabilities', 'EgetKapitalSkulder', 'instant'],
    ['cash', 'KassaBankExklRedovisningsmedel', 'instant'],
] as const
const vars: Record<string, string> = { ...INCOME_VARS, ...BALANCE_VARS }
const labels = new Map([...INCOME_ROWS, ...BALANCE_ROWS].map((r) => [r.key, r.label]))
const metrics = [
    ...definitions.map(([key, concept, kind]) => ({ key, label: labels.get(key), variable: vars[key], concepts: [concept], kind, unit: 'SEK', websiteGroup: kind === 'duration' ? 'Resultaträkning' : 'Balansräkning', zeroWhenAbsent: true })),
    { key: 'employees', label: 'Medelantal anställda', variable: 'cr_employees_adjusted', concepts: ['MedelantaletAnstallda'], kind: 'duration', unit: 'people', websiteGroup: 'Nyckeltal', zeroWhenAbsent: false },
]
const config = path.join(dir, 'config.json')
fs.writeFileSync(config, JSON.stringify({ metrics, namespacePrefix: 'http://www.taxonomier.se/se/fr/gen-base/' }))
const serverArgs = [path.resolve('scripts/statement-audit/server.py'), '--config', config,
    '--bundle', path.resolve(options.bundle ?? 'data/sample/api-cache/52.json'),
    '--port', options.port ?? '4332', '--site-origin', options['site-origin'] ?? 'https://d3po43lod2ykoc.cloudfront.net', '--output', dir]
for (const key of ['filing', 'system-url', 'source-url']) if (options[key]) serverArgs.push(`--${key}`, key === 'filing' ? path.resolve(options[key]) : options[key])
const child = spawn(process.env.SE_AUDIT_PYTHON ?? 'python', serverArgs, { stdio: 'inherit' })
child.on('error', () => { console.error('Python 3 is required. Set SE_AUDIT_PYTHON to its path if python is not on PATH.'); process.exitCode = 1 })
child.on('exit', (code) => { process.exitCode = code ?? 0 })
process.on('SIGINT', () => child.kill('SIGINT'))
