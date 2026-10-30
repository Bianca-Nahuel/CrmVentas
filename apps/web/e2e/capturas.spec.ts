// Capturas de cada pantalla en claro y oscuro, a 375 px (celular) y 1280 px (escritorio).
// Se guardan en test-results/capturas/ (fuera de git). Correr con: npm run e2e:web -- capturas
import { expect, test, type Page } from '@playwright/test';
import { USERS, expectInLayout, login } from './helpers';

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

      test('sistema de diseño', async ({ page }) => {
        await page.goto('/dev/diseno');
        await expect(page.getByRole('heading', { name: 'Sistema de diseño' })).toBeVisible();
        await shot(page, '08-diseno', true);
      });
    });
  }
}
