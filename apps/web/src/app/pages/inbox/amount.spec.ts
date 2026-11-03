import { amountLabel, parseAmount } from './amount';

describe('monto de la venta (tarea 028)', () => {
  it('acepta el formato argentino y el de la API', () => {
    expect(parseAmount('1.500,50')).toBe('1500.50');
    expect(parseAmount('1500,5')).toBe('1500.5');
    expect(parseAmount('1500.50')).toBe('1500.50');
    expect(parseAmount('12.000')).toBe('12000');
    expect(parseAmount('1.500.000')).toBe('1500000');
    expect(parseAmount(' $ 250 ')).toBe('250');
  });

  it('vacío es "sin monto"; lo que no es un monto, inválido', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('   ')).toBeNull();
    for (const text of ['0', '0,00', '-5', 'abc', '1,234', '1.2.3', '1e5', '1234567890123']) {
      expect(parseAmount(text)).toBe('invalid');
    }
  });

  it('se muestra en pesos con el formato local', () => {
    expect(amountLabel('150000.50')).toBe('ARS 150.000,5');
    expect(amountLabel(null)).toBe('—');
  });
});
