// Monto aproximado de una venta (tarea 028), como lo escribe una persona en Argentina: "1.500,50", "1500,5",
// "1500.50" o "12.000". Se manda a la API como texto decimal con punto (la plata nunca es un float).

/** Hasta 12 enteros y 2 decimales, mayor que 0: lo mismo que valida la API. */
const API_AMOUNT = /^\d{1,12}(\.\d{1,2})?$/;
/** Puntos de miles sin decimales: "12.000", "1.500.000". */
const THOUSANDS_ONLY = /^\d{1,3}(\.\d{3})+$/;

/** Texto escrito → monto para la API. '' → null (sin monto); algo que no es un monto → 'invalid'. */
export function parseAmount(text: string): string | null | 'invalid' {
  const value = text.trim().replace(/\s/g, '').replace(/^\$/, '');
  if (value === '') return null;
  let normalized: string;
  if (value.includes(',')) normalized = value.replace(/\./g, '').replace(',', '.');
  else if (THOUSANDS_ONLY.test(value)) normalized = value.replace(/\./g, '');
  else normalized = value;
  if (!API_AMOUNT.test(normalized) || Number(normalized) <= 0) return 'invalid';
  return normalized;
}

/** "ARS 1.500,50" para mostrar un monto de la API. */
export function amountLabel(amount: string | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  return `ARS ${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(Number(amount))}`;
}
