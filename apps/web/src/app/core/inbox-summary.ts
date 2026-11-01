import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import type { LeadSummary } from '../api/generated';
import { AuthService } from './auth/auth.service';
import { can } from './nav';

/**
 * Derivadas sin atender (el número del ítem Leads del menú) y números que ve el usuario (el filtro
 * "Número"). Lo refresca el layout cada 30 s mientras la pestaña está visible, y la bandeja al reactivar.
 * Cambiar de empresa recarga la página (decisión #69): no queda el número de otra empresa en memoria.
 * Va en el bundle inicial (lo usa el layout): por eso es un GET simple con el tipo del cliente generado y
 * no carga el resto del cliente (InboxApi va con las páginas, que son lazy).
 */
@Injectable({ providedIn: 'root' })
export class InboxSummary {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly value = signal<LeadSummary | null>(null);

  readonly pendingHandoffs = computed(() => this.value()?.pendingHandoffs ?? 0);
  readonly channels = computed(() => this.value()?.channels ?? []);

  refresh() {
    if (!can(this.auth.role(), { lead: ['read'] })) return;
    this.http.get<LeadSummary>('/api/leads/summary').subscribe({
      next: (summary) => this.value.set(summary),
      // El error ya lo maneja el interceptor (401, 403, sin conexión); el número queda como estaba.
      error: () => undefined,
    });
  }
}
