// Deterministic Swedish URL slugs: "Åkeri & Söner AB" -> "akeri-soner-ab".
export function slugify(name: string): string {
    const s = name
        .toLocaleLowerCase('sv-SE')
        .replace(/[åä]/g, 'a')
        .replace(/[öø]/g, 'o')
        .replace(/æ/g, 'ae')
        .replace(/é|è|ê/g, 'e')
        .replace(/ü/g, 'u')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/&/g, ' ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80)
        .replace(/-+$/g, '')
    return s || 'foretag'
}
