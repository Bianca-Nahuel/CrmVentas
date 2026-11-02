/**
 * Trabajo de la cola whatsapp-session-close: desvincular en el proveedor la sesión de un canal cuyo
 * escaneo se rechazó (otro teléfono, o un número que ya está en otro canal). Solo ids.
 */
export interface SessionCloseJob {
  tenantId: string;
  channelId: string;
}
