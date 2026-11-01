// Verificación de la tarea 014 contra la API real con el seed (npm run db:seed lo deja como al principio:
// este archivo reactiva la IA en una conversación del seed).
import { expect, request, test, type Page } from '@playwright/test';
import { SEED_PASSWORD, USERS, expectInLayout, login } from './helpers';

const ORIGIN = 'http://localhost:4200';

async function loginSellerCeramicos(page: Page) {
  await login(page, USERS.multi);
  await page.getByRole('button', { name: /Cerámicos Demo/ }).click();
  await expectInLayout(page, 'Cerámicos Demo');
}

/** Id de una conversación del seed, pedido como el owner (otra sesión, por la API). */
async function conversationIdAsOwner(name: string): Promise<string> {
  const api = await request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { Origin: ORIGIN } });
  await api.post('/api/auth/sign-in/email', {
    data: { email: USERS.ownerCeramicos, password: SEED_PASSWORD },
  });
  const tenants = (await (await api.get('/api/me/tenants')).json()) as { id: string; slug: string }[];
  const tenant = tenants.find((t) => t.slug === 'ceramicos-demo')!;
  await api.post('/api/auth/organization/set-active', { data: { organizationId: tenant.id } });
  const leads = (await (await api.get(`/api/leads?q=${encodeURIComponent(name)}`)).json()) as {
    items: { id: string }[];
  };
  await api.dispose();
  return leads.items[0]!.id;
}

