import { DestroyRef, computed, effect, inject, signal, untracked, type Signal } from '@angular/core';
import type { Observable, Subscription } from 'rxjs';

export interface Query<T> {
  readonly value: Signal<T | undefined>;
  readonly error: Signal<unknown>;
  readonly isLoading: Signal<boolean>;
  /** Falló y no hay nada que mostrar. Si falla un refresco, se sigue viendo lo anterior. */
  readonly loadFailed: Signal<boolean>;
  hasValue(): this is Omit<Query<T>, 'value'> & { readonly value: Signal<T> };
  /** Vuelve a pedir con los mismos parámetros, sin vaciar lo que se ve (refresco). */
  reload(): void;
  set(value: T): void;
  update(fn: (value: T | undefined) => T | undefined): void;
}

/**
 * Carga datos del servidor en signals: pide de nuevo cuando cambian los parámetros (y vacía el valor
 * anterior) y descarta la respuesta vieja si llega una nueva. Reemplaza a rxResource en las páginas: usar
 * resource/linkedSignal en un chunk lazy suma ~15 kB al bundle inicial (comparten módulos de
 * @angular/core con el layout), y effect + RxJS ya están ahí.
 * Tiene que crearse en un contexto de inyección.
 */
export function query<P, T>(params: () => P, load: (params: P) => Observable<T>): Query<T> {
  const value = signal<T | undefined>(undefined);
  const error = signal<unknown>(null);
  const isLoading = signal(false);
  let current: P;
  let subscription: Subscription | undefined;

  const run = (keepValue: boolean) => {
    subscription?.unsubscribe();
    if (!keepValue) value.set(undefined);
    error.set(null);
    isLoading.set(true);
    subscription = load(current).subscribe({
      next: (result) => {
        value.set(result);
        isLoading.set(false);
      },
      error: (cause: unknown) => {
        error.set(cause);
        isLoading.set(false);
      },
    });
  };

  effect(() => {
    current = params();
    untracked(() => run(false));
  });
  inject(DestroyRef).onDestroy(() => subscription?.unsubscribe());

  const hasValue = computed(() => value() !== undefined);
  const loadFailed = computed(() => error() !== null && value() === undefined);
  return {
    value,
    error,
    isLoading,
    loadFailed,
    hasValue: (() => hasValue()) as Query<T>['hasValue'],
    reload: () => run(true),
    set: (next) => value.set(next),
    update: (fn) => value.update(fn),
  };
}
