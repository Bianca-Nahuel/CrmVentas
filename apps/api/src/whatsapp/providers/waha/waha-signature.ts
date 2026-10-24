// Firma de los webhooks de WAHA: X-Webhook-Hmac = HMAC-SHA512 en hex del cuerpo crudo, con la clave
// configurada en la sesión (config.webhooks[].hmac.key). X-Webhook-Hmac-Algorithm dice "sha512".
// El timestamp (X-Webhook-Timestamp) no entra en la firma: un reenvío del mismo cuerpo es válido; los
// mensajes lo absorben con la idempotencia por (channel_id, external_id).
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WahaSignatureHeaders {
  hmac?: string | string[];
  algorithm?: string | string[];
}

const SHA512_HEX = /^[0-9a-f]{128}$/i;

export function verifyWahaSignature(headers: WahaSignatureHeaders, rawBody: Buffer, key: string): boolean {
  const { hmac, algorithm } = headers;
  if (typeof hmac !== 'string' || !SHA512_HEX.test(hmac)) return false;
  if (algorithm !== undefined && (typeof algorithm !== 'string' || algorithm.toLowerCase() !== 'sha512')) {
    return false;
  }
  const expected = createHmac('sha512', key).update(rawBody).digest();
  // Los dos buffers miden 64 bytes (el regex ya validó el largo del hex).
  return timingSafeEqual(expected, Buffer.from(hmac, 'hex'));
}