test.describe('grilla de leads', () => {
  test('el owner ordena por puntaje y filtra por nivel; la URL refleja el estado', async ({ page }) => {
    await login(page, USERS.ownerCeramicos);
    await expectInLayout(page, 'Cerámicos Demo');
    await page.getByRole('link', { name: /^Leads/ }).click();
    await expect(page.getByRole('heading', { name: 'Leads' })).toBeVisible();

    await page.getByRole('button', { name: /Puntaje/ }).click();
    await expect(page).toHaveURL(/sort=score/);
    await expect(page.getByRole('columnheader', { name: /Puntaje/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    const scores = await page
      .getByTestId('lead-row')
      .getByRole('meter')
      .evaluateAll((els) => els.map((el) => Number(el.getAttribute('aria-valuenow'))));
    expect(scores).toEqual([...scores].sort((a, b) => b - a));

    await page.getByLabel('Nivel').selectOption('hot');
    await expect(page).toHaveURL(/tier=hot/);
    await expect(page.getByTestId('lead-row').first()).toBeVisible();
    for (const row of await page.getByTestId('lead-row').all()) await expect(row).toContainText('Caliente');

    // Volver a entrar con la URL restaura el estado.
    await page.reload();
    await expect(page.getByLabel('Nivel')).toHaveValue('hot');
    await expect(page.getByRole('columnheader', { name: /Puntaje/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  test('búsqueda con espera: el término queda en la URL', async ({ page }) => {
    await login(page, USERS.ownerCeramicos);
    await expectInLayout(page, 'Cerámicos Demo');
    await page.goto('/leads');
    await page.getByLabel('Buscar por nombre o número').fill('Gómez');
    await expect(page).toHaveURL(/q=G%C3%B3mez/);
    await expect(page.getByTestId('lead-row')).toHaveCount(1);
    await expect(page.getByTestId('lead-row')).toContainText('Ana Gómez');
  });

  test('un clic en cualquier parte de la fila abre la conversación', async ({ page }) => {
    await login(page, USERS.ownerCeramicos);
    await expectInLayout(page, 'Cerámicos Demo');
    await page.goto('/leads');
    await page.getByTestId('lead-row').filter({ hasText: 'Ana Gómez' }).getByText('ventas-principal').click();
    await expect(page).toHaveURL(/\/conversaciones\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('conversation-title')).toHaveText('Ana Gómez');
  });

  test('el seller ve solo las conversaciones de su número', async ({ page }) => {
    await loginSellerCeramicos(page);
    await page.goto('/leads');
    await expect(page.getByTestId('lead-row').filter({ hasText: 'Ana Gómez' })).toBeVisible();
    await expect(page.getByTestId('lead-row').filter({ hasText: 'Lucas Romero' })).toHaveCount(0);
    await expect(page.getByTestId('lead-row').filter({ hasText: 'Sofía Herrera' })).toHaveCount(0);
    // Sin la sección de números y vendedores.
    await expect(page.getByRole('link', { name: 'Números y vendedores' })).toHaveCount(0);
  });

  test('un seller sin números ve el estado vacío', async ({ page }) => {
    await login(page, 'vendedor.sin.numeros@example.test');
    await expectInLayout(page, 'Cerámicos Demo');
    await page.goto('/leads');
    await expect(page.getByTestId('leads-empty')).toContainText('Todavía no tenés números asignados.');
  });

  test('el viewer no entra a Leads ni a Conversaciones', async ({ page }) => {
    await login(page, USERS.multi);
    await page.getByRole('button', { name: /Inmobiliaria Demo/ }).click();
    await expectInLayout(page, 'Inmobiliaria Demo');
    for (const path of ['/leads', '/conversaciones']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'No tenés acceso' })).toBeVisible();
    }
  });
});

test.describe('bandeja', () => {
  test('arriba la que espera a una persona; al abrirla deja de estar "sin ver"; filtros', async ({
    page,
  }) => {
    await login(page, USERS.ownerCeramicos);
    await expectInLayout(page, 'Cerámicos Demo');
    await page.goto('/conversaciones');
    // Marta Díaz: una persona del equipo le escribió y el cliente contestó → antes que Ana (más caliente,
    // pero nadie del equipo le escribió todavía).
    await expect(page.getByTestId('inbox-item').first()).toBeVisible();
    const names = await page.getByTestId('inbox-item').allTextContents();
    const marta = names.findIndex((text) => text.includes('Marta Díaz'));
    expect(marta).toBeGreaterThanOrEqual(0);
    expect(marta).toBeLessThan(names.findIndex((text) => text.includes('Ana Gómez')));
    await expect(
      page.getByTestId('inbox-item').filter({ hasText: 'Marta Díaz' }).getByTestId('waiting'),
    ).toContainText('Espera respuesta hace');

    const juan = page.getByTestId('inbox-item').filter({ hasText: 'Juan Pérez' });
    await expect(juan.getByTestId('unread-dot')).toBeVisible();
    await juan.click();
    await expect(page.getByTestId('conversation-title')).toHaveText('Juan Pérez');
    await expect(juan.getByTestId('unread-dot')).toHaveCount(0);

    await page.getByRole('button', { name: 'Sin ver' }).click();
    await expect(page.getByRole('button', { name: 'Sin ver' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('inbox-item').filter({ hasText: 'Juan Pérez' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sin responder' }).click();
    for (const item of await page.getByTestId('inbox-item').all()) {
      await expect(item.getByTestId('waiting')).toBeVisible();
    }
  });
});

test.describe('conversación', () => {
  test('con la URL de una conversación ajena, el seller termina en "no encontrada"', async ({ page }) => {
    const id = await conversationIdAsOwner('Lucas Romero');
    await loginSellerCeramicos(page);
    await page.goto(`/conversaciones/${id}`);
    await expect(page.getByTestId('conversation-not-found')).toContainText('Conversación no encontrada');
  });

  test('derivada: el resumen se ve marcado como no verificado, con motivo y datos', async ({ page }) => {
    await loginSellerCeramicos(page);
    await page.goto('/conversaciones');
    await page.getByTestId('inbox-item').filter({ hasText: 'Ana Gómez' }).click();
    await expect(page.getByTestId('conversation-title')).toHaveText('Ana Gómez');
    const panel = page.getByTestId('handoff-panel');
    await expect(panel).toContainText('Resumen automático, no verificado');
    await expect(page.getByTestId('handoff-reason')).toHaveText('Pidió hablar con una persona');
    await expect(page.getByTestId('handoff-summary')).toContainText('porcelanato 60x60');
    await expect(page.getByRole('log', { name: 'Mensajes' })).toContainText('Puedo hablar con alguien?');
  });

  test('un mensaje con HTML y *formato* se ve literal, sin imágenes ni links', async ({ page }) => {
    let dialogs = 0;
    page.on('dialog', (dialog) => {
      dialogs++;
      void dialog.dismiss();
    });
    await login(page, USERS.ownerCeramicos);
    await expectInLayout(page, 'Cerámicos Demo');
    await page.goto(`/conversaciones/${await conversationIdAsOwner('Prueba')}`);
    const bubble = page.getByTestId('message').filter({ hasText: 'onerror' });
    await expect(bubble.getByTestId('message-body')).toHaveText(
      '<img src=x onerror=alert(1)> y *negrita* https://example.test',
    );
    await expect(bubble.locator('img, a, b, strong')).toHaveCount(0);
    await expect(page.getByTestId('conversation-title')).toHaveText('Prueba <b>HTML</b>');
    expect(dialogs).toBe(0);
  });

  test('reactivar la IA desde la conversación (con confirmación)', async ({ page }) => {
    await login(page, USERS.ownerCeramicos);
    await expectInLayout(page, 'Cerámicos Demo');
    await page.goto(`/conversaciones/${await conversationIdAsOwner('Sofía Herrera')}`);
    await expect(page.getByTestId('ai-state')).toContainText('Derivada a una persona');

    await page.getByRole('button', { name: 'Volver a activar la IA' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('La IA va a volver a responder en esta conversación');
    await dialog.getByRole('button', { name: 'Volver a activar' }).click();

    await expect(page.getByTestId('ai-state')).toContainText('IA activa');
    await expect(page.getByRole('button', { name: 'Volver a activar la IA' })).toHaveCount(0);
    await expect(page.getByText(/IA reactivada por Owner Cerámicos/)).toBeVisible();
  });
});

test.describe('números y vendedores', () => {
  test('el owner ve los números con sus vendedores y asigna con el selector', async ({ page }) => {
    await login(page, USERS.ownerCeramicos);
    await expectInLayout(page, 'Cerámicos Demo');
    await page.getByRole('link', { name: 'Números y vendedores' }).click();
    const principal = page.getByTestId('channel-card').filter({ hasText: 'ventas-principal' });
    await expect(principal).toContainText('Usuario Dos Empresas');

    const sucursal = page.getByTestId('channel-card').filter({ hasText: 'sucursal-norte' });
    await sucursal.getByRole('button', { name: 'Asignar vendedores' }).click();
    const listbox = page.getByRole('listbox');
    await listbox.getByRole('option', { name: /Vendedor Sin Números/ }).click();
    await expect(listbox.getByRole('option', { name: /Vendedor Sin Números/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByTestId('save-sellers').click();
    await expect(sucursal).toContainText('Vendedor Sin Números');

    // Se quita con el botón de la etiqueta (deja el seed como estaba).
    await sucursal.getByRole('button', { name: 'Quitar a Vendedor Sin Números de sucursal-norte' }).click();
    await expect(sucursal).toContainText('Sin vendedores asignados.');
  });
});
