import { inject } from '@angular/core';
import { AuthService } from '../../core/auth/auth.service';
import { InboxSummary } from '../../core/inbox-summary';
import { can } from '../../core/nav';
import { pollWhileNoRealtime } from '../../core/poll';
import { RealtimeService, onInboxChanges } from '../../core/realtime';

export { LiveIndicator } from '../../ui/live-indicator';

/**
 * Arranca el tiempo real (tarea 025) mientras está el layout, si el rol ve conversaciones (la API igual
 * responde 403), y recarga con los cambios el número de derivadas sin atender del menú (juntados por 1 s;
 * cada 30 s si no hay tiempo real). El layout carga este archivo con import() después del primer render:
 * así el servicio y el indicador no suman al bundle inicial. Contexto de inyección (el del layout).
 */
export function bootRealtime(): void {
  if (!can(inject(AuthService).role(), { conversation: ['read'] })) return;
  inject(RealtimeService).start();
  const summary = inject(InboxSummary);
  onInboxChanges((changes) => {
    if (changes.resync || [...changes.types].some((type) => type !== 'conversation.read')) summary.refresh();
  }, 1_000);
  pollWhileNoRealtime(() => summary.refresh());
}
