import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

// Usuarios del seed (apps/api/scripts/seed.ts). Contraseña pública de desarrollo (SEED_PASSWORD), nunca
// datos reales.
export const SEED_PASSWORD = 'dev-only-Password-123';
export const USERS = {
  ownerCeramicos: 'owner.ceramicos@example.test',
  multi: 'multi@example.test',
  baja: 'baja@example.test',
} as const;

export async function login(page: Page, email: string, password = SEED_PASSWORD, path = '/ingresar') {
  await page.goto(path);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
}

export async function expectInLayout(page: Page, tenantName: string) {
  await expect(page.getByTestId('tenant-name')).toHaveText(tenantName);
}

export function navLinks(page: Page) {
  return page.getByRole('navigation', { name: 'Secciones' }).getByRole('link');
}

// Tarea 025: entrantes simulados con el webhook firmado de WAHA (tiempo real y capturas).
// Sesión de WAHA del número principal del seed (ventas-principal de Cerámicos Demo).
const SEED_SESSION = 'ceramicos-demo';
const WEBHOOK_URL = 'http://localhost:3000/api/webhooks/waha';
const FIXTURE = new URL('../../api/test/fixtures/whatsapp/waha/message-text.json', import.meta.url);

export const uid = () => randomBytes(6).toString('hex');
export const randomPhone = () => `54911${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

/** Entrante de texto de `phone` (solo dígitos) al número principal del seed, firmado como WAHA. */
export async function inbound(request: APIRequestContext, phone: string, text: string, name = 'Prueba e2e') {
  const base = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { payload: Record<string, unknown> };
  const from = `${phone}@c.us`;
  const key = uid().toUpperCase();
  const body = JSON.stringify({
    ...base,
    id: `evt_${uid()}`,
    session: SEED_SESSION,
    payload: {
      ...base.payload,
      id: `false_${from}_${key}`,
      from,
      timestamp: Math.floor(Date.now() / 1000),
      body: text,
      _data: {
        key: { remoteJid: from, fromMe: false, id: key },
        pushName: name,
        message: { conversation: text },
      },
    },
  });
  await postWebhook(request, body);
}

/** POST al webhook de WAHA firmado con la clave de esta corrida (playwright.config.ts). */
async function postWebhook(request: APIRequestContext, body: string) {
  const secret = process.env['E2E_WAHA_HMAC_KEY'];
  if (!secret) throw new Error('Falta E2E_WAHA_HMAC_KEY (la pone playwright.config.ts)');
  const response = await request.post(WEBHOOK_URL, {
    data: body,
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Hmac': createHmac('sha512', secret).update(body).digest('hex'),
      'X-Webhook-Hmac-Algorithm': 'sha512',
    },
  });
  expect(response.status()).toBe(200);
}

// Tarea 011: escaneo del QR simulado. La API corre con el proveedor falso; el escaneo llega como en
// producción, con un session.status firmado de WAHA. La sesión de un canal es 'ch_' + su id sin guiones.
const SESSION_FIXTURE = new URL(
  '../../api/test/fixtures/whatsapp/waha/session-status-working.json',
  import.meta.url,
);

/** session.status de la sesión del canal: WORKING con el número escaneado (solo dígitos), o el estado dado. */
export async function sessionStatus(
  request: APIRequestContext,
  channelId: string,
  status: 'WORKING' | 'FAILED' | 'STOPPED',
  phone?: string,
) {
  const base = JSON.parse(readFileSync(SESSION_FIXTURE, 'utf8')) as Record<string, unknown>;
  const body = JSON.stringify({
    ...base,
    id: `evt_${uid()}`,
    session: `ch_${channelId.replaceAll('-', '')}`,
    me: phone ? { id: `${phone}@c.us`, pushName: 'Negocio e2e' } : null,
    payload: { status, statuses: [{ status, timestamp: Date.now() }], data: null },
  });
  await postWebhook(request, body);
}
