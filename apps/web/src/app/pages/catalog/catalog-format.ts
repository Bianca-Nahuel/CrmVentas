// Formatos del panel de catálogo (tarea 027). Los montos llegan como texto decimal ("26135.90"): se muestran
// con el formato argentino sin hacer cuentas con ellos.

const UNIT_LABELS: Record<string, string> = {
  m2: 'm²',
  ml: 'metro lineal',
  unit: 'unidad',
  box: 'caja',
  kg: 'kg',
  l: 'litro',
};

export function unitLabel(unit: string): string {
  return UNIT_LABELS[unit] ?? unit;
}

export function money(amount: string | null | undefined, currency = 'ARS'): string {
  if (!amount) return '—';
  const [whole = '0', decimals = ''] = amount.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const cents = decimals.replace(/0+$/, '');
  return `${currency === 'ARS' ? '$' : `${currency} `}${grouped}${cents ? `,${decimals.padEnd(2, '0').slice(0, 2)}` : ''}`;
}

export function shortDateTime(iso: string): string {
  return new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
}

export function sourceLabel(source: 'web' | 'excel'): string {
  return source === 'web' ? 'de la web' : 'del Excel';
}

/** Por qué no se pudo leer una página (códigos del lector y del probador), en lenguaje claro. */
export function readErrorLabel(code: string | null | undefined): string {
  const labels: Record<string, string> = {
    url_invalid: 'La dirección no es válida.',
    url_not_https: 'La dirección tiene que empezar con https://.',
    url_domain: 'La dirección no es de un dominio permitido (agregalo en Configuración).',
    url_domain_www_variant:
      'La dirección va a la variante con o sin www de un dominio permitido: agregala también.',
    dns_failed: 'No se encontró el sitio.',
    ip_not_public: 'Esa dirección apunta a una red privada: no se puede leer.',
    redirect_not_allowed: 'La página redirige a otro sitio que no está permitido.',
    redirect_www_variant:
      'La página redirige a la variante con o sin www: agregala a los dominios permitidos.',
    too_many_redirects: 'La página redirige demasiadas veces.',
    http_status: 'El sitio respondió con un error.',
    not_html: 'La dirección no es una página web.',
    too_large: 'La página es demasiado grande.',
    bad_encoding: 'La página tiene un formato que no se puede leer.',
    timeout: 'El sitio tardó demasiado en responder.',
    fetch_failed: 'No se pudo conectar con el sitio.',
    no_url: 'El producto no tiene link.',
    no_price: 'No se encontró el precio en la página.',
    bad_price: 'El precio de la página no tiene un formato válido.',
    promo_above_list: 'El precio de promoción es mayor que el de lista: se descartó.',
    bad_no_taxes: 'El precio sin impuestos no es coherente: se descartó.',
    price_jump: 'El precio cambió demasiado respecto de la última lectura: se confirma en la próxima.',
  };
  return (code && labels[code]) || 'No se pudo leer la página.';
}
