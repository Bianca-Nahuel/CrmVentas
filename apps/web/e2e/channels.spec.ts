// Tarea 011: conectar un número por QR desde el panel, con el proveedor falso. El escaneo se simula con el
// webhook firmado de WAHA (session.status WORKING con el número) y el panel lo muestra sin recargar.
// Números ficticios. Los canales que quedan de una corrida terminan desconectados o cancelados: no ocupan
// lugar en el tope de sesiones abiertas.
import { expect, test, type Page } from '@playwright/test';
import { expectInLayout, loginAs, randomPhone, sessionStatus, uid, USERS } from './helpers';

// El QR se vuelve a pedir cada 5 s y el estado llega por el tiempo real: mucho menos que esto.
const LIVE_MS = 8_000;

async function openChannels(page: Page) {
  await loginAs(page, USERS.ownerCeramicos);
  await expectInLayout(page, 'Cerámicos Demo');
  await page.goto('/numeros');
  await expect(page.getByRole('heading', { name: 'Números', level: 1 })).toBeVisible();
}

const row = (page: Page, name: string) => page.getByTestId('channel-row').filter({ hasText: name });

/** Alta desde el panel hasta ver el QR. Devuelve el id del canal (de la fila, detrás del diálogo). */
async function createChannel(page: Page, name: string) {
  await page.getByTestId('connect-new').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Conectar un número' })).toBeVisible();
  // Sin nombre no se puede seguir.
  await expect(dialog.getByTestId('create-channel')).toBeDisabled();
  await dialog.getByLabel('Nombre del canal').fill(name);
  await dialog.getByTestId('create-channel').click();
  await expect(dialog.getByTestId('qr-image')).toBeVisible();
  await expect(dialog.getByTestId('pairing-status')).toContainText('Esperando el escaneo');
  const id = await row(page, name).getAttribute('data-channel-id');
  expect(id).toBeTruthy();
  return id!;
}

test.describe('canales', () => {
  test('alta, escaneo, desconectar y reconectar, sin recargar', async ({ page, request }) => {
    await openChannels(page);
    const name = `e2e ${uid()}`;
    const phone = randomPhone();
    const id = await createChannel(page, name);
    const dialog = page.getByRole('dialog');

    await sessionStatus(request, id, 'WORKING', phone);
    await expect(dialog.getByTestId('pairing-status')).toContainText(`¡Conectado! +${phone}`, {
      timeout: LIVE_MS,
    });
    await dialog.getByTestId('pairing-done').click();
    await expect(dialog).toBeHidden();
    await expect(row(page, name).getByTestId('channel-status')).toHaveText('Conectado');
    await expect(row(page, name).getByTestId('channel-phone')).toContainText(`+${phone}`);

    // Desconectar pide confirmación.
    await row(page, name).getByTestId('disconnect').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancelar' }).click();
    await expect(row(page, name).getByTestId('channel-status')).toHaveText('Conectado');
    await row(page, name).getByTestId('disconnect').click();
    await page.getByRole('alertdialog').getByTestId('confirm').click();
    await expect(row(page, name).getByTestId('channel-status')).toHaveText('Desconectado');
    await expect(row(page, name).getByTestId('channel-reason')).toHaveText(
      'Lo desconectó una persona del equipo.',
    );

    // Reconectar: QR nuevo para el mismo canal; el mismo teléfono lo vuelve a conectar.
    await row(page, name).getByTestId('reconnect').click();
    await expect(dialog.getByTestId('qr-image')).toBeVisible();
    await sessionStatus(request, id, 'WORKING', phone);
    await expect(dialog.getByTestId('pairing-status')).toContainText('¡Conectado!', { timeout: LIVE_MS });
    await dialog.getByTestId('pairing-done').click();
    await expect(row(page, name).getByTestId('channel-status')).toHaveText('Conectado');
    expect(await row(page, name).getAttribute('data-channel-id')).toBe(id);

    // Queda desconectado: no ocupa lugar en el tope de sesiones abiertas.
    await row(page, name).getByTestId('disconnect').click();
    await page.getByRole('alertdialog').getByTestId('confirm').click();
    await expect(row(page, name).getByTestId('channel-status')).toHaveText('Desconectado');
  });

  test('el estado cambia en la lista sin recargar, con el diálogo cerrado', async ({ page, request }) => {
    await openChannels(page);
    const name = `e2e ${uid()}`;
    const id = await createChannel(page, name);
    await page.getByRole('dialog').getByRole('button', { name: 'Cerrar' }).click();
    await expect(row(page, name).getByTestId('channel-status')).toHaveText('Esperando el escaneo');

    // Otro teléfono escanea con un número ya conectado en la empresa: se explica en la fila.
    const principal = (await row(page, 'ventas-principal').getByTestId('channel-phone').textContent())?.match(
      /\+(\d+)/,
    )?.[1];
    expect(principal).toBeTruthy();
    await sessionStatus(request, id, 'WORKING', principal!);
    await expect(row(page, name).getByTestId('channel-status')).toHaveText('Desconectado', {
      timeout: LIVE_MS,
    });
    await expect(row(page, name).getByTestId('channel-reason')).toHaveText(
      'Ese número ya está conectado en el canal «ventas-principal».',
    );

    // Nunca se conectó: se puede cancelar (con confirmación) y desaparece.
    await row(page, name).getByTestId('cancel-channel').click();
    await page.getByRole('alertdialog').getByTestId('confirm').click();
    await expect(row(page, name)).toHaveCount(0);
  });

  test('QR vencido: se pide uno nuevo desde el diálogo', async ({ page, request }) => {
    await openChannels(page);
    const name = `e2e ${uid()}`;
    const id = await createChannel(page, name);
    const dialog = page.getByRole('dialog');

    await sessionStatus(request, id, 'FAILED');
    await expect(dialog.getByTestId('pairing-status')).toContainText('El código QR venció', {
      timeout: LIVE_MS,
    });
    await dialog.getByTestId('renew-qr').click();
    await expect(dialog.getByTestId('qr-image')).toBeVisible();
    await expect(dialog.getByTestId('pairing-status')).toContainText('Esperando el escaneo');

    await dialog.getByRole('button', { name: 'Cerrar' }).click();
    await row(page, name).getByTestId('cancel-channel').click();
    await page.getByRole('alertdialog').getByTestId('confirm').click();
    await expect(row(page, name)).toHaveCount(0);
  });

  test('un seller no ve Números en el menú ni llega por URL', async ({ page }) => {
    await loginAs(page, 'vendedor.sin.numeros@example.test');
    await expectInLayout(page, 'Cerámicos Demo');
    await expect(
      page.getByRole('navigation', { name: 'Secciones' }).getByRole('link', { name: 'Números', exact: true }),
    ).toHaveCount(0);
    await page.goto('/numeros');
    await expect(page).toHaveURL(/\/sin-acceso/);
    await expect(page.getByTestId('connect-new')).toHaveCount(0);
  });
});
