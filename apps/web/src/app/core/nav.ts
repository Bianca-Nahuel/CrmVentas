import { roleCan, type TenantPermission, type TenantRole } from '@ventas/shared/auth';
import {
  Bot,
  Funnel,
  Gauge,
  MessagesSquare,
  Package,
  RadioTower,
  TrendingUp,
  Users,
  type IconNode,
} from 'lucide';

/** Un permiso de libs/shared: { recurso: [acciones] }. */
export type Permission = TenantPermission;

/**
 * ¿El rol tiene el permiso? Usa los mismos roles de Better Auth que la API (libs/shared). Solo sirve para
 * ocultar lo que no corresponde: quien decide es el backend.
 */
export function can(role: TenantRole | null | undefined, permission: Permission): boolean {
  return roleCan(role, permission);
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
    path: 'numeros',
    label: 'Números',
    icon: RadioTower,
    permission: { channel: ['read'] },
    soon: 'Acá vas a conectar los números de WhatsApp de la empresa y elegir qué vendedores los atienden.',
  },
  {
    path: 'rendimiento',
    label: 'Rendimiento',
    icon: TrendingUp,
    permission: { performance: ['read'] },
    soon: 'Acá vas a ver cómo trabaja el equipo: atendidas, tiempos de respuesta y calidad.',
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
    path: 'embudo',
    label: 'Embudo',
    icon: Funnel,
    permission: { metrics: ['read'] },
    soon: 'Acá vas a ver cuántos de los que escriben terminan comprando y en qué paso se pierden.',
  },
];

export function navFor(role: TenantRole | null | undefined): NavItem[] {
  return NAV_ITEMS.filter((item) => can(role, item.permission));
}

/** Primera sección permitida: adonde va el usuario al entrar (el viewer, a Rendimiento). */
export function homePathFor(role: TenantRole | null | undefined): string {
  const first = navFor(role)[0];
  return first ? `/${first.path}` : '/sin-acceso';
}
