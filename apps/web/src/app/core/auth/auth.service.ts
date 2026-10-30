import { DOCUMENT } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ME_ERROR_CODES, type MeContext, type MeTenantOption } from '@ventas/shared/auth';
import { firstValueFrom } from 'rxjs';
import { skipApiErrorHandling as quiet } from '../http/http-context';
import { AUTH_CLIENT } from './auth-client';

/**
 * Estado de la sesión del panel:
 *  unknown   → todavía no se consultó /api/me/context
 *  anonymous → sin sesión (401)
 *  no-tenant → con sesión pero sin empresa activa
 *  ready     → con empresa activa y membresía activa
 *  forbidden → membresía desactivada o empresa suspendida (403)
 *  offline   → no se pudo hablar con la API
 */
export type AuthStatus = 'unknown' | 'anonymous' | 'no-tenant' | 'ready' | 'forbidden' | 'offline';

export type SignInResult = { ok: true } | { ok: false; message: string };

// Siempre el mismo texto: no revela si el email existe.
export const INVALID_CREDENTIALS = 'Email o contraseña incorrectos.';
const TOO_MANY_ATTEMPTS = 'Demasiados intentos. Esperá unos segundos y probá de nuevo.';
const GENERIC_ERROR = 'No pudimos iniciar sesión. Probá de nuevo en un momento.';

/** La sesión vive solo en la cookie HttpOnly: acá hay datos para mostrar, nunca tokens. */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly client = inject(AUTH_CLIENT);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);

  readonly status = signal<AuthStatus>('unknown');
  readonly context = signal<MeContext | null>(null);
  readonly tenants = signal<MeTenantOption[]>([]);

  readonly user = computed(() => this.context()?.user ?? null);
  readonly tenant = computed(() => this.context()?.tenant ?? null);
  readonly role = computed(() => this.context()?.role ?? null);

  private loading: Promise<AuthStatus> | null = null;

  /** Carga el contexto una vez (lo usan los guards al arrancar). */
  ensureLoaded(): Promise<AuthStatus> {
    if (this.status() !== 'unknown' && this.status() !== 'offline') return Promise.resolve(this.status());
    return this.load();
  }

  /** GET /api/me/context. Los errores se interpretan acá (el interceptor no redirige este pedido). */
  load(): Promise<AuthStatus> {
    this.loading ??= this.fetchContext().finally(() => (this.loading = null));
    return this.loading;
  }

  private async fetchContext(): Promise<AuthStatus> {
    try {
      const context = await firstValueFrom(this.http.get<MeContext>('/api/me/context', quiet()));
      this.context.set({ user: context.user, tenant: context.tenant, role: context.role });
      return this.setStatus('ready');
    } catch (error) {
      this.context.set(null);
      return this.setStatus(statusFromError(error));
    }
  }

  /** Empresas que puede elegir (membresía activa en empresa activa). */
  async loadTenants(): Promise<MeTenantOption[]> {
    const tenants = await firstValueFrom(this.http.get<MeTenantOption[]>('/api/me/tenants', quiet()));
    this.tenants.set(tenants);
    return tenants;
  }

  async signIn(email: string, password: string): Promise<SignInResult> {
    let result: Awaited<ReturnType<typeof this.client.signIn.email>>;
    try {
      result = await this.client.signIn.email({ email, password });
    } catch {
      return { ok: false, message: GENERIC_ERROR };
    }
    if (result.error) {
      const status = result.error.status;
      if (status === 401 || status === 400) return { ok: false, message: INVALID_CREDENTIALS };
      if (status === 429) return { ok: false, message: TOO_MANY_ATTEMPTS };
      return { ok: false, message: GENERIC_ERROR };
    }
    this.reset();
    await this.load();
    return { ok: true };
  }

  /**
   * Después del login sin empresa activa: con una sola empresa la activa sola; con varias hay que elegir.
   * Devuelve adónde ir.
   */
  async resolveTenant(): Promise<'ready' | 'choose' | 'forbidden'> {
    if (this.status() === 'ready') return 'ready';
    if (this.status() !== 'no-tenant') return 'forbidden';
    const tenants = await this.loadTenants();
    if (tenants.length === 0) return 'forbidden';
    if (tenants.length > 1) return 'choose';
    return (await this.activateTenant(tenants[0]!.id)) ? 'ready' : 'forbidden';
  }

  /** Activa una empresa en la sesión y recarga el contexto (sin estado previo: recién entró). */
  async activateTenant(tenantId: string): Promise<boolean> {
    const result = await this.client.organization.setActive({ organizationId: tenantId });
    if (result.error) return false;
    return (await this.load()) === 'ready';
  }

  /**
   * Cambio de empresa desde el panel: activa la otra y recarga la página entera, así no queda nada en
   * memoria de la empresa anterior (listas, filtros, cachés).
   */
  async switchTenant(tenantId: string): Promise<boolean> {
    if (tenantId === this.tenant()?.id) return true;
    const result = await this.client.organization.setActive({ organizationId: tenantId });
    if (result.error) return false;
    this.reset();
    this.document.location.assign('/');
    return true;
  }

  async signOut(): Promise<void> {
    try {
      await this.client.signOut();
    } finally {
      this.reset();
      this.status.set('anonymous');
      await this.router.navigateByUrl('/ingresar', { replaceUrl: true });
    }
  }

  /** Olvida todo lo de la sesión (lo llama también el interceptor ante un 401). */
  reset() {
    this.context.set(null);
    this.tenants.set([]);
    this.status.set('unknown');
  }

  private setStatus(status: AuthStatus): AuthStatus {
    this.status.set(status);
    return status;
  }
}

function statusFromError(error: unknown): AuthStatus {
  if (!(error instanceof HttpErrorResponse)) return 'offline';
  if (error.status === 401) return 'anonymous';
  if (error.status === 403) {
    const code = (error.error as { code?: unknown } | null)?.code;
    return code === ME_ERROR_CODES.noActiveTenant ? 'no-tenant' : 'forbidden';
  }
  return 'offline';
}
