// Configuración de una sesión de WAHA para un canal: un solo lugar para el nombre y el webhook firmado,
// así el alta desde el panel, los scripts de desarrollo y el reaplicar el webhook dejan lo mismo.
import type { CreateWahaSession } from './waha-client.js';

/** Nombre de sesión que genera el sistema: 'ch_' + id del canal (uuid) sin guiones. */
export const CHANNEL_SESSION_NAME = /^ch_[0-9a-f]{32}$/;

/** Letras, números y guion bajo: válido como nombre de sesión de WAHA. */
export function wahaSessionName(channelId: string): string {
  return `ch_${channelId.replaceAll('-', '').toLowerCase()}`;
}

export interface WahaWebhookSettings {
  webhookUrl: string;
  hmacKey: string;
}

export function wahaSessionFor(settings: WahaWebhookSettings, name: string): CreateWahaSession {
  return {
    name,
    config: {
      webhooks: [
        {
          url: settings.webhookUrl,
          // message.any trae los entrantes y los propios (ecos); con message además, cada entrante
          // llegaría dos veces. message.ack: acuses de lo enviado. session.status: vinculación y caídas.
          events: ['message.any', 'message.ack', 'session.status'],
          hmac: { key: settings.hmacKey },
          retries: { policy: 'exponential', delaySeconds: 2, attempts: 6 },
        },
      ],
      // Defensa extra: el worker igual ignora estados, grupos y canales.
      ignore: { status: true, groups: true, channels: true },
    },
  };
}
