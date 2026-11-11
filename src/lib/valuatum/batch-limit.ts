export const MAX_BATCH_ROWS = 10_000

export function assertBatchSize(rows: number): void {
    if (!Number.isInteger(rows) || rows < 0 || rows > MAX_BATCH_ROWS)
        throw new Error(`Batch has ${rows} rows; maximum is ${MAX_BATCH_ROWS}. Larger builds require a separately verified process.`)
}

export function fetchConcurrency(value = '8'): number {
    const n = Number(value)
    if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error('SE_FETCH_CONCURRENCY must be an integer from 1 to 16')
    return n
}
