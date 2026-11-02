import { effect, signal, untracked } from '@angular/core';
import type { Observable, Subscription } from 'rxjs';
import type { Query } from './query';

export interface LiveMergeResult<T> {
  /** La lista que se muestra: el orden que ya tenía, con los datos nuevos. */
  items: T[];
  /** Ids que entraron arriba (se marcan como nuevos). */
  inserted: string[];
  /** Ids que ya estaban y cambiaron (se resaltan un momento). */
  changed: string[];
  /** Ids que trajo el servidor y no se insertaron (la pastilla "↑ N nuevas"). */
  pending: string[];
}

/**
 * Mezcla la lista que el usuario está mirando con una versión nueva del servidor SIN reordenar lo que ve:
 * las filas que ya estaban se actualizan en su lugar; las que no estaban se insertan arriba solo si
 * `insertNew` (primera página y arriba de todo) y, si no, quedan pendientes. Las que el servidor ya no trae
 * (por ejemplo, dejó de estar "Sin responder") se quedan hasta que el usuario reordene.
 */
export function mergeLive<T extends { id: string }>(
  current: readonly T[],
  fresh: readonly T[],
  insertNew: boolean,
): LiveMergeResult<T> {
  const byId = new Map(fresh.map((row) => [row.id, row]));
  const known = new Set(current.map((row) => row.id));
  const changed: string[] = [];
  const kept = current.map((row) => {
    const next = byId.get(row.id);
    if (!next) return row;
    if (JSON.stringify(next) !== JSON.stringify(row)) changed.push(row.id);
    return next;
  });
  const added = fresh.filter((row) => !known.has(row.id));
  return insertNew
    ? { items: [...added, ...kept], inserted: added.map((row) => row.id), changed, pending: [] }
    : { items: kept, inserted: [], changed, pending: added.map((row) => row.id) };
}

/** Cuánto dura el resaltado de una fila que cambió. */
export const FLASH_MS = 2_000;

export interface LiveList {
  /** Filas que entraron con el tiempo real (chip "Nueva") hasta que se reordena o se abren. */
  readonly newIds: () => ReadonlySet<string>;
  /** Filas que acaban de cambiar (resaltado breve). */
  readonly flashIds: () => ReadonlySet<string>;
  /** Cuántas hay en el servidor que no se insertaron para no mover la página. */
  readonly pendingCount: () => number;
  /** Pide de nuevo y mezcla (lo llaman los eventos y la reconexión). */
  refresh(): void;
  /** Muestra el orden real del servidor (pastilla o Actualizar) y limpia las marcas. */
  reorder(): void;
  /** Saca la marca "Nueva" de una fila (se abrió). */
  seen(id: string): void;
}

/**
 * Tiempo real sobre una lista paginada de `query()` (bandeja y Leads). `load` usa los mismos parámetros que
 * la query; si cambian mientras se pedía (otro filtro, otra página), la respuesta vieja se descarta.
 * Tiene que crearse en un contexto de inyección (usa un effect para limpiar las marcas al cambiar los filtros).
 */
export function liveList<P, T extends { id: string }, L extends { items: T[]; total: number }>(
  list: Query<L>,
  params: () => P,
  load: (params: P) => Observable<L>,
  canInsert: () => boolean,
): LiveList {
  const newIds = signal<ReadonlySet<string>>(new Set());
  const flashIds = signal<ReadonlySet<string>>(new Set());
  const pending = signal<ReadonlySet<string>>(new Set());
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  // Un refresco nuevo (o reordenar) cancela el anterior: una respuesta vieja nunca pisa a una más nueva.
  let inFlight: Subscription | undefined;

  const clearMarks = () => {
    newIds.set(new Set());
    pending.set(new Set());
  };
  // Otros filtros u otra página: la query vuelve a cargar sola y las marcas de antes no aplican.
  effect(() => {
    params();
    untracked(clearMarks);
  });

  return {
    newIds,
    flashIds,
    pendingCount: () => pending().size,
    refresh() {
      if (!untracked(() => list.hasValue())) return; // la query todavía está cargando: trae lo último
      const requested = untracked(params);
      const key = JSON.stringify(requested);
      inFlight?.unsubscribe();
      inFlight = load(requested).subscribe({
        next: (fresh) => {
          if (JSON.stringify(untracked(params)) !== key) return;
          const current = untracked(list.value);
          if (!current) return;
          const result = mergeLive(current.items, fresh.items, untracked(canInsert));
          list.set({ ...fresh, items: result.items });
          if (result.inserted.length > 0) newIds.update((ids) => new Set([...ids, ...result.inserted]));
          // Lo pendiente es lo que el servidor trae ahora y no se ve (si ya se insertó por otra vía, sale).
          pending.set(new Set(result.pending));
          if (result.changed.length > 0) {
            flashIds.set(new Set(result.changed));
            clearTimeout(flashTimer);
            flashTimer = setTimeout(() => flashIds.set(new Set()), FLASH_MS);
          }
        },
        // Sin conexión ya avisa el interceptor; la lista queda como estaba.
        error: () => undefined,
      });
    },
    reorder() {
      inFlight?.unsubscribe();
      clearMarks();
      list.reload();
    },
    seen(id: string) {
      if (!untracked(newIds).has(id)) return;
      newIds.update((ids) => {
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
    },
  };
}

/** Distancia al borde (px) dentro de la cual se considera que el usuario está arriba de todo. */
const NEAR_TOP_PX = 48;

/**
 * ¿El usuario está mirando el principio de la lista? Mira el contenedor si es él el que scrollea (bandeja
 * en el escritorio) y, si no, la página (celular, Leads).
 */
export function isNearTop(container: HTMLElement | undefined, view: Window = globalThis.window): boolean {
  if (container && container.scrollHeight > container.clientHeight + 1) {
    return container.scrollTop <= NEAR_TOP_PX;
  }
  return view.scrollY <= NEAR_TOP_PX;
}
