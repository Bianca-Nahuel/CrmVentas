// Números del catálogo (precios, m² por caja) como texto decimal canónico ("37290", "2.02"), igual que
// numeric en la base. Las cuentas se hacen con enteros escalados: nunca float con plata.
const SCALE = 4;
const FACTOR = 10n ** BigInt(SCALE);
const CANONICAL = /^(\d{1,12})(?:\.(\d{1,4}))?$/;

/** "2.02" → 20200n (escala 4). Solo texto canónico; cualquier otra cosa es un error de programación. */
export function toScaled(value: string): bigint {
  const match = CANONICAL.exec(value);
  if (!match) throw new Error('Decimal inválido');
  return BigInt(match[1]!) * FACTOR + BigInt((match[2] ?? '').padEnd(SCALE, '0'));
}

export function fromScaled(units: bigint): string {
  const whole = units / FACTOR;
  const decimals = (units % FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return decimals ? `${whole}.${decimals}` : `${whole}`;
}

/** Normaliza lo que devuelve Postgres para numeric ("37290.00" → "37290"). */
export function canonical(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'number' ? numberToText(value) : value.trim();
  if (text === null || !CANONICAL.test(text)) return null;
  return fromScaled(toScaled(text));
}

function numberToText(value: number): string | null {
  if (!Number.isFinite(value) || value < 0) return null;
  // Un número de Excel o de JSON-LD: se redondea a 4 decimales (más de eso no tiene sentido acá).
  return value.toFixed(SCALE).replace(/\.?0+$/, '');
}

/**
 * Número escrito en formato argentino: punto de miles y coma decimal ("37.290", "37.290,50", "2,02").
 * También acepta un entero sin separadores. "2.02" es ambiguo (¿2,02 o 202?) y se rechaza: mejor marcar
 * la fila que importar un precio 100 veces más chico.
 */
export function parseArNumber(text: string): string | null {
  const cleaned = text
    .replace(/\u00a0/g, ' ')
    .replace(/\$|ars|u\$s|usd/gi, '')
    .trim()
    .replace(/\s+/g, '');
  if (cleaned === '') return null;
  let match = /^(\d{1,3}(?:\.\d{3})+)(?:,(\d{1,4}))?$/.exec(cleaned);
  if (match) return canonical(`${match[1]!.replace(/\./g, '')}${match[2] ? `.${match[2]}` : ''}`);
  match = /^(\d{1,12})(?:,(\d{1,4}))?$/.exec(cleaned);
  if (match) return canonical(`${match[1]}${match[2] ? `.${match[2]}` : ''}`);
  return null;
}

/** Número con punto decimal (JSON-LD, microdatos, metaetiquetas): "37290.00", 37290. */
export function parseDotNumber(value: unknown): string | null {
  if (typeof value === 'number') return canonical(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^\d{1,12}(\.\d{1,4})?$/.test(text)) return canonical(text);
  // Algunos sitios ponen el formato local también en content="37.290".
  return parseArNumber(text);
}

export function isPositive(value: string): boolean {
  return toScaled(value) > 0n;
}

/** Cambio relativo |nuevo − anterior| / anterior, comparado con un porcentaje (sin float). */
export function changedMoreThan(previous: string, next: string, pct: number): boolean {
  const before = toScaled(previous);
  const after = toScaled(next);
  if (before === 0n) return after !== 0n;
  const diff = after > before ? after - before : before - after;
  return diff * 100n > before * BigInt(pct);
}

export function compare(a: string, b: string): number {
  const x = toScaled(a);
  const y = toScaled(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function decimals(value: string): number {
  return value.includes('.') ? value.split('.')[1]!.length : 0;
}

/**
 * Cajas para cubrir una cantidad: hacia arriba. Devuelve las cajas y lo que efectivamente se lleva.
 * 45 m² con 2,02 m² por caja → 23 cajas y 46,46 m².
 */
export function packagesFor(quantity: string, perPackage: string): { packages: number; total: string } {
  const need = toScaled(quantity);
  const per = toScaled(perPackage);
  if (per <= 0n) throw new Error('Unidades por caja inválidas');
  const packages = (need + per - 1n) / per;
  return { packages: Number(packages), total: fromScaled(packages * per) };
}

/** "37290" → "37.290"; "30818.18" → "30.818,18"; con dos decimales si tiene centavos. */
export function formatArMoney(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const cents = fraction.replace(/0+$/, '');
  return cents ? `$${grouped},${fraction.padEnd(2, '0').slice(0, 2)}` : `$${grouped}`;
}

/** "46.46" → "46,46"; "2.025" → "2,03" (como mucho dos decimales, redondeo hacia arriba en la mitad). */
export function formatArNumber(value: string, maxDecimals = 2): string {
  const units = toScaled(value);
  const step = 10n ** BigInt(SCALE - maxDecimals);
  const rounded = ((units + step / 2n) / step) * step;
  const [whole, fraction = ''] = fromScaled(rounded).split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return fraction ? `${grouped},${fraction}` : grouped;
}
