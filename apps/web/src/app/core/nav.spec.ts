import { can, homePathFor, navFor } from './nav';

const paths = (role: Parameters<typeof navFor>[0]) => navFor(role).map((item) => item.path);

describe('navegación por rol (permisos de libs/shared)', () => {
  it('owner ve todo, incluido Consumo', () => {
    expect(paths('owner')).toEqual([
      'conversaciones',
      'leads',
      'canales',
      'catalogo',
      'agente',
      'consumo',
      'metricas',
    ]);
  });

  it('admin ve todo menos Consumo', () => {
    expect(paths('admin')).toEqual(['conversaciones', 'leads', 'canales', 'catalogo', 'agente', 'metricas']);
  });

  it('seller ve Conversaciones y Leads, sin Canales, Catálogo, Agente ni Consumo', () => {
    expect(paths('seller')).toEqual(['conversaciones', 'leads']);
  });

  it('viewer ve solo Métricas', () => {
    expect(paths('viewer')).toEqual(['metricas']);
  });

  it('sin rol no ve nada', () => {
    expect(paths(null)).toEqual([]);
    expect(can(undefined, { metrics: ['read'] })).toBe(false);
  });

  it('la ruta de inicio es la primera sección permitida', () => {
    expect(homePathFor('owner')).toBe('/conversaciones');
    expect(homePathFor('viewer')).toBe('/metricas');
    expect(homePathFor(null)).toBe('/sin-acceso');
  });
});
