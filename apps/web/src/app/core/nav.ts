import { tenantRoles, type TenantRole, type statement } from '@ventas/shared/auth';
import { Bot, ChartColumn, Gauge, MessagesSquare, Package, RadioTower, Users, type IconNode } from 'lucide';

type Statement = typeof statement;
/** Un permiso de libs/shared: { recurso: [acciones] }. */
export type Permission = { [R in keyof Statement]?: Statement[R][number][] };

/**
 * ¿El rol tiene el permiso? Usa los mismos roles de Better Auth que la API (libs/shared). Solo sirve para
 * ocultar lo que no corresponde: quien decide es el backend.
 */
export function can(role: TenantRole | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  const definition = tenantRoles[role];
  if (!definition) return false;
  return definition.authorize(permission as Parameters<typeof definition.authorize>[0]).success;
}

export interface NavItem {
  path: string;
  label: string;
  icon: IconNode;
  permission: Permission;
  /** Texto de la página "próximamente". */
  soon: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    path: 'conversaciones',
    label: 'Conversaciones',
    icon: MessagesSquare,
    permission: { conversation: ['read'] },
    soon: 'Acá vas a ver y responder las conversaciones de WhatsApp de tu empresa.',
  },
  {
    path: 'leads',
    label: 'Leads',
    icon: Users,
    permission: { lead: ['read'] },
    soon: 'Acá vas a ver a cada interesado con su puntaje, su nivel y el resumen para atenderlo.',
  },
  {
    path: 'canales',
    label: 'Canales',
    icon: RadioTower,
    permission: { channel: ['read'] },
    soon: 'Acá vas a conectar los números de WhatsApp de la empresa.',
  },
  {
    path: 'catalogo',
    label: 'Catálogo',
    icon: Package,
    permission: { catalog: ['update'] },
    soon: 'Acá vas a cargar y revisar los productos que puede consultar el agente.',
  },
  {
    path: 'agente',
    label: 'Configuración del agente',
    icon: Bot,
    permission: { config: ['update'] },
    soon: 'Acá vas a configurar qué responde el agente, qué datos pide y cuándo deriva.',
  },
  {
    path: 'consumo',
    label: 'Consumo',
    icon: Gauge,
    permission: { billing: ['read'] },
    soon: 'Acá vas a ver cuánto usó la empresa y los créditos disponibles.',
  },
  {
    path: 'metricas',
    label: 'Métricas',
    icon: ChartColumn,
    permission: { metrics: ['read'] },
    soon: 'Acá vas a ver el embudo y las métricas de ventas.',
  },
];

export function navFor(role: TenantRole | null | undefined): NavItem[] {
  return NAV_ITEMS.filter((item) => can(role, item.permission));
}

/** Primera sección permitida: adonde va el usuario al entrar (el viewer, a Métricas). */
export function homePathFor(role: TenantRole | null | undefined): string {
  const first = navFor(role)[0];
  return first ? `/${first.path}` : '/sin-acceso';
}
