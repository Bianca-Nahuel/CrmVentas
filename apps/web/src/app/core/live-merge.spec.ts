import { mergeLive } from './live-merge';

const row = (id: string, text = 'a') => ({ id, text });

describe('mergeLive', () => {
  it('actualiza en su lugar las filas que ya estaban, sin reordenar', () => {
    const current = [row('1'), row('2'), row('3')];
    // El servidor ahora ordena 3, 1, 2 y cambió el 3.
    const result = mergeLive(current, [row('3', 'nuevo'), row('1'), row('2')], false);
    expect(result.items.map((r) => r.id)).toEqual(['1', '2', '3']);
    expect(result.items[2]).toEqual(row('3', 'nuevo'));
    expect(result.changed).toEqual(['3']);
    expect(result.pending).toEqual([]);
  });

  it('una fila nueva entra arriba si se puede insertar; si no, queda pendiente', () => {
    const current = [row('1'), row('2')];
    const fresh = [row('9'), row('1'), row('2')];
    const inserted = mergeLive(current, fresh, true);
    expect(inserted.items.map((r) => r.id)).toEqual(['9', '1', '2']);
    expect(inserted.inserted).toEqual(['9']);

    const pending = mergeLive(current, fresh, false);
    expect(pending.items.map((r) => r.id)).toEqual(['1', '2']);
    expect(pending.pending).toEqual(['9']);
  });

  it('una fila que el servidor ya no trae se queda (no salta la lista bajo el cursor)', () => {
    const result = mergeLive([row('1'), row('2')], [row('2')], true);
    expect(result.items.map((r) => r.id)).toEqual(['1', '2']);
    expect(result.changed).toEqual([]);
  });
});
