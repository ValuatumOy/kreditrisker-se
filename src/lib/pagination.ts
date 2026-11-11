export const HUB_PAGE_SIZE = 200
export const BANKRUPTCY_PAGE_SIZE = 100

export const pagePath = (base: string, page: number) => page === 1 ? base : `${base}${page}/`

export function pageNumbers(count: number, size: number): number[] {
    return Array.from({ length: Math.max(1, Math.ceil(count / size)) }, (_, i) => i + 1)
}

export function pageRows<T>(rows: T[], page: number, size: number): T[] {
    return rows.slice((page - 1) * size, page * size)
}
