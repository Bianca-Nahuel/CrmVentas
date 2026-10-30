import { InjectionToken } from '@angular/core';
import { createAuthClient } from 'better-auth/client';
import { organizationClient } from 'better-auth/client/plugins';

// Cliente de Better Auth (la misma versión que la API). Habla con /api/auth del mismo origen: en
// desarrollo pasa por el proxy de Angular; la sesión es solo la cookie HttpOnly, el cliente no guarda
// tokens. Sin registro: la API tiene disableSignUp.
export function createPanelAuthClient() {
  return createAuthClient({
    baseURL: globalThis.location?.origin,
    basePath: '/api/auth',
    plugins: [organizationClient()],
  });
}

export type PanelAuthClient = ReturnType<typeof createPanelAuthClient>;

/** Lo que el panel usa del cliente. Un token para poder reemplazarlo en los tests. */
export interface AuthClientPort {
  signIn: { email: PanelAuthClient['signIn']['email'] };
  signOut: PanelAuthClient['signOut'];
  organization: { setActive: PanelAuthClient['organization']['setActive'] };
}

export const AUTH_CLIENT = new InjectionToken<AuthClientPort>('AUTH_CLIENT', {
  providedIn: 'root',
  factory: createPanelAuthClient,
});
