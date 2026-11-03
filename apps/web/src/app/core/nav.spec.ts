import { can, homePathFor, navFor } from './nav';

const paths = (role: Parameters<typeof navFor>[0]) => navFor(role).map((item) => item.path);

describe('navegación por rol (permisos de libs/shared)', () => {
  it('owner ve todo, incluido Consumo', () => {
    expect(paths('owner')).toEqual([
      'conversaciones',
      'leads',
      'numeros',
      'rendimiento',
      'catalogo',
      'agente',
      'consumo',
      'embudo',
    ]);
  });

  it('admin ve todo menos Consumo', () => {
    expect(paths('admin')).toEqual([
      'conversaciones',
      'leads',
      'numeros',
      'rendimiento',
      'catalogo',
      'agente',
      'embudo',
    ]);
  });

  it('seller ve Conversaciones y Leads, sin Números, Catálogo, Agente ni Consumo', () => {
    expect(paths('seller')).toEqual(['conversaciones', 'leads']);
  });

  it('viewer ve Rendimiento (solo totales) y el Embudo', () => {
    expect(paths('viewer')).toEqual(['rendimiento', 'embudo']);
  });

  it('sin rol no ve nada', () => {
    expect(paths(null)).toEqual([]);
    expect(can(undefined, { metrics: ['read'] })).toBe(false);
  });

  it('la ruta de inicio es la primera sección permitida', () => {
    expect(homePathFor('owner')).toBe('/conversaciones');
    expect(homePathFor('viewer')).toBe('/rendimiento');
    expect(homePathFor(null)).toBe('/sin-acceso');
  });
});
