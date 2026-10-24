import type { WhatsAppProviderId } from '@ventas/shared';

/**
 * Trabajo de la cola whatsapp-inbound: el payload crudo y ya autenticado del webhook. Se normaliza en
 * el worker para guardarlo tal cual en messages.raw. Contiene datos personales: la cola los borra a
 * las 24 h (drizzle/0004_pgboss.sql).
 */
export interface InboundJob {
  provider: WhatsAppProviderId;
  payload: unknown;
}
