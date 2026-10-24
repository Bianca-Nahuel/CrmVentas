// Verificación de la firma HMAC de los webhooks de WAHA (sin base ni red).
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWahaSignature } from '../src/whatsapp/providers/waha/waha-signature.js';

// Vector de ejemplo publicado en https://waha.devlike.pro/docs/how-to/events/#hmac-authentication
const DOC_BODY = '{"event":"message","session":"default","engine":"WEBJS"}';
const DOC_KEY = 'my-secret-key';
const DOC_HMAC =
  '208f8a55dde9e05519e898b10b89bf0d0b3b0fdf11fdbf09b6b90476301b98d8097c462b2b17a6ce93b6b47a136cf2e78a33a63f6752c2c1631777076153fa89';

const KEY = 'k'.repeat(64);
const body = Buffer.from('{"id":"evt_1","event":"message","session":"s","payload":{}}');
const sign = (raw: Buffer, key = KEY) => createHmac('sha512', key).update(raw).digest('hex');

describe('verifyWahaSignature', () => {
  it('acepta el vector de la documentación de WAHA', () => {
    expect(verifyWahaSignature({ hmac: DOC_HMAC, algorithm: 'sha512' }, Buffer.from(DOC_BODY), DOC_KEY)).toBe(
      true,
    );
  });

  it('acepta una firma válida con o sin header de algoritmo, y en mayúsculas', () => {
    expect(verifyWahaSignature({ hmac: sign(body), algorithm: 'sha512' }, body, KEY)).toBe(true);
    expect(verifyWahaSignature({ hmac: sign(body) }, body, KEY)).toBe(true);
    expect(verifyWahaSignature({ hmac: sign(body).toUpperCase() }, body, KEY)).toBe(true);
  });

  it('rechaza firma ausente, vacía, repetida o con otro algoritmo', () => {
    expect(verifyWahaSignature({}, body, KEY)).toBe(false);
    expect(verifyWahaSignature({ hmac: '' }, body, KEY)).toBe(false);
    expect(verifyWahaSignature({ hmac: [sign(body), sign(body)] }, body, KEY)).toBe(false);
    expect(verifyWahaSignature({ hmac: sign(body), algorithm: 'sha256' }, body, KEY)).toBe(false);
  });

  it('rechaza firma con otra clave, cuerpo modificado o formato inválido', () => {
    expect(verifyWahaSignature({ hmac: sign(body, 'x'.repeat(64)) }, body, KEY)).toBe(false);
    const tampered = Buffer.from(body.toString().replace('"s"', '"t"'));
    expect(verifyWahaSignature({ hmac: sign(body) }, tampered, KEY)).toBe(false);
    expect(verifyWahaSignature({ hmac: sign(body).slice(0, 64) }, body, KEY)).toBe(false);
    expect(verifyWahaSignature({ hmac: `${sign(body).slice(0, 126)}zz` }, body, KEY)).toBe(false);
  });
});
