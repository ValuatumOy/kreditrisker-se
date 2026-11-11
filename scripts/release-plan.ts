import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { prepareRelease, verifyRelease } from './lib/release-plan.ts'
import { readPlan } from './lib/candidate.ts'

// Local files only: no AWS SDK, network clients, shell release commands or deploy mode.
const [command, ...args] = process.argv.slice(2)
if (command === 'verify') {
    if (args.length !== 2 || args[0] !== '--release') throw new Error('Use verify --release offline-release-directory')
    console.log(JSON.stringify(verifyRelease(path.resolve(args[1])), null, 2))
    process.exit(0)
}
if (command !== 'prepare' || args.length !== 8) throw new Error('Use prepare --plan candidate-directory --stage staged-overlay --capture offline-capture-directory --out new-directory. See docs/PILOT-PROMOTION.md.')
const options = new Map<string, string>()
for (let i = 0; i < args.length; i += 2) {
    if (!['--plan', '--stage', '--capture', '--out'].includes(args[i]) || !args[i + 1] || options.has(args[i])) throw new Error('Unknown, duplicate or missing option')
    options.set(args[i], path.resolve(args[i + 1]))
}
const repo = path.resolve(import.meta.dirname, '..')
if (execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim()) throw new Error('Use a clean dedicated checkout for release preparation')
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() !== readPlan(options.get('--plan')!).plan.revision) throw new Error('Git revision differs from the frozen candidate')
for (const value of options.values()) {
    const resolved = fs.existsSync(value) ? fs.realpathSync(value) : path.join(fs.realpathSync(path.dirname(value)), path.basename(value))
    const relative = path.relative(fs.realpathSync(repo), resolved)
    if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) throw new Error('Release inputs and output must be outside the repository')
}
console.log(JSON.stringify(prepareRelease(options.get('--plan')!, options.get('--stage')!, options.get('--capture')!, options.get('--out')!), null, 2))
