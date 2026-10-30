import { safeRedirect } from './safe-redirect';

describe('safeRedirect', () => {
  it('deja pasar rutas internas con query y hash', () => {
    expect(safeRedirect('/leads')).toBe('/leads');
    expect(safeRedirect('/leads?estado=caliente#arriba')).toBe('/leads?estado=caliente#arriba');
  });

  it.each([
    'https://otro-sitio.com',
    'http://otro-sitio.com/leads',
    '//otro-sitio.com',
    '/\\otro-sitio.com',
    '\\\\otro-sitio.com',
    'javascript:alert(1)',
    'data:text/html,hola',
    'leads',
    '/le\nads',
    '/.//otro-sitio.com',
    '/a/..//otro-sitio.com',
    '',
    undefined,
    null,
    42,
  ])('manda al inicio con %j', (value) => {
    expect(safeRedirect(value)).toBe('/');
  });

  it('la salida nunca empieza con "//"', () => {
    for (const value of ['/.//x.com', '/a/..//x.com', '/%2e//x.com', '/././/x.com']) {
      expect(safeRedirect(value).startsWith('//'), value).toBe(false);
    }
  });

  it('no vuelve a pantallas de autenticación', () => {
    expect(safeRedirect('/ingresar')).toBe('/');
    expect(safeRedirect('/ingresar?redirect=/leads')).toBe('/');
    expect(safeRedirect('/sin-acceso')).toBe('/');
    expect(safeRedirect('/elegir-empresa')).toBe('/');
  });
});
