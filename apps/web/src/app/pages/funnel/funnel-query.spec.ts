import { convertToParamMap } from '@angular/router';
import {
  DEFAULT_FUNNEL_QUERY,
  funnelApiParams,
  mondayOf,
  parseFunnelQuery,
  periodRange,
  toFunnelParams,
  weeksIn,
} from './funnel-query';
import { listTitle } from './funnel-format';

const UUID = '0193a5b2-1c2d-7e3f-8a9b-0c1d2e3f4a5b';

describe('estado del embudo en la URL (tarea 028)', () => {
  it('por defecto: últimas 4 semanas, sin filtros ni lista', () => {
    expect(parseFunnelQuery(convertToParamMap({}))).toEqual(DEFAULT_FUNNEL_QUERY);
  });

  it('ida y vuelta por la URL', () => {
    const query = {
      ...DEFAULT_FUNNEL_QUERY,
      period: 'range' as const,
      from: '2026-10-01',
      to: '2026-10-31',
      channel: UUID,
      tier: 'hot' as const,
      excludeNotALead: true,
      stage: 'hot' as const,
      dropped: true,
      page: 2,
    };
    const params = toFunnelParams(query);
    const clean = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== null));
    expect(parseFunnelQuery(convertToParamMap(clean))).toEqual(query);
  });

  it('descarta lo que no es válido', () => {
    const query = parseFunnelQuery(
      convertToParamMap({
        period: 'range',
        from: '2026-10-31',
        to: '2026-10-01',
        channel: 'x',
        stage: 'sold',
        dropped: '1',
        outcome: 'nope',
        lpage: '-1',
        tier: 'tibio',
      }),
    );
    // El rango invertido vuelve al período por defecto; «se cayó» no existe en «vendido».
    expect(query).toEqual({ ...DEFAULT_FUNNEL_QUERY, stage: 'sold' });
  });

  it('períodos: esta semana desde el lunes, 4 semanas = 28 días, 3 meses = 91 días', () => {
    // 2026-11-04 es miércoles.
    expect(mondayOf('2026-11-04')).toBe('2026-11-02');
    expect(mondayOf('2026-11-08')).toBe('2026-11-02');
    const today = '2026-11-04';
    expect(periodRange({ ...DEFAULT_FUNNEL_QUERY, period: 'week' }, today)).toEqual({
      from: '2026-11-02',
      to: today,
    });
    expect(periodRange(DEFAULT_FUNNEL_QUERY, today)).toEqual({ from: '2026-10-08', to: today });
    expect(periodRange({ ...DEFAULT_FUNNEL_QUERY, period: '3m' }, today)).toEqual({
      from: '2026-08-06',
      to: today,
    });
    expect(weeksIn({ from: '2026-10-08', to: today })).toBe(5);
  });

  it('pide la tendencia por semana si no pasa de 26 semanas; el vendedor solo con detalle', () => {
    const today = '2026-11-04';
    const query = { ...DEFAULT_FUNNEL_QUERY, seller: UUID };
    expect(funnelApiParams(query, today, { detail: true })).toMatchObject({ groupBy: 'week', userId: UUID });
    expect(funnelApiParams(query, today, { detail: false })).not.toHaveProperty('userId');
    const year = { ...DEFAULT_FUNNEL_QUERY, period: 'range' as const, from: '2026-01-01', to: '2026-11-04' };
    expect(funnelApiParams(year, today, { detail: false }).groupBy).toBe('total');
  });

  it('títulos de la lista', () => {
    expect(listTitle('hot', true, null)).toBe('Se perdieron después de «Caliente»');
    expect(listTitle('hot', false, 'not_sold')).toBe('Caliente · no compró');
    expect(listTitle('written', false, null)).toBe('Llegaron a «Escribió»');
    expect(listTitle(null, false, 'open')).toBe('En curso');
  });
});
