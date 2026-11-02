import { TestBed } from '@angular/core/testing';
import {
  Router,
  UrlTree,
  provideRouter,
  type ActivatedRouteSnapshot,
  type CanActivateFn,
  type RouterStateSnapshot,
} from '@angular/router';
import type { AuthStatus } from './auth.service';
import { AuthService } from './auth.service';
import { authGuard, guestGuard, homeGuard, permissionGuard, tenantGuard } from './guards';
import { signal } from '@angular/core';
import type { TenantRole } from '@ventas/shared/auth';

class FakeAuth {
  readonly status = signal<AuthStatus>('unknown');
  readonly role = signal<TenantRole | null>(null);
  next: AuthStatus = 'anonymous';
  ensureLoaded = vi.fn(async () => {
    this.status.set(this.next);
    return this.next;
  });
}

describe('guards', () => {
  let auth: FakeAuth;
  let router: Router;

  beforeEach(() => {
    auth = new FakeAuth();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthService, useValue: auth }],
    });
    router = TestBed.inject(Router);
  });

  async function run(guard: CanActivateFn, url = '/leads') {
    const result = await TestBed.runInInjectionContext(() =>
      guard({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot),
    );
    return result instanceof UrlTree ? router.serializeUrl(result) : result;
  }

  describe('authGuard', () => {
    it('sin sesión → login guardando la ruta interna', async () => {
      auth.next = 'anonymous';
      expect(await run(authGuard, '/leads?x=1')).toBe('/ingresar?redirect=%2Fleads%3Fx%3D1');
    });

    it('nunca guarda una URL externa como destino', async () => {
      auth.next = 'anonymous';
      expect(await run(authGuard, '//otro-sitio.com')).toBe('/ingresar');
    });

    it('membresía desactivada: la sesión sigue (puede elegir otra empresa), pero el panel da sin acceso', async () => {
      auth.next = 'forbidden';
      expect(await run(authGuard)).toBe(true);
      expect(await run(tenantGuard)).toBe('/sin-acceso');
    });

    it('con sesión (con o sin empresa) deja pasar', async () => {
      auth.next = 'ready';
      expect(await run(authGuard)).toBe(true);
      auth.next = 'no-tenant';
      expect(await run(authGuard)).toBe(true);
    });
  });

  describe('tenantGuard', () => {
    it('sin empresa activa → elegir empresa', async () => {
      auth.next = 'no-tenant';
      expect(await run(tenantGuard)).toBe('/elegir-empresa');
    });

    it('con empresa activa deja pasar', async () => {
      auth.next = 'ready';
      expect(await run(tenantGuard)).toBe(true);
    });
  });

  describe('permissionGuard (permisos de libs/shared)', () => {
    it('seller no entra a Canales ni a Consumo escribiendo la URL → sin acceso', async () => {
      auth.role.set('seller');
      expect(await run(permissionGuard({ channel: ['read'] }))).toBe('/sin-acceso');
      expect(await run(permissionGuard({ billing: ['read'] }))).toBe('/sin-acceso');
      expect(await run(permissionGuard({ lead: ['read'] }))).toBe(true);
    });

    it('owner entra a Consumo; admin no', async () => {
      auth.role.set('owner');
      expect(await run(permissionGuard({ billing: ['read'] }))).toBe(true);
      auth.role.set('admin');
      expect(await run(permissionGuard({ billing: ['read'] }))).toBe('/sin-acceso');
    });
  });

  describe('homeGuard', () => {
    it('espera el contexto y manda a la primera sección del rol (también después de recargar)', async () => {
      auth.next = 'ready';
      auth.ensureLoaded.mockImplementationOnce(async () => {
        auth.role.set('viewer');
        auth.status.set('ready');
        return 'ready';
      });
      expect(await run(homeGuard, '/')).toBe('/rendimiento');
    });
  });

  describe('guestGuard', () => {
    it('con sesión y empresa, el login redirige al panel', async () => {
      auth.next = 'ready';
      auth.role.set('viewer');
      expect(await run(guestGuard, '/ingresar')).toBe('/rendimiento');
    });

    it('sin sesión muestra el login', async () => {
      auth.next = 'anonymous';
      expect(await run(guestGuard, '/ingresar')).toBe(true);
    });
  });
});
