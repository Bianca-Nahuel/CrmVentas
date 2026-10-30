// Solo rutas internas del panel después del login: nunca una URL externa (open redirect).
const BASE = 'https://panel.invalid';
const FALLBACK = '/';
// Pantallas a las que no tiene sentido volver después de entrar.
const NO_RETURN = ['/ingresar', '/sin-acceso', '/elegir-empresa'];

export function safeRedirect(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000) return FALLBACK;
  // Tiene que empezar con una sola barra: "//host" y "/\host" son URLs externas para el navegador.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return FALLBACK;
  // Sin caracteres de control ni barras invertidas (algunos navegadores las tratan como "/").
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return FALLBACK;

  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return FALLBACK;
  }
  if (url.origin !== BASE) return FALLBACK;
  // La normalización puede volver a armar "//host" ("/.//otro.com" → "//otro.com"): se revisa la salida.
  if (url.pathname.startsWith('//')) return FALLBACK;
  if (NO_RETURN.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`))) return FALLBACK;
  return `${url.pathname}${url.search}${url.hash}`;
}
