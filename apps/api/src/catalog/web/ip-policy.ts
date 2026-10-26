// Qué IPs puede tocar el lector de páginas (protección SSRF, tarea 007): solo direcciones públicas.
// Las v6 se pasan a 16 bytes (también las que traen una v4 con puntos al final, como "::10.0.0.1", que es
// la forma en que Node las muestra) y las que llevan una v4 adentro (mapeadas, NAT64, 6to4) se revisan
// como v4. Los prefijos de traducción o túnel sin una v4 confiable se bloquean enteros.
import { BlockList, isIP } from 'node:net';

const blockedV4 = new BlockList();
// "Esta red", privadas, CGNAT, loopback, link-local, reservadas de IETF, documentación, 6to4 relay,
// benchmark, multicast, reservada y broadcast.
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedV4.addSubnet(network, prefix, 'ipv4');
}

/** "a.b.c.d" → 4 bytes, o null. */
function parseV4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return bytes.every((byte) => Number.isInteger(byte) && byte <= 255) ? bytes : null;
}

/** Una v6 (con o sin v4 al final) → 16 bytes, o null. */
export function parseV6(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  // "::10.0.0.1" → "::a00:1": la v4 del final pasa a dos grupos hexadecimales.
  const lastColon = text.lastIndexOf(':');
  const last = text.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = parseV4(last);
    if (!v4) return null;
    const hex = (high: number, low: number) => ((high << 8) | low).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hex(v4[0]!, v4[1]!)}:${hex(v4[2]!, v4[3]!)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...right];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 255];
  });
}

const startsWith = (bytes: number[], prefix: number[]) =>
  prefix.every((byte, index) => bytes[index] === byte);
const zeros = (count: number) => Array<number>(count).fill(0);
const v4Public = (bytes: number[]) => !blockedV4.check(bytes.join('.'), 'ipv4');

function isPublicV6(bytes: number[]): boolean {
  // ::/96 (sin especificar, loopback y las "compatibles" con v4, obsoletas) y ::ffff:0:0:0/96 (SIIT).
  if (startsWith(bytes, zeros(12))) return false;
  if (startsWith(bytes, [...zeros(8), 0xff, 0xff, 0, 0])) return false;
  // ::ffff:0:0/96 (v4 mapeada) y 64:ff9b::/96 (NAT64): se mira la v4.
  if (startsWith(bytes, [...zeros(10), 0xff, 0xff])) return v4Public(bytes.slice(12));
  if (startsWith(bytes, [0, 0x64, 0xff, 0x9b, ...zeros(8)])) return v4Public(bytes.slice(12));
  // 64:ff9b:1::/48 (NAT64 local) y 2001::/32 (Teredo): se bloquean enteros.
  if (startsWith(bytes, [0, 0x64, 0xff, 0x9b, 0, 1])) return false;
  if (startsWith(bytes, [0x20, 0x01, 0, 0])) return false;
  // 2002::/16 (6to4): la v4 está en los bytes 2 a 5.
  if (startsWith(bytes, [0x20, 0x02])) return v4Public(bytes.slice(2, 6));
  const first = bytes[0]!;
  // fc00::/7 (únicas locales), fe80::/10 (link-local), fec0::/10 (site-local), ff00::/8 (multicast).
  if ((first & 0xfe) === 0xfc || first === 0xff) return false;
  if (first === 0xfe && (bytes[1]! & 0xc0) >= 0x80) return false;
  // 2001:db8::/32 (documentación) y 100::/64 (descarte).
  if (startsWith(bytes, [0x20, 0x01, 0x0d, 0xb8])) return false;
  if (startsWith(bytes, [0x01, 0, ...zeros(6)])) return false;
  return true;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  if (family !== 6) return false;
  const bytes = parseV6(address);
  return bytes !== null && isPublicV6(bytes);
}

/** Política de IPs: en producción, solo públicas. Los tests inyectan otra para su servidor local. */
export type IpPolicy = (address: string) => boolean;
export const PUBLIC_ONLY: IpPolicy = isPublicAddress;
