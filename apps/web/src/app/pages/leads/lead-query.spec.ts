import { convertToParamMap } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { DEFAULT_QUERY, parseLeadQuery, toApiParams, toQueryParams } from './lead-query';

const CHANNEL = '01a18cf8-366b-71bf-8816-45abe3f54aaf';

describe('parseLeadQuery', () => {
  it('sin parámetros → estado por defecto', () => {
    expect(parseLeadQuery(convertToParamMap({}))).toEqual(DEFAULT_QUERY);
  });

  it('lee orden, filtros, búsqueda y página', () => {
    const query = parseLeadQuery(
      convertToParamMap({
        sort: 'score',
        dir: 'asc',
        tier: 'hot',
        status: 'handed_off',
        channel: CHANNEL,
        q: 'ana',
        page: '2',
      }),
    );
    expect(query).toEqual({
      sort: 'score',
      dir: 'asc',
      tier: 'hot',
      status: 'handed_off',
      channel: CHANNEL,
      q: 'ana',
      page: 2,
    });
  });

  it('ignora valores inválidos de la URL', () => {
    const query = parseLeadQuery(
      convertToParamMap({
        sort: 'raw',
        dir: 'x',
        tier: 'hot,warm',
        status: 'x',
        channel: '1; drop',
        page: '-3',
      }),
    );
    expect(query).toEqual(DEFAULT_QUERY);
  });
});

describe('toQueryParams / toApiParams', () => {
  it('la URL solo lleva lo que difiere del estado por defecto', () => {
    expect(toQueryParams({ ...DEFAULT_QUERY, tier: 'cold' })).toEqual({
      sort: null,
      dir: null,
      tier: 'cold',
      status: null,
      channel: null,
      q: null,
      page: null,
    });
  });

  it('ida y vuelta por la URL sin perder nada', () => {
    const query = {
      ...DEFAULT_QUERY,
      sort: 'last_message' as const,
      dir: 'asc' as const,
      q: 'juan',
      page: 1,
    };
    const params = Object.fromEntries(Object.entries(toQueryParams(query)).filter(([, v]) => v !== null));
    expect(parseLeadQuery(convertToParamMap(params))).toEqual(query);
  });

  it('no manda una búsqueda de un carácter ni filtros vacíos', () => {
    expect(toApiParams({ ...DEFAULT_QUERY, q: ' a ' })).toEqual({
      sort: 'default',
      dir: 'desc',
      page: 0,
      pageSize: 25,
    });
    expect(toApiParams({ ...DEFAULT_QUERY, channel: CHANNEL, q: 'ana' })).toMatchObject({
      channelId: CHANNEL,
      q: 'ana',
    });
  });
});
