// Verificación de la tarea 023 contra la API real (seed cargado), a través del proxy de Angular.
import { expect, request, test } from '@playwright/test';
import { USERS, expectInLayout, login, navLinks } from './helpers';

test.describe('login y empresa activa', () => {
  test('1. owner de cerámicos entra al layout con el nombre de la empresa', async ({ page }) => {
    await login(page, USERS.ownerCeramicos);
    await expect(page).toHaveURL('/conversaciones');
    await expectInLayout(page, 'Cerámicos Demo');
    // Leads puede llevar el número de derivadas sin atender (tarea 014).
    await expect(navLinks(page)).toHaveText([
      'Conversaciones',
      /^Leads/,
      'Canales',
      'Números y vendedores',
      'Catálogo',
      'Configuración del agente',
      'Consumo',
      'Métricas',
    ]);
    await expect(page).toHaveTitle('Conversaciones · Panel');
  });

  test('2. usuario de dos empresas elige una y cambia a la otra', async ({ page }) => {
    await login(page, USERS.multi);
    await expect(page).toHaveURL('/elegir-empresa');
    await page.getByRole('button', { name: /Cerámicos Demo/ }).click();
    await expectInLayout(page, 'Cerámicos Demo');
    const before = await page.request.get('/api/me/context');
    expect((await before.json()).tenant.name).toBe('Cerámicos Demo');

    await page.getByTestId('tenant-switcher').click();
    await page.getByRole('menuitemradio', { name: /Inmobiliaria Demo/ }).click();
    await expectInLayout(page, 'Inmobiliaria Demo');
    // En Inmobiliaria es viewer: entra a Métricas, la única sección que puede ver.
    await expect(page).toHaveURL('/metricas');
    const after = await page.request.get('/api/me/context');
    const body = await after.json();
    expect(body.tenant.name).toBe('Inmobiliaria Demo');
    expect(body.role).toBe('viewer');
  });

  test('3. contraseña incorrecta y email inexistente dan el mismo mensaje', async ({ page }) => {
    await login(page, USERS.ownerCeramicos, 'contraseña-incorrecta');
    const error = page.getByTestId('login-error');
    await expect(error).toHaveText('Email o contraseña incorrectos.');
    const first = await error.textContent();

    await login(page, 'no-existe@example.test', 'cualquier-cosa-123');
    await expect(error).toHaveText(first ?? '');
    await expect(page).toHaveURL(/\/ingresar/);
  });

  test('4. logout: volver atrás no muestra contenido y la cookie vieja da 401', async ({ page, context }) => {
    await login(page, USERS.ownerCeramicos);
    await expectInLayout(page, 'Cerámicos Demo');
    // Una segunda sección deja una página protegida en el historial (/conversaciones).
    await page.getByRole('link', { name: 'Leads' }).click();
    await expect(page).toHaveURL('/leads');
    const oldCookies = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');

    await page.getByTestId('user-menu').click();
    await page.getByRole('menuitem', { name: 'Cerrar sesión' }).click();
    await expect(page).toHaveURL('/ingresar');

    // Atrás vuelve a /conversaciones, pero el guard lo manda al login sin mostrar el panel.
    await page.goBack();
    await expect(page).toHaveURL(/\/ingresar/);
    await expect(page.getByTestId('tenant-name')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Ingresá a tu cuenta' })).toBeVisible();

    const api = await request.newContext({ baseURL: 'http://localhost:4200' });
    const res = await api.get('/api/me/context', { headers: { Cookie: oldCookies } });
    expect(res.status()).toBe(401);
    await api.dispose();
  });

  test('5. membresía desactivada → sin acceso', async ({ page }) => {
    await login(page, USERS.baja);
    await expect(page).toHaveURL('/sin-acceso');
    await expect(page.getByRole('heading', { name: 'No tenés acceso' })).toBeVisible();
  });

  test('6. seller no ve Canales, Catálogo, Agente ni Consumo, y la URL a mano da sin acceso', async ({
    page,
  }) => {
    await login(page, USERS.multi);
    await page.getByRole('button', { name: /Cerámicos Demo/ }).click();
    await expectInLayout(page, 'Cerámicos Demo');
    await expect(navLinks(page)).toHaveText(['Conversaciones', /^Leads/]);
    for (const path of ['/canales', '/catalogo', '/agente', '/consumo']) {
      await page.goto(path);
      await expect(page, path).toHaveURL('/sin-acceso');
    }
  });

  test('6b. viewer ve solo Métricas', async ({ page }) => {
    await login(page, USERS.multi);
    await page.getByRole('button', { name: /Inmobiliaria Demo/ }).click();
    await expect(page).toHaveURL('/metricas');
    await expect(navLinks(page)).toHaveText(['Métricas']);
    await page.goto('/leads');
    await expect(page).toHaveURL('/sin-acceso');
  });

  test('7. ?redirect con una URL externa no saca al usuario del panel', async ({ page }) => {
    for (const redirect of ['https://otro-sitio.com', '//otro-sitio.com', '/\\otro-sitio.com']) {
      await page.context().clearCookies();
      await login(
        page,
        USERS.ownerCeramicos,
        undefined,
        `/ingresar?redirect=${encodeURIComponent(redirect)}`,
      );
      await expectInLayout(page, 'Cerámicos Demo');
      expect(new URL(page.url()).origin, redirect).toBe('http://localhost:4200');
    }
    // Y una ruta interna sí se respeta.
    await page.context().clearCookies();
    await login(page, USERS.ownerCeramicos, undefined, '/ingresar?redirect=%2Fleads');
    await expect(page).toHaveURL('/leads');
  });

  test('7b. sin sesión, una ruta protegida manda al login con la ruta interna', async ({ page }) => {
    await page.goto('/leads');
    await expect(page).toHaveURL('/ingresar?redirect=%2Fleads');
  });

  test('8. la sesión vive solo en una cookie HttpOnly; nada en el almacenamiento', async ({
    page,
    context,
  }) => {
    await login(page, USERS.ownerCeramicos);
    await expectInLayout(page, 'Cerámicos Demo');
    const session = (await context.cookies()).find((c) => c.name.includes('session_token'));
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Lax');
    const storage = await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
      cookieVisibleToJs: document.cookie.includes('session_token'),
    }));
    expect(storage.local.filter((key) => key !== 'panel.theme')).toEqual([]);
    expect(storage.session).toEqual([]);
    expect(storage.cookieVisibleToJs).toBe(false);
  });
});

test.describe('origen y registro', () => {
  test('9. un pedido con Origin falso o sin Origin se rechaza; el registro público está cerrado', async () => {
    const api = await request.newContext({ baseURL: 'http://localhost:4200' });
    const credentials = { email: USERS.ownerCeramicos, password: 'x'.repeat(12) };
    const fake = await api.post('/api/auth/sign-in/email', {
      data: credentials,
      headers: { Origin: 'https://malo.example' },
    });
    expect(fake.status()).toBe(403);
    const missing = await api.post('/api/auth/sign-in/email', { data: credentials });
    expect(missing.status()).toBe(403);
    const signUp = await api.post('/api/auth/sign-up/email', {
      data: { email: 'nuevo@example.test', password: 'dev-only-Password-999', name: 'Nuevo' },
      headers: { Origin: 'http://localhost:4200' },
    });
    expect(signUp.status()).toBe(400);
    await api.dispose();
  });
});
