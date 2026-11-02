import { describe, expect, it } from 'vitest';
import { delta, durationLabel, highlightSegments } from './performance-format';

describe('durationLabel', () => {
  it('minutos y horas legibles', () => {
    expect(durationLabel(null)).toBe('—');
    expect(durationLabel(30)).toBe('menos de 1 min');
    expect(durationLabel(750)).toBe('13 min');
    expect(durationLabel(7500)).toBe('2 h 05 min');
  });
});

describe('delta', () => {
  it('con signo en el texto (no depende del color) y bueno o malo según la métrica', () => {
    expect(delta(5, 3, true)).toEqual({ text: '+2', direction: 'up', good: true });
    expect(delta(5, 3, false)).toEqual({ text: '+2', direction: 'up', good: false });
    expect(delta(1, 3, true)).toEqual({ text: '−2', direction: 'down', good: false });
    expect(delta(3, 3, true)).toEqual({ text: 'igual', direction: 'same', good: null });
    expect(delta(3, null, true).direction).toBe('none');
  });
});

describe('highlightSegments', () => {
  it('resalta la cita aunque el mensaje tenga otros espacios o saltos', () => {
    expect(highlightSegments('Hola!  Tenemos\nvarios modelos.', ['Tenemos varios'])).toEqual([
      { text: 'Hola!  ', mark: false },
      { text: 'Tenemos\nvarios', mark: true },
      { text: ' modelos.', mark: false },
    ]);
  });

  it('junta citas que se pisan y no interpreta la cita como expresión regular', () => {
    expect(highlightSegments('a (b) c (b) d', ['(b) c', 'c (b)'])).toEqual([
      { text: 'a ', mark: false },
      { text: '(b) c (b)', mark: true },
      { text: ' d', mark: false },
    ]);
  });

  it('el HTML del mensaje queda como texto en los tramos', () => {
    const segments = highlightSegments('<img src=x onerror=alert(1)> gracias', ['gracias']);
    expect(segments).toEqual([
      { text: '<img src=x onerror=alert(1)> ', mark: false },
      { text: 'gracias', mark: true },
    ]);
  });

  it('sin coincidencias: un solo tramo sin marcar', () => {
    expect(highlightSegments('hola', ['chau'])).toEqual([{ text: 'hola', mark: false }]);
  });
});
