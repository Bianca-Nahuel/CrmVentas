import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject } from '@angular/core';

export const POLL_INTERVAL_MS = 30_000;

/**
 * Llama a `refresh` cada `intervalMs` mientras la pestaña está visible, y una vez apenas vuelve a verse.
 * Es el refresco provisorio de la bandeja hasta el tiempo real (tarea 025). Se corta al destruirse quien
 * lo llamó. Tiene que llamarse en un contexto de inyección (constructor o inicializador de campo).
 */
export function pollWhileVisible(refresh: () => void, intervalMs = POLL_INTERVAL_MS): void {
  const document = inject(DOCUMENT);
  const visible = () => document.visibilityState === 'visible';
  const timer = setInterval(() => {
    if (visible()) refresh();
  }, intervalMs);
  const onVisibility = () => {
    if (visible()) refresh();
  };
  document.addEventListener('visibilitychange', onVisibility);
  inject(DestroyRef).onDestroy(() => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  });
}
