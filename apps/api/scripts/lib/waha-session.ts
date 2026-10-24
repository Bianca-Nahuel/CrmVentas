// Configuración de una sesión de WAHA para un canal: un solo lugar para el webhook firmado, así crear
// el canal (create-dev-channel) y reaplicar el webhook (sync-channel-webhook) dejan lo mismo.
import type { Env } from '../../src/config/env.js';
import type { CreateWahaSession } from '../../src/whatsapp/providers/waha/waha-client.js';

/** Nombre de sesión que genera el sistema: 'ch_' + id del canal (uuid) sin guiones. */
export const CHANNEL_SESSION_NAME = /^ch_[0-9a-f]{32}$/;

export function wahaSessionFor(env: Env, name: string): CreateWahaSession {
  return {
    name,
    config: {
      webhooks: [
        {
          url: env.WAHA_WEBHOOK_URL,
          // message.any trae los entrantes y los propios (ecos); con message además, cada entrante
          // llegaría dos veces. message.ack: acuses de lo enviado.
          events: ['message.any', 'message.ack', 'session.status'],
          hmac: { key: env.WAHA_WEBHOOK_HMAC_KEY },
          retries: { policy: 'exponential', delaySeconds: 2, attempts: 6 },
        },
      ],
      // Defensa extra: el worker igual ignora estados, grupos y canales.
      ignore: { status: true, groups: true, channels: true },
    },
  };
}
