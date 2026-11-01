import { describe, expect, it } from 'vitest';
import {
  contactName,
  dayLabel,
  deliveryHelp,
  deliveryLabel,
  groupByDay,
  previewText,
  reasonLabel,
  shortWhen,
  waitingFor,
} from './format';

// Fechas locales (el test corre con la zona del sistema): se arman con new Date(año, mes, día, hora).
const at = (day: number, hour = 10, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();
const NOW = new Date(2026, 9, 30, 15, 0);

describe('dayLabel', () => {
  it('hoy, ayer y el día con nombre (en es-AR)', () => {
    expect(dayLabel(at(30), NOW)).toBe('Hoy');
    expect(dayLabel(at(29, 23, 59), NOW)).toBe('Ayer');
    expect(dayLabel(at(27), NOW)).toBe('martes, 27 de octubre');
  });

  it('con el año si no es el actual', () => {
    expect(dayLabel(new Date(2025, 11, 31, 12).toISOString(), NOW)).toContain('2025');
  });
});

describe('shortWhen', () => {
  it('recién, minutos, hora, ayer y fecha corta', () => {
    expect(shortWhen(new Date(NOW.getTime() - 20_000).toISOString(), NOW)).toBe('recién');
    expect(shortWhen(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW)).toBe('hace 5 min');
    expect(shortWhen(at(30, 9, 5), NOW)).toMatch(/^09:05/);
    expect(shortWhen(at(29), NOW)).toBe('ayer');
    expect(shortWhen(at(20), NOW)).toBe('20/10');
  });
});

describe('groupByDay', () => {
  it('agrupa por día local y mantiene el orden', () => {
    const groups = groupByDay(
      [
        { id: 'a', sentAt: at(28, 9) },
        { id: 'b', sentAt: at(28, 18) },
        { id: 'c', sentAt: at(30, 8) },
      ],
      NOW,
    );
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ['miércoles, 28 de octubre', ['a', 'b']],
      ['Hoy', ['c']],
    ]);
  });
});

describe('reasonLabel', () => {
  it('traduce los códigos conocidos y sus sufijos', () => {
    expect(reasonLabel('asks_human')).toBe('Pidió hablar con una persona');
    expect(reasonLabel('availability:incompleto')).toBe('Consultó disponibilidad o stock (faltaban datos)');
    expect(reasonLabel('blocked:suggestion_limit')).toBe('Un control de seguridad frenó la respuesta');
    expect(reasonLabel('custom_obra_grande')).toBe('Regla de la empresa');
  });

  it('un código desconocido se muestra tal cual', () => {
    expect(reasonLabel('algo_nuevo')).toBe('algo_nuevo');
  });
});

describe('contactName y previewText', () => {
  it('sin nombre usa el número; sin texto, el tipo de mensaje', () => {
    expect(contactName({ name: '  ', waId: '+5491100000001' })).toBe('+5491100000001');
    expect(contactName({ name: 'Ana', waId: '+54' })).toBe('Ana');
    expect(previewText({ type: 'audio', preview: null })).toBe('Audio');
    expect(previewText({ type: 'text', preview: '<b>hola</b>' })).toBe('<b>hola</b>');
    expect(previewText(null)).toBe('Sin mensajes');
  });
});

describe('waitingFor', () => {
  it('minutos, horas y días', () => {
    const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
    expect(waitingFor(ago(0.2), NOW)).toBe('recién');
    expect(waitingFor(ago(12), NOW)).toBe('12 min');
    expect(waitingFor(ago(185), NOW)).toBe('3 h');
    expect(waitingFor(ago(60 * 50), NOW)).toBe('2 d');
  });
});

describe('deliveryLabel y deliveryHelp', () => {
  it('cada estado en palabras; "no sabemos" se distingue de "no se envió"', () => {
    expect(deliveryLabel({ state: 'queued', reason: null })).toBe('En cola');
    expect(deliveryLabel({ state: 'sending', reason: null })).toBe('Enviando…');
    expect(deliveryLabel({ state: 'sent', reason: null })).toBe('Enviado');
    expect(deliveryLabel({ state: 'delivered', reason: null })).toBe('Entregado');
    expect(deliveryLabel({ state: 'read', reason: null })).toBe('Leído');
    expect(deliveryLabel({ state: 'failed', reason: 'not_sent' })).toBe('No se envió');
    expect(deliveryLabel({ state: 'failed', reason: 'maybe_sent' })).toBe('No sabemos si llegó');
    expect(deliveryLabel({ state: 'rejected', reason: 'window_expired' })).toBe('No se envió');
  });

  it('ayuda solo cuando hace falta: revisar el teléfono o el motivo del rechazo', () => {
    expect(deliveryHelp({ state: 'sent', reason: null })).toBeNull();
    expect(deliveryHelp({ state: 'failed', reason: 'not_sent' })).toBeNull();
    expect(deliveryHelp({ state: 'failed', reason: 'maybe_sent' })).toContain('revisalo en el teléfono');
    expect(deliveryHelp({ state: 'rejected', reason: 'channel_paused' })).toContain('pausados');
  });
});
