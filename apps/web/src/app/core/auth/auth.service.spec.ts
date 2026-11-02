import { DOCUMENT } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { MeContext } from '@ventas/shared/auth';
import { AUTH_CLIENT, type AuthClientPort } from './auth-client';
import { AuthService, INVALID_CREDENTIALS } from './auth.service';

export const CONTEXT: MeContext = {
  user: { id: 'u1', name: 'Owner Demo', email: 'owner@example.test', image: null },
  tenant: { id: 't1', name: 'Empresa Uno', slug: 'uno', industry: 'test', timezone: 'UTC' },
  role: 'owner',
};

export function fakeAuthClient() {
  return {
    signIn: { email: vi.fn().mockResolvedValue({ data: {}, error: null }) },
    signOut: vi.fn().mockResolvedValue({ data: {}, error: null }),
    organization: { setActive: vi.fn().mockResolvedValue({ data: {}, error: null }) },
  };
}

describe('AuthService', () => {
  let service: AuthService;
  let http: HttpTestingController;
  let client: ReturnType<typeof fakeAuthClient>;
  const assign = vi.fn();

  beforeEach(() => {
    client = fakeAuthClient();
    assign.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AUTH_CLIENT, useValue: client as unknown as AuthClientPort },
        { provide: DOCUMENT, useFactory: () => withLocation(assign) },
      ],
    });
    service = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function load(respond: (req: ReturnType<HttpTestingController['expectOne']>) => void) {
    const promise = service.load();
    respond(http.expectOne('/api/me/context'));
    return promise;
  }

  it('con contexto queda ready y expone usuario, empresa y rol en signals', async () => {
    expect(await load((req) => req.flush({ ...CONTEXT, db: { currentUser: 'ventas_app' } }))).toBe('ready');
    expect(service.user()?.email).toBe('owner@example.test');
    expect(service.tenant()?.name).toBe('Empresa Uno');
    expect(service.role()).toBe('owner');
    // No guarda lo que no usa (el bloque db de diagnóstico).
    expect(service.context()).toEqual(CONTEXT);
  });

  it('401 → anonymous; 403 NO_ACTIVE_TENANT → no-tenant; otro 403 → forbidden; red → offline', async () => {
    expect(await load((r) => r.flush({}, { status: 401, statusText: 'Unauthorized' }))).toBe('anonymous');
    expect(
      await load((r) => r.flush({ code: 'NO_ACTIVE_TENANT' }, { status: 403, statusText: 'Forbidden' })),
    ).toBe('no-tenant');
    expect(
      await load((r) => r.flush({ code: 'MEMBERSHIP_INACTIVE' }, { status: 403, statusText: 'Forbidden' })),
    ).toBe('forbidden');
    expect(await load((r) => r.error(new ProgressEvent('error')))).toBe('offline');
    expect(service.context()).toBeNull();
  });

  it('ensureLoaded hace un solo pedido aunque lo llamen varios guards a la vez', async () => {
    const both = Promise.all([service.ensureLoaded(), service.ensureLoaded()]);
    http.expectOne('/api/me/context').flush(CONTEXT);
    expect(await both).toEqual(['ready', 'ready']);
    expect(await service.ensureLoaded()).toBe('ready');
    http.expectNone('/api/me/context');
  });

  it('login con error 401 devuelve el mensaje genérico (no revela si el email existe)', async () => {
    client.signIn.email.mockResolvedValue({ data: null, error: { status: 401, message: 'Invalid email' } });
    expect(await service.signIn('nadie@example.test', 'x')).toEqual({
      ok: false,
      message: INVALID_CREDENTIALS,
    });
    client.signIn.email.mockResolvedValue({ data: null, error: { status: 400, message: 'Invalid email' } });
    expect(await service.signIn('mal', 'x')).toEqual({ ok: false, message: INVALID_CREDENTIALS });
  });

  it('login con 429 avisa que espere; con otro error, mensaje genérico', async () => {
    client.signIn.email.mockResolvedValue({ data: null, error: { status: 429 } });
    const tooMany = await service.signIn('a@example.test', 'x');
    expect(tooMany.ok).toBe(false);
    expect(!tooMany.ok && tooMany.message).toMatch(/Demasiados intentos/);
    client.signIn.email.mockRejectedValue(new Error('red'));
    const failed = await service.signIn('a@example.test', 'x');
    expect(!failed.ok && failed.message).toMatch(/No pudimos iniciar sesión/);
  });

  it('login correcto recarga el contexto', async () => {
    const promise = service.signIn('owner@example.test', 'secreta');
    await Promise.resolve();
    await Promise.resolve();
    http.expectOne('/api/me/context').flush(CONTEXT);
    expect(await promise).toEqual({ ok: true });
    expect(client.signIn.email).toHaveBeenCalledWith({ email: 'owner@example.test', password: 'secreta' });
    expect(service.status()).toBe('ready');
  });

  it('resolveTenant con una sola empresa la activa sola; con varias pide elegir', async () => {
    service.status.set('no-tenant');
    const single = service.resolveTenant();
    http.expectOne('/api/me/tenants').flush([{ id: 't1', name: 'Uno', slug: 'uno', role: 'owner' }]);
    await vi.waitFor(() => http.expectOne('/api/me/context').flush(CONTEXT));
    expect(await single).toBe('ready');
    expect(client.organization.setActive).toHaveBeenCalledWith({ organizationId: 't1' });

    service.status.set('no-tenant');
    const many = service.resolveTenant();
    http.expectOne('/api/me/tenants').flush([
      { id: 't1', name: 'Uno', slug: 'uno', role: 'owner' },
      { id: 't2', name: 'Dos', slug: 'dos', role: 'seller' },
    ]);
    expect(await many).toBe('choose');

    service.status.set('no-tenant');
    const none = service.resolveTenant();
    http.expectOne('/api/me/tenants').flush([]);
    expect(await none).toBe('forbidden');
  });

  it('cambiar de empresa activa la otra, limpia el estado y recarga la página entera', async () => {
    await load((req) => req.flush(CONTEXT));
    expect(await service.switchTenant('t2')).toBe(true);
    expect(client.organization.setActive).toHaveBeenCalledWith({ organizationId: 't2' });
    expect(service.context()).toBeNull();
    expect(service.tenants()).toEqual([]);
    expect(assign).toHaveBeenCalledWith('/');
  });

  it('si Better Auth rechaza el cambio de empresa, no recarga', async () => {
    await load((req) => req.flush(CONTEXT));
    client.organization.setActive.mockResolvedValue({ data: null, error: { status: 403 } });
    expect(await service.switchTenant('t2')).toBe(false);
    expect(assign).not.toHaveBeenCalled();
    expect(service.tenant()?.id).toBe('t1');
  });

  it('logout borra la sesión, limpia todo y vuelve al login reemplazando el historial', async () => {
    await load((req) => req.flush(CONTEXT));
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    await service.signOut();
    expect(client.signOut).toHaveBeenCalled();
    expect(service.context()).toBeNull();
    expect(service.status()).toBe('anonymous');
    expect(navigate).toHaveBeenCalledWith('/ingresar', { replaceUrl: true });
  });

  it('nunca guarda nada de la sesión en localStorage ni sessionStorage', async () => {
    localStorage.clear();
    sessionStorage.clear();
    await load((req) => req.flush(CONTEXT));
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

/** document real con location.assign reemplazado (jsdom no navega). */
function withLocation(assign: (url: string) => void): Document {
  const realDocument = document;
  return new Proxy(realDocument, {
    get(target, property) {
      if (property === 'location') return { ...target.location, assign };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
