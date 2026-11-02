// Tarea 024: responder desde el panel. La API de los e2e arranca con el proveedor de WhatsApp falso
// (playwright.config.ts): el envío pasa por el outbox y el worker de verdad, pero nada sale por WhatsApp.
import { expect, test, type Page } from '@playwright/test';
import { USERS, expectInLayout, login } from './helpers';

async function openConversation(page: Page, name: string) {
  await page.goto('/conversaciones');
  // Por nombre: las conversaciones que dejan otras corridas pueden sacarla de las 50 más recientes.
  await page.getByLabel('Buscar conversación').fill(name);
  await page.getByTestId('inbox-item').filter({ hasText: name }).click();
  await expect(page.getByTestId('conversation-title')).toHaveText(name);
}

test.describe('responder desde el panel', () => {
  test('el seller del número responde: aparece en cola, después enviado, y la IA queda pausada', async ({
    page,
  }) => {
    await login(page, USERS.multi);
    await page.getByRole('button', { name: /Cerámicos Demo/ }).click();
    await expectInLayout(page, 'Cerámicos Demo');
    await openConversation(page, 'Elena Respuesta');

    const box = page.getByTestId('reply-box');
    await expect(box.getByTestId('reply-channel')).toContainText('Sale por WhatsApp desde ventas-principal');
    const text = `Abrimos de 9 a 18 (${Date.now()})`;
    const input = box.getByTestId('reply-input');
    await input.fill(text);
    await input.press('Control+Enter');
    await expect(input).toHaveValue('');

    const bubble = page.getByTestId('message').filter({ hasText: text });
    await expect(bubble).toHaveCount(1);
    await expect(bubble).toHaveAttribute('data-sender', 'user');
    await expect(bubble.getByTestId('delivery')).toHaveAttribute('data-state', /queued|sending|sent/);
    await expect(page.getByTestId('ai-state')).toContainText('IA pausada');

    // El estado llega solo por el tiempo real (tarea 025), sin recargar ni tocar nada.
    await expect(bubble.getByTestId('delivery')).toHaveAttribute('data-state', 'sent', { timeout: 25_000 });
    await expect(bubble.getByTestId('delivery')).toContainText('Enviado');
    await expect(page.getByTestId('message').filter({ hasText: text })).toHaveCount(1);
  });

  test('número con los envíos pausados: caja deshabilitada y el motivo en texto', async ({ page }) => {
    await login(page, USERS.ownerCeramicos);
    await expectInLayout(page, 'Cerámicos Demo');
    await openConversation(page, 'Sofía Herrera');
    const box = page.getByTestId('reply-box');
    await expect(box.getByTestId('reply-blocked')).toHaveAttribute('data-reason', 'channel_paused');
    await expect(box.getByTestId('reply-blocked')).toContainText('pausados por riesgo de bloqueo');
    await expect(box.getByTestId('reply-input')).toBeDisabled();
    await expect(box.getByTestId('reply-send')).toBeDisabled();
  });

  test('más de 24 h sin que escriba el cliente: no se puede responder y se explica', async ({ page }) => {
    await login(page, USERS.ownerCeramicos);
    await expectInLayout(page, 'Cerámicos Demo');
    await openConversation(page, 'Diego Ventana');
    const box = page.getByTestId('reply-box');
    await expect(box.getByTestId('reply-blocked')).toHaveAttribute('data-reason', 'window_expired');
    await expect(box.getByTestId('reply-input')).toBeDisabled();
  });

  test('estado de cada mensaje con ícono y texto; reintento solo en lo que seguro no salió', async ({
    page,
  }) => {
    await login(page, USERS.ownerCeramicos);
    await expectInLayout(page, 'Cerámicos Demo');
    await openConversation(page, 'Carla Estados');
    const state = (text: string) =>
      page.getByTestId('message').filter({ hasText: text }).getByTestId('delivery');
    await expect(state('¿qué medida buscás?')).toHaveText('Leído');
    await expect(state('Te paso las opciones')).toHaveText('Entregado');
    await expect(state('el más pedido es el liso')).toHaveText('Enviado');
    await expect(state('Te mando las fotos')).toHaveText('No se envió');
    await expect(state('¿Te sirve alguno')).toHaveText('No sabemos si llegó');
    for (const text of ['¿qué medida buscás?', 'Te mando las fotos', '¿Te sirve alguno']) {
      await expect(state(text).locator('svg')).toHaveCount(1);
    }
    const failed = page.getByTestId('message').filter({ hasText: 'Te mando las fotos' });
    const unknown = page.getByTestId('message').filter({ hasText: '¿Te sirve alguno' });
    await expect(failed.getByTestId('retry')).toBeVisible();
    await expect(unknown.getByTestId('retry')).toHaveCount(0);
    await expect(unknown).toContainText('revisalo en el teléfono');
  });
});
