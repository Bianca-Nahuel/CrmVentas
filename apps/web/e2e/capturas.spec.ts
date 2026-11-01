// Capturas de cada pantalla en claro y oscuro, a 375 px (celular) y 1280 px (escritorio).
// Se guardan en test-results/capturas/ (fuera de git). Correr con: npm run e2e:web -- capturas
import { expect, test, type Page } from '@playwright/test';
import { USERS, expectInLayout, inbound, login, randomPhone } from './helpers';

const WIDTHS = [
  { name: '375', width: 375, height: 812 },
  { name: '1280', width: 1280, height: 800 },
] as const;
const THEMES = ['light', 'dark'] as const;
const DIR = 'test-results/capturas';

for (const theme of THEMES) {
  for (const size of WIDTHS) {
    test.describe(`${theme} ${size.name}px`, () => {
      test.use({
        viewport: { width: size.width, height: size.height },
        colorScheme: theme,
        isMobile: size.width < 768,
        hasTouch: size.width < 768,
      });

      const shot = (page: Page, name: string, fullPage = false) =>
        page.screenshot({ path: `${DIR}/${name}-${theme}-${size.name}.png`, fullPage });

      test('login', async ({ page }) => {
        await page.goto('/ingresar');
        await expect(page.getByRole('heading', { name: 'Ingresá a tu cuenta' })).toBeVisible();
        await shot(page, '01-login');
        await page.getByRole('button', { name: 'Ingresar' }).click();
        await page.getByLabel('Email').fill(USERS.ownerCeramicos);
        await page.getByLabel('Contraseña', { exact: true }).fill('incorrecta-123');
        await page.getByRole('button', { name: 'Ingresar' }).click();
        await expect(page.getByTestId('login-error')).toBeVisible();
        await shot(page, '02-login-error');
      });

      test('elegir empresa', async ({ page }) => {
        await login(page, USERS.multi);
        await expect(page.getByRole('heading', { name: 'Elegí una empresa' })).toBeVisible();
        await expect(page.getByRole('button', { name: /Cerámicos Demo/ })).toBeVisible();
        await shot(page, '03-elegir-empresa');
      });

      test('sin acceso', async ({ page }) => {
        await login(page, USERS.baja);
        await expect(page.getByRole('heading', { name: 'No tenés acceso' })).toBeVisible();
        await shot(page, '04-sin-acceso');
      });

      test('layout owner', async ({ page }) => {
        await login(page, USERS.ownerCeramicos);
        await expectInLayout(page, 'Cerámicos Demo');
        await shot(page, '05-layout-owner');
        if (size.width < 1024) {
          await page.getByTestId('open-nav').click();
          await expect(page.getByRole('dialog')).toBeVisible();
          await shot(page, '06-layout-menu-celular');
        } else {
          await page.getByTestId('user-menu').click();
          await expect(page.getByRole('menu')).toBeVisible();
          await shot(page, '06-layout-menu-usuario');
        }
      });

      test('layout seller con selector de empresa', async ({ page }) => {
        await login(page, USERS.multi);
        await page.getByRole('button', { name: /Cerámicos Demo/ }).click();
        await expectInLayout(page, 'Cerámicos Demo');
        await page.getByTestId('tenant-switcher').click();
        await expect(page.getByRole('menu')).toBeVisible();
        await shot(page, '07-layout-seller-selector');
      });

      // Tarea 014: grilla, bandeja, conversación derivada, números y vendedores, y el estado vacío.
      test('leads', async ({ page }) => {
        await login(page, USERS.ownerCeramicos);
        await expectInLayout(page, 'Cerámicos Demo');
        await page.goto('/leads');
        await expect(page.getByText('Ana Gómez').locator('visible=true').first()).toBeVisible();
        await shot(page, '09-leads', true);
      });

      test('bandeja y conversación derivada', async ({ page }) => {
        await login(page, USERS.ownerCeramicos);
        await expectInLayout(page, 'Cerámicos Demo');
        await page.goto('/conversaciones');
        await expect(page.getByTestId('inbox-item').first()).toBeVisible();
        await shot(page, '10-bandeja');
        await page.getByTestId('inbox-item').filter({ hasText: 'Ana Gómez' }).click();
        await expect(page.getByTestId('handoff-panel')).toBeVisible();
        await expect(page.getByTestId('message').first()).toBeVisible();
        await shot(page, '11-conversacion-derivada', size.width < 1024);
        if (size.width < 1024) {
          await page.getByText('Resumen automático, no verificado').click();
          await expect(page.getByTestId('handoff-summary')).toBeVisible();
          await shot(page, '11b-conversacion-resumen-abierto', true);
        }
      });

      test('reactivar la IA (confirmación)', async ({ page }) => {
        await login(page, USERS.ownerCeramicos);
        await expectInLayout(page, 'Cerámicos Demo');
        await page.goto('/conversaciones');
        await page.getByTestId('inbox-item').filter({ hasText: 'Ana Gómez' }).click();
        if (size.width < 1024) await page.getByText('Resumen automático, no verificado').click();
        await page.getByRole('button', { name: 'Volver a activar la IA' }).click();
        await expect(page.getByRole('alertdialog')).toBeVisible();
        await shot(page, '12-reactivar-confirmacion');
        await page.getByRole('alertdialog').getByRole('button', { name: 'Cancelar' }).click();
      });

      test('números y vendedores', async ({ page }) => {
        await login(page, USERS.ownerCeramicos);
        await expectInLayout(page, 'Cerámicos Demo');
        await page.goto('/numeros');
        await expect(page.getByTestId('channel-card').first()).toBeVisible();
        await shot(page, '13-numeros');
        await page.getByRole('button', { name: 'Asignar vendedores' }).first().click();
        await expect(page.getByRole('listbox')).toBeVisible();
        await shot(page, '14-numeros-asignar');
      });

      test('leads: seller sin números', async ({ page }) => {
        await login(page, 'vendedor.sin.numeros@example.test');
        await expectInLayout(page, 'Cerámicos Demo');
        await page.goto('/leads');
        await expect(page.getByTestId('leads-empty')).toBeVisible();
        await shot(page, '15-leads-sin-numeros');
      });

      // Tarea 024: caja de respuesta (con borrador), estados de los mensajes, número pausado y ventana
      // vencida. No se envía nada: el borrador queda escrito para la captura.
      const openConversation = async (page: Page, name: string) => {
        await login(page, USERS.ownerCeramicos);
        await expectInLayout(page, 'Cerámicos Demo');
        await page.goto('/conversaciones');
        await page.getByTestId('inbox-item').filter({ hasText: name }).click();
        await expect(page.getByTestId('conversation-title')).toHaveText(name);
        await expect(page.getByTestId('message').first()).toBeVisible();
      };

      test('responder: caja y estados de los mensajes', async ({ page }) => {
        await openConversation(page, 'Carla Estados');
        await expect(page.getByTestId('delivery').first()).toBeVisible();
        await page
          .getByTestId('reply-input')
          .fill('Sí, te las reservo hasta el viernes.\n¿Te paso el total?');
        await shot(page, '16-responder-estados');
        if (size.width < 1024) await shot(page, '16b-responder-estados-completa', true);
      });

      test('responder: número con los envíos pausados', async ({ page }) => {
        await openConversation(page, 'Sofía Herrera');
        await expect(page.getByTestId('reply-blocked')).toBeVisible();
        await shot(page, '17-responder-numero-pausado');
      });

      test('responder: más de 24 h sin mensajes del cliente', async ({ page }) => {
        await openConversation(page, 'Diego Ventana');
        await expect(page.getByTestId('reply-blocked')).toBeVisible();
        await shot(page, '18-responder-ventana-vencida');
      });

      // Tarea 025: tiempo real. Los entrantes se simulan con el webhook firmado (números ficticios).
      const indicator = (page: Page) => page.getByTestId('live-indicator').locator('visible=true');
      const openLive = async (page: Page, path: string) => {
        await login(page, USERS.ownerCeramicos);
        await expectInLayout(page, 'Cerámicos Demo');
        await page.goto(path);
        await expect(indicator(page)).toHaveAttribute('data-status', 'live');
      };

      test('tiempo real: conversación nueva marcada en la grilla', async ({ page, request }) => {
        await openLive(page, '/leads?sort=last_message&dir=desc');
        await inbound(request, randomPhone(), 'Hola, ¿hacen envíos al interior?', 'Prueba Envíos');
        await expect(page.getByTestId('new-chip').locator('visible=true').first()).toBeVisible();
        await shot(page, '19-tiempo-real-nueva-en-leads');
      });

      test('tiempo real: conversación nueva marcada en la bandeja', async ({ page, request }) => {
        await openLive(page, '/conversaciones');
        // La bandeja ordena por prioridad (lo que más espera, arriba) y muestra 50: una recién llegada puede
        // quedar afuera si los e2e ya sumaron muchas. Se busca su teléfono: la lista arranca vacía y entra.
        const phone = randomPhone();
        await page.getByLabel('Buscar conversación').fill(phone);
        await expect(page.getByTestId('inbox-empty')).toBeVisible();
        await inbound(request, phone, '¿Tienen porcelanato símil madera?', 'Prueba Madera');
        await expect(page.getByTestId('new-chip').first()).toBeVisible();
        await shot(page, '20-tiempo-real-nueva-en-bandeja');
      });

      test('tiempo real: pastilla de nuevas si el usuario no está arriba', async ({ page, request }) => {
        await openLive(page, '/leads?sort=last_message&dir=desc');
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(300);
        await inbound(request, randomPhone(), 'Quiero una cotización', 'Prueba Cotización');
        await expect(page.getByTestId('new-pill')).toBeVisible();
        await shot(page, '21-tiempo-real-pastilla-nuevas');
      });

      test('tiempo real: indicador reconectando, sin conexión y sin tiempo real', async ({
        page,
        context,
      }) => {
        await openLive(page, '/leads');
        await shot(page, '22a-indicador-en-vivo');
        // El stream no responde: reintenta (y, después de varias fallas, pasa al refresco periódico).
        await page.route('**/api/events', (route) => route.abort());
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await expect(indicator(page)).toHaveAttribute('data-status', 'reconnecting');
        await shot(page, '22b-indicador-reconectando');
        await expect(indicator(page)).toHaveAttribute('data-status', 'fallback', { timeout: 20_000 });
        await shot(page, '22c-indicador-sin-tiempo-real');
        await page.unroute('**/api/events');
        await context.setOffline(true);
        await expect(indicator(page)).toHaveAttribute('data-status', 'offline');
        await shot(page, '22d-indicador-sin-conexion');
        await context.setOffline(false);
      });

      test('sistema de diseño', async ({ page }) => {
        await page.goto('/dev/diseno');
        await expect(page.getByRole('heading', { name: 'Sistema de diseño' })).toBeVisible();
        await shot(page, '08-diseno', true);
      });
    });
  }
}
