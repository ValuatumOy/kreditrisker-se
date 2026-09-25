// @ts-check
import { defineConfig } from 'astro/config'
import fs from 'node:fs'

// Site origin and output dir come from env so the domain stays configurable
// (see src/config/site.ts and docs/DOMAIN.md).
export default defineConfig({
    site: process.env.SE_SITE_ORIGIN ?? 'https://www.kreditrisker.se',
    outDir: process.env.SE_OUT_DIR ?? 'dist',
    output: 'static',
    trailingSlash: 'always',
    build: { format: 'directory', concurrency: 8 },
    prefetch: { prefetchAll: false, defaultStrategy: 'hover' },
    server: { port: 4331 },
    devToolbar: { enabled: false },
    // The dev server may be started from an 8.3 short path on Windows; allow both spellings.
    vite: { server: { fs: { allow: [process.cwd(), fs.realpathSync.native(process.cwd())] } } },
})
