import { Injectable, signal } from '@angular/core';

/**
 * Avisa a la lista de la bandeja que una conversación se marcó como vista, para sacarle el "sin ver" en el
 * momento sin volver a pedir la lista. Vive en el módulo de la bandeja (lazy).
 */
@Injectable({ providedIn: 'root' })
export class InboxReads {
  readonly lastRead = signal<{ id: string } | null>(null);

  markedRead(id: string) {
    this.lastRead.set({ id });
  }
}
