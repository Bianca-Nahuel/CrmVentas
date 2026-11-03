import { expect, test } from '@playwright/test';
import { expectInLayout, login, loginAs, USERS } from './helpers';

// Embudo de ventas (tarea 028) contra la API real con el seed: seis semanas de caminos en Cerámicos Demo.
// Filtros en la URL, clic en una etapa y en una pérdida → lista de leads → la conversación; el viewer solo ve
// los totales.

async function openFunnel(page: import('@playwright/test').Page, path = '/embudo') {
  await loginAs(page, USERS.ownerCeramicos);
  await expectInLayout(page, 'Cerámicos Demo');
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Embudo', level: 1 })).toBeVisible();
  await expect(page.getByTestId('funnel-bars')).toBeVisible();
}

test.describe('embudo', () => {
  test('el menú lleva al embudo; los filtros quedan en la URL y sobreviven a recargar', async ({ page }) => {
    await loginAs(page, USERS.ownerCeramicos);
    await page.getByRole('navigation', { name: 'Secciones' }).getByRole('link', { name: 'Embudo' }).click();
    await expect(page).toHaveURL('/embudo');
    await expect(page.getByTestId('stage-written')).toContainText('Escribió');
    await expect(page.getByTestId('stage-sold')).toContainText('Vendido');

    await page.getByLabel('Período').selectOption('3m');
    await expect(page).toHaveURL(/period=3m/);
    await page.getByLabel('Número', { exact: true }).selectOption({ label: 'ventas-principal' });
    await expect(page).toHaveURL(/channel=/);
    await page.getByTestId('funnel-exclude-not-a-lead').check();
    await expect(page).toHaveURL(/nla=1/);
    await page.getByLabel('Nivel máximo').selectOption('hot');
    await expect(page).toHaveURL(/tier=hot/);

    await page.reload();
    await expect(page.getByLabel('Período')).toHaveValue('3m');
    await expect(page.getByLabel('Nivel máximo')).toHaveValue('hot');
    await expect(page.getByTestId('funnel-exclude-not-a-lead')).toBeChecked();

    // Un rango propio.
    await page.getByLabel('Período').selectOption('range');
    await expect(page).toHaveURL(/period=range&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
    await expect(page.getByLabel('Desde')).toBeVisible();

    // /metricas (el lugar reservado) lleva al embudo.
    await page.goto('/metricas');
    await expect(page).toHaveURL(/\/embudo/);
  });

  test('clic en una etapa → la lista de esos leads → la conversación', async ({ page }) => {
    await openFunnel(page, '/embudo?period=3m');
    await page.getByTestId('stage-hot').click();
    await expect(page).toHaveURL(/stage=hot/);
    const list = page.getByTestId('funnel-list');
    await expect(list.getByRole('heading', { name: 'Llegaron a «Caliente»' })).toBeVisible();
    await expect(list.getByTestId('lead-row').first()).toBeVisible();
    await expect(page.getByTestId('stage-hot')).toHaveAttribute('aria-pressed', 'true');

    // Otra vez en la misma etapa: se cierra.
    await page.getByTestId('stage-hot').click();
    await expect(page).not.toHaveURL(/stage=/);
    await expect(list).toHaveCount(0);

    // Una pérdida: los que llegaron a caliente y se cerraron sin venta antes de derivar.
    await page.getByTestId('lost-hot').click();
    await expect(page).toHaveURL(/stage=hot&dropped=1/);
    await expect(list.getByRole('heading', { name: 'Se perdieron después de «Caliente»' })).toBeVisible();
    const row = list.getByTestId('lead-row').first();
    await expect(row).toContainText('Cerrada');
    await row.getByRole('link').click();
    await expect(page).toHaveURL(/\/conversaciones\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('conversation-title')).toBeVisible();
  });

  test('por qué se pierden, estancados, montos, atajos y tiempos', async ({ page }) => {
    await openFunnel(page, '/embudo?period=3m');
    await page.getByTestId('losses').getByTestId('outcome-not_sold').click();
    await expect(page).toHaveURL(/outcome=not_sold/);
    await expect(page.getByTestId('funnel-list').getByRole('heading', { name: 'No compró' })).toBeVisible();
    await expect(page.getByTestId('stalled-count')).toHaveText(/^\s*[1-9]\d*\s*$/);
    await expect(page.getByTestId('stalled')).toContainText('Caliente estancado');
    await expect(page.getByTestId('amounts')).toContainText(/Monto cargado en \d+ de \d+ ventas/);
    await expect(page.getByTestId('shortcuts')).toContainText('Vendidos solo con la IA');
    await expect(page.getByTestId('times')).toContainText('Escribió → vendido');
    await expect(page.getByTestId('unanswered').getByRole('link', { name: 'Ver Rendimiento' })).toBeVisible();
    // Las barras también como tabla.
    await page.getByRole('button', { name: 'Ver como tabla' }).first().click();
    await expect(page.getByRole('table').filter({ hasText: 'Pasan a la siguiente' })).toBeVisible();
  });

  test('esta semana con pocas conversaciones avisa que los porcentajes pueden variar', async ({ page }) => {
    await openFunnel(page, '/embudo?period=week');
    await expect(page.getByTestId('low-volume').or(page.getByTestId('funnel-empty'))).toBeVisible();
  });

  test('el viewer ve el embudo, sin listas de leads ni estancados', async ({ page }) => {
    await login(page, USERS.multi);
    await page.getByRole('button', { name: /Inmobiliaria Demo/ }).click();
    await expectInLayout(page, 'Inmobiliaria Demo');
    await page.goto('/embudo');
    await expect(page.getByRole('heading', { name: 'Embudo', level: 1 })).toBeVisible();
    await expect(page.getByTestId('funnel-bars').or(page.getByTestId('funnel-empty'))).toBeVisible();
    await expect(page.getByTestId('stalled')).toHaveCount(0);
    await expect(page.getByLabel('Vendedor')).toHaveCount(0);
    const stage = page.getByTestId('stage-written');
    if (await stage.count()) await expect(stage).toBeDisabled();
  });
});
