// Montos en USD como texto decimal (numeric en la base). Las cuentas se hacen con enteros escalados a
// 10 decimales para no arrastrar errores de float.
const SCALE = 10;
const FACTOR = 10n ** BigInt(SCALE);

function toUnits(usd: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(usd.trim());
  if (!match) throw new Error('Monto en USD inválido');
  const decimals = (match[2] ?? '').padEnd(SCALE, '0').slice(0, SCALE);
  return BigInt(match[1]!) * FACTOR + BigInt(decimals);
}

function fromUnits(units: bigint): string {
  const whole = units / FACTOR;
  const decimals = (units % FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return decimals ? `${whole}.${decimals}` : `${whole}`;
}

/** Un costo informado como número JSON (OpenRouter) a texto, sin notación exponencial. */
export function usdFromNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error('Costo inválido');
  return fromUnits(toUnits(value.toFixed(SCALE)));
}

export function addUsd(...amounts: string[]): string {
  return fromUnits(amounts.reduce((total, amount) => total + toUnits(amount), 0n));
}

/** tokens × precio por millón. */
export function tokensCostUsd(tokens: number, usdPerMTok: string): string {
  return fromUnits((BigInt(Math.max(0, Math.ceil(tokens))) * toUnits(usdPerMTok)) / 1_000_000n);
}
