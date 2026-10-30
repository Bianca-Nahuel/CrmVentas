import { expect, type Page } from '@playwright/test';

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
