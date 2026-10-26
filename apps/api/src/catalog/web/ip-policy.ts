// Qué IPs puede tocar el lector de páginas (protección SSRF, tarea 007): solo direcciones públicas.
// Las v4 escondidas dentro de una v6 (mapeadas, NAT64, 6to4) se revisan como v4.
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
// IPv4: "esta red", privadas, CGNAT, loopback, link-local, reservadas de IETF, documentación, benchmark,
// multicast, reservada y broadcast.
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
  blocked.addSubnet(network, prefix, 'ipv4');
}
// IPv6: sin especificar, loopback, únicas locales, link-local, site-local (obsoleta), multicast,
// documentación y las que traducen a v4 (se revisan aparte).
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['100::', 64],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/** La v4 que lleva adentro una v6 (::ffff:a.b.c.d, 64:ff9b::/96, 2002::/16), o null. */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return mapped[1]!;
  const groups = expandIpv6(lower);
  if (!groups) return null;
  const toV4 = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  // ::ffff:xxxx:xxxx (mapeada en hexa) y ::xxxx:xxxx (compatible, obsoleta).
  if (groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    return toV4(groups[6]!, groups[7]!);
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return toV4(groups[6]!, groups[7]!);
  }
  if (groups[0] === 0x2002) return toV4(groups[1]!, groups[2]!);
  return null;
}

function expandIpv6(address: string): number[] | null {
  if (address.includes('.')) return null;
  const [head, tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (address.includes('::') ? missing < 1 : left.length !== 8) return null;
  const parts = [...left, ...Array<string>(address.includes('::') ? missing : 0).fill('0'), ...right];
  const groups = parts.map((part) => Number.parseInt(part, 16));
  return groups.length === 8 &&
    groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : null;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return !blocked.check(address, 'ipv4');
  const v4 = embeddedIpv4(address);
  if (v4 !== null) return isIP(v4) === 4 && !blocked.check(v4, 'ipv4');
  return !blocked.check(address, 'ipv6');
}

/** Política de IPs: en producción, solo públicas. Los tests inyectan otra para su servidor local. */
export type IpPolicy = (address: string) => boolean;
export const PUBLIC_ONLY: IpPolicy = isPublicAddress;
