import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject } from '@angular/core';
import { RealtimeService } from './realtime';

export const POLL_INTERVAL_MS = 30_000;

/**
 * Respaldo del tiempo real (tarea 025): llama a `refresh` cada `intervalMs` solo mientras el tiempo real no
 * logra conectar (RealtimeService.needsPolling: varias fallas seguidas o demasiadas pestañas) y la pestaña
 * está visible. Con el tiempo real andando no hace nada: los cambios llegan por eventos. Se corta al
 * destruirse quien lo llamó. Tiene que llamarse en un contexto de inyección.
 */
export function pollWhileNoRealtime(refresh: () => void, intervalMs = POLL_INTERVAL_MS): void {
  const document = inject(DOCUMENT);
  const realtime = inject(RealtimeService);
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible' && realtime.needsPolling()) refresh();
  }, intervalMs);
  inject(DestroyRef).onDestroy(() => clearInterval(timer));
}
