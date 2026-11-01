// Tarea 025: tiempo real. Con el panel abierto se simula un entrante con el webhook firmado de WAHA (como lo
// manda WAHA, con la clave de esta corrida: playwright.config.ts) y el cambio aparece sin recargar. Corta la
// red del navegador y, al volver, el panel se pone al día. Números ficticios; la IA está apagada.
import { expect, test, type Page } from '@playwright/test';
import { USERS, expectInLayout, inbound, login, randomPhone, uid } from './helpers';

// Criterio de la tarea: el entrante aparece en menos de 3 s.
const REALTIME_MS = 3_000;

const indicator = (page: Page) => page.getByTestId('live-indicator').locator('visible=true');

async function openOwner(page: Page, path: string) {
  await login(page, USERS.ownerCeramicos);
  await expectInLayout(page, 'Cerámicos Demo');
  await page.goto(path);
  await expect(indicator(page)).toHaveAttribute('data-status', 'live');
}

/** Abre la conversación de un teléfono buscándolo en la bandeja. */
async function openByPhone(page: Page, phone: string) {
  await page.getByLabel('Buscar conversación').fill(phone);
  await expect(page.getByTestId('inbox-item')).toHaveCount(1);
  await page.getByTestId('inbox-item').click();
  await expect(page.getByTestId('conversation-title')).toBeVisible();
}

test.describe('tiempo real', () => {
  test('grilla: una fila que ya se ve se actualiza en su lugar, sin recargar', async ({ page, request }) => {
    await openOwner(page, '/leads');
    const row = page.getByTestId('lead-row').filter({ hasText: 'Ana Gómez' });
    const phone = (await row.textContent())?.match(/\+(\d{10,15})/)?.[1];
    expect(phone).toBeTruthy();
    const firstName = () => page.getByTestId('lead-row').first().getByRole('link').textContent();
    const before = await firstName();

    const text = `Consulta e2e ${uid()}`;
    await inbound(request, phone!, text, 'Ana Gómez');
    await expect(row).toContainText(text, { timeout: REALTIME_MS });
    // No se reordenó lo que el usuario estaba mirando.
    expect(await firstName()).toBe(before);
  });

  test('grilla: una conversación nueva entra arriba marcada como "Nueva"', async ({ page, request }) => {
    await openOwner(page, '/leads?sort=last_message&dir=desc');
    const text = `Primera consulta e2e ${uid()}`;
    await inbound(request, randomPhone(), text);
    const first = page.getByTestId('lead-row').first();
    await expect(first).toContainText(text, { timeout: REALTIME_MS });
    await expect(first.getByTestId('new-chip')).toHaveText('Nueva');
  });

  test('conversación abierta: el mensaje aparece sin recargar', async ({ page, request }) => {
    const phone = randomPhone();
    await inbound(request, phone, `Hola, primera vez ${uid()}`);
    await openOwner(page, '/conversaciones');
    await openByPhone(page, phone);

    const text = `¿Tienen stock? ${uid()}`;
    await inbound(request, phone, text);
    await expect(page.getByTestId('message-body').filter({ hasText: text })).toBeVisible({
      timeout: REALTIME_MS,
    });
  });

  test('se corta la red y al volver el panel se pone al día', async ({ page, request, context }) => {
    const phone = randomPhone();
    await inbound(request, phone, `Hola ${uid()}`);
    await openOwner(page, '/conversaciones');
    await openByPhone(page, phone);

    await context.setOffline(true);
    await expect(indicator(page)).toHaveAttribute('data-status', 'offline');
    await expect(indicator(page)).toContainText('Sin conexión');
    // Mientras tanto entra un mensaje (el request de la API no pasa por el navegador).
    const text = `Mensaje durante el corte ${uid()}`;
    await inbound(request, phone, text);
    await page.waitForTimeout(500);
    await expect(page.getByTestId('message-body').filter({ hasText: text })).toHaveCount(0);

    await context.setOffline(false);
    await expect(indicator(page)).toHaveAttribute('data-status', 'live');
    await expect(page.getByTestId('message-body').filter({ hasText: text })).toBeVisible({
      timeout: REALTIME_MS,
    });
  });
});
