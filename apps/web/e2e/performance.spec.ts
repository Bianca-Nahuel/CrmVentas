// Verificación de la tarea 026 contra la API real con el seed: cerrar desde el detalle y desde la grilla,
// filtros de Rendimiento en la URL, una revisión con las citas resaltadas (y un mensaje con HTML que se ve
// como texto) y el viewer solo con los totales. Los entrantes se simulan con el webhook firmado.
import { expect, test, type Page } from '@playwright/test';
import { USERS, expectInLayout, inbound, login, randomPhone, uid } from './helpers';

async function loginOwner(page: Page) {
  await login(page, USERS.ownerCeramicos);
  await expectInLayout(page, 'Cerámicos Demo');
}

/** Un lead nuevo (entrante simulado) y su id, buscado por nombre con la sesión de la página. */
async function newLead(page: Page): Promise<{ id: string; name: string }> {
  const name = `Cierre ${uid()}`;
  await inbound(page.request, randomPhone(), 'Hola, quería consultar por porcelanato', name);
  let id: string | undefined;
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/leads?q=${encodeURIComponent(name)}`);
      id = ((await response.json()) as { items: { id: string }[] }).items[0]?.id;
      return id;
    })
    .toBeTruthy();
  return { id: id!, name };
}

test.describe('cerrar conversaciones', () => {
  test('desde el detalle: resultado y nota; sale de la grilla y aparece en "Cerradas"', async ({ page }) => {
    await loginOwner(page);
    const lead = await newLead(page);
    await page.goto(`/conversaciones/${lead.id}`);
    await page.getByTestId('close-conversation').click();
    const dialog = page.getByRole('dialog', { name: 'Cerrar conversación' });
    await expect(dialog).toBeVisible();
    // Sin resultado no cierra.
    await dialog.getByTestId('close-confirm').click();
    await expect(dialog.getByRole('alert')).toHaveText('Elegí cómo terminó.');
    await dialog.getByTestId('outcome-sold').check();
    await dialog.getByTestId('close-note').fill('Se llevó 30 m²');
    await dialog.getByTestId('close-confirm').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Conversación cerrada: vendida.')).toBeVisible();
    await expect(page.getByTestId('closed-state')).toHaveText(/Cerrada · Vendida/);
    await expect(page.getByTestId('closed-panel')).toContainText('Se llevó 30 m²');
    // Cerrada: sin caja de respuesta ni botón de cerrar.
    await expect(page.getByTestId('close-conversation')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: /Respuesta/ })).toHaveCount(0);

    await page.goto(`/leads?q=${encodeURIComponent(lead.name)}`);
    await expect(page.getByTestId('leads-empty')).toBeVisible();
    await page.getByLabel('Estado').selectOption('closed');
    await expect(page).toHaveURL(/status=closed/);
    await expect(page.getByTestId('lead-row').filter({ hasText: lead.name })).toContainText(
      'Cerrada · Vendida',
    );
  });

  test('desde la fila de la grilla', async ({ page }) => {
    await loginOwner(page);
    const lead = await newLead(page);
    await page.goto(`/leads?q=${encodeURIComponent(lead.name)}`);
    const row = page.getByTestId('lead-row').filter({ hasText: lead.name });
    await row.getByTestId('row-close').click();
    const dialog = page.getByRole('dialog', { name: 'Cerrar conversación' });
    await dialog.getByTestId('outcome-not_a_lead').check();
    await dialog.getByTestId('close-confirm').click();
    await expect(row).toHaveCount(0);
    // La URL no cambió: seguimos en la grilla.
    await expect(page).toHaveURL(/\/leads/);
  });

  test('en la bandeja, el filtro "Cerradas" las muestra', async ({ page }) => {
    await loginOwner(page);
    await page.goto('/conversaciones');
    await page.getByRole('button', { name: 'Cerradas' }).click();
    await expect(page.getByRole('button', { name: 'Cerradas' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText(/Historial \d-\d/).first()).toBeVisible();
  });
});

test.describe('Rendimiento', () => {
  test('el owner filtra por semanas y número; los filtros quedan en la URL', async ({ page }) => {
    await loginOwner(page);
    await page.getByRole('link', { name: 'Rendimiento' }).click();
    await expect(page.getByRole('heading', { name: 'Rendimiento', level: 1 })).toBeVisible();
    await expect(page.getByTestId('channel-card').first()).toBeVisible();
    // Sin un número elegido no hay gráfico de tiempo de respuesta.
    await expect(page.getByText('Elegí un número para ver el tiempo de respuesta por semana.')).toBeVisible();

    await page.getByLabel('Semanas', { exact: true }).selectOption('4');
    await expect(page).toHaveURL(/weeks=4/);
    await page.getByLabel('Número', { exact: true }).selectOption({ label: 'ventas-principal' });
    await expect(page).toHaveURL(/channel=/);
    await expect(page.getByTestId('channel-card')).toHaveCount(1);
    await expect(
      page.getByText('Primera respuesta después de derivar (horario de atención)', { exact: true }),
    ).toBeVisible();

    // El gráfico tiene su tabla equivalente.
    await page.getByRole('button', { name: 'Ver como tabla' }).first().click();
    await expect(page.getByRole('table').filter({ hasText: 'Atendidas' }).first()).toBeVisible();

    // Recargar conserva los filtros.
    await page.reload();
    await expect(page.getByLabel('Semanas', { exact: true })).toHaveValue('4');
    await expect(page.getByTestId('channel-card')).toHaveCount(1);
  });

  test('revisión con las citas resaltadas; el HTML de un mensaje se ve como texto', async ({ page }) => {
    await loginOwner(page);
    await page.goto('/rendimiento');
    const first = page.getByTestId('review-row').first();
    await expect(first).toBeVisible();
    await first.click();
    await expect(page).toHaveURL(/\/rendimiento\/revisiones\//);
    await expect(page.getByTestId('review-panel')).toBeVisible();
    await expect(page.getByTestId('quote-mark').first()).toBeVisible();
    // El mensaje con <img …> es texto: no hay ninguna imagen dentro de la conversación.
    const html = page.getByTestId('review-message-body').filter({ hasText: '<img src=x onerror=alert(1)>' });
    await expect(html).toHaveCount(1);
    await expect(page.getByRole('log').locator('img')).toHaveCount(0);
    await expect(html.getByTestId('quote-mark')).toHaveText('gracias por todo');
  });

  test('el viewer ve solo los totales por número', async ({ page }) => {
    await login(page, USERS.multi);
    await page.getByRole('button', { name: /Inmobiliaria Demo/ }).click();
    await expect(page).toHaveURL('/rendimiento');
    await expect(page.getByTestId('channel-card').first()).toBeVisible();
    await expect(page.getByLabel('Vendedor')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Revisiones de calidad' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /Por vendedor/ })).toHaveCount(0);
  });
});
