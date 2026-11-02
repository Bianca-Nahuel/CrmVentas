// Configuración de una sesión de WAHA para los scripts de desarrollo: la misma que usa la API al dar de
// alta un canal desde el panel (src/whatsapp/providers/waha/waha-session.ts).
import type { Env } from '../../src/config/env.js';
import type { CreateWahaSession } from '../../src/whatsapp/providers/waha/waha-client.js';
import { wahaSessionFor as sessionFor } from '../../src/whatsapp/providers/waha/waha-session.js';

export { CHANNEL_SESSION_NAME } from '../../src/whatsapp/providers/waha/waha-session.js';

export function wahaSessionFor(env: Env, name: string): CreateWahaSession {
  return sessionFor({ webhookUrl: env.WAHA_WEBHOOK_URL, hmacKey: env.WAHA_WEBHOOK_HMAC_KEY }, name);
}
