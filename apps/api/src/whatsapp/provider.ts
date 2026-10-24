// Interfaz común de los proveedores de WhatsApp (WAHA, Cloud API). La lógica de negocio solo conoce
// esto y los eventos normalizados de @ventas/shared: lo que difiere entre proveedores se expresa con
// capabilities, nunca preguntando qué proveedor es.
import type { WhatsAppEvent, WhatsAppProviderId } from '@ventas/shared';

export interface WhatsAppCapabilities {
  /** Exige plantillas aprobadas fuera de la ventana de 24 h. */
  templates: boolean;
  /** Solo se puede responder dentro de las 24 h del último mensaje del contacto. */
  within24hWindowOnly: boolean;
  /** Informa de qué anuncio vino el contacto. */
  adAttribution: boolean;
  /** Permite campañas salientes (nunca en la conexión no oficial). */
  outboundCampaigns: boolean;
}

export type NormalizeResult =
  { kind: 'event'; event: WhatsAppEvent } | { kind: 'ignored'; reason: string; eventId: string | null };

export interface WhatsAppProvider {
  readonly id: WhatsAppProviderId;
  readonly capabilities: WhatsAppCapabilities;
  /** Traduce el payload crudo del webhook (ya autenticado) a un evento interno. Pura. */
  normalize(raw: unknown): NormalizeResult;
  /**
   * Completa lo que requiere consultar al proveedor (por ejemplo, el número de un contacto que llegó
   * con un identificador opaco). Corre en el worker, antes de abrir la transacción. Un error de red
   * se propaga para que la cola reintente.
   */
  enrich(event: WhatsAppEvent): Promise<WhatsAppEvent>;
}

/** Token de inyección con todos los proveedores registrados. */
export const WHATSAPP_PROVIDER_REGISTRY = Symbol('WHATSAPP_PROVIDER_REGISTRY');
export type WhatsAppProviderRegistry = ReadonlyMap<WhatsAppProviderId, WhatsAppProvider>;
