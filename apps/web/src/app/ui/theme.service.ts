import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

export type ThemePreference = 'system' | 'light' | 'dark';

// La misma clave que lee el script de index.html. Es solo una preferencia visual: nunca datos de sesión.
const STORAGE_KEY = 'panel.theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly media = this.document.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
  private readonly systemDark = signal(this.media?.matches ?? false);

  readonly preference = signal<ThemePreference>(this.read());
  readonly resolved = computed<'light' | 'dark'>(() => {
    const pref = this.preference();
    if (pref === 'system') return this.systemDark() ? 'dark' : 'light';
    return pref;
  });

  constructor() {
    const listener = (event: MediaQueryListEvent) => {
      this.systemDark.set(event.matches);
      this.apply();
    };
    this.media?.addEventListener?.('change', listener);
    inject(DestroyRef).onDestroy(() => this.media?.removeEventListener?.('change', listener));
    this.apply();
  }

  set(preference: ThemePreference) {
    this.preference.set(preference);
    try {
      this.document.defaultView?.localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Almacenamiento bloqueado (modo privado): el tema vale para esta pestaña.
    }
    this.apply();
  }

  private apply() {
    this.document.documentElement.setAttribute('data-theme', this.resolved());
  }

  private read(): ThemePreference {
    try {
      const value = this.document.defaultView?.localStorage.getItem(STORAGE_KEY);
      return value === 'light' || value === 'dark' ? value : 'system';
    } catch {
      return 'system';
    }
  }
}
