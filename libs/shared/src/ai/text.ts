/** Minúsculas, sin tildes (la ñ queda como n) y con los espacios colapsados. Para comparar texto. */
export function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
