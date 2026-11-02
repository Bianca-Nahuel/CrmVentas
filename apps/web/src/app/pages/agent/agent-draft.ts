import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { form, submit, validateStandardSchema, type FieldTree } from '@angular/forms/signals';
import { tenantConfigSchema, useBusinessMessages, type TenantConfig } from '@ventas/shared/ai';
import { firstValueFrom } from 'rxjs';
import { AgentConfigApi } from '../../api/agent-config-api';
import { diffConfigs, toModel } from './config-model';

export interface ServerIssue {
  path: (string | number)[];
  message: string;
}

export type SaveResult =
  | { kind: 'saved'; version: number }
  | { kind: 'invalid'; issues: ServerIssue[] }
  | { kind: 'conflict'; currentVersion: number }
  | { kind: 'confirm_transparency' }
  | { kind: 'owner_only' }
  | { kind: 'failed' };

/** Sigue la ruta de un error del servidor dentro del árbol del formulario (o null si ya no existe). */
export function fieldAt(root: FieldTree<unknown>, path: (string | number)[]): FieldTree<unknown> | null {
  let node: unknown = root;
  for (const part of path) {
    node = (node as Record<string | number, unknown> | undefined)?.[part];
    if (node === undefined) return null;
  }
  return node as FieldTree<unknown>;
}

/**
 * La configuración en edición de /agente (tarea 027), compartida por todas las secciones, el historial y el
 * playground: un solo modelo y un solo formulario, validado en el navegador con el mismo tenantConfigSchema
 * de libs/shared que usa el servidor. El servidor vuelve a validar todo al guardar: el navegador solo ayuda.
 * Se provee en la página de /agente (una instancia por visita).
 */
@Injectable()
export class AgentDraft {
  private readonly api = inject(AgentConfigApi);

  constructor() {
    // Los mismos mensajes de validación que devuelve la API.
    useBusinessMessages();
  }

  readonly status = signal<'loading' | 'ready' | 'failed'>('loading');
  /** Versión sobre la que se edita (0 si la empresa no tiene configuración). */
  readonly version = signal(0);
  readonly savedBy = signal<string | null>(null);
  readonly savedAt = signal<string | null>(null);
  readonly timezone = signal('America/Argentina/Buenos_Aires');
  /** La vigente no valida con el schema actual (la IA no responde hasta guardar una que valide). */
  readonly loadedInvalid = signal(false);

  readonly model = signal<TenantConfig>(toModel(null).config);
  private readonly original = signal<TenantConfig>(toModel(null).config);
  readonly form = form(this.model, (path) => {
    // El schema de entrada (con defaults opcionales) y el modelo (con los defaults aplicados) difieren solo
    // en lo opcional: valida igual.
    validateStandardSchema(path, tenantConfigSchema as never);
  });

  /** Cambios sin guardar, hoja por hoja. */
  readonly changes = computed(() => diffConfigs(this.original(), this.model()));
  readonly dirty = computed(() => this.changes().length > 0);
  readonly saving = signal(false);

  async load(): Promise<void> {
    this.status.set('loading');
    try {
      const current = await firstValueFrom(this.api.current());
      const { config, valid } = toModel(current.config);
      this.version.set(current.version ?? 0);
      this.savedBy.set(current.savedBy?.name ?? null);
      this.savedAt.set(current.savedAt);
      this.timezone.set(current.timezone);
      this.loadedInvalid.set(current.config !== null && !valid);
      this.original.set(structuredClone(config));
      this.model.set(structuredClone(config));
      this.form().reset();
      this.status.set('ready');
    } catch {
      this.status.set('failed');
    }
  }

  discard(): void {
    this.model.set(structuredClone(this.original()));
    this.form().reset();
  }

  /**
   * Guarda una versión nueva. Los errores del servidor quedan en su campo (submit los integra al
   * formulario) y además vuelven en el resultado, para mostrar el resumen y llevar a la sección.
   */
  async save(options: { confirmTransparency?: boolean } = {}): Promise<SaveResult> {
    let result: SaveResult = { kind: 'failed' };
    this.saving.set(true);
    try {
      const ok = await submit(this.form, {
        action: async () => {
          try {
            const saved = await firstValueFrom(
              this.api.save({
                config: this.model() as unknown as Record<string, unknown>,
                expectedVersion: this.version(),
                ...(options.confirmTransparency ? { confirmTransparency: true } : {}),
              }),
            );
            result = { kind: 'saved', version: saved.version };
            return undefined;
          } catch (error) {
            result = this.saveError(error);
            if (result.kind !== 'invalid') return undefined;
            return result.issues.map((issue) => ({
              kind: 'server',
              message: issue.message,
              fieldTree: fieldAt(this.form as FieldTree<unknown>, issue.path) ?? this.form,
            }));
          }
        },
        onInvalid: () => {
          result = { kind: 'invalid', issues: this.browserIssues() };
        },
      });
      // result lo asignan los callbacks de submit (TypeScript no lo sigue): se lee como SaveResult.
      const final = result as SaveResult;
      if (ok && final.kind === 'saved') await this.load();
      return final;
    } finally {
      this.saving.set(false);
    }
  }

  /** Lo que el zod del navegador marca hoy, con la ruta de cada campo (para el resumen). */
  browserIssues(): ServerIssue[] {
    const parsed = tenantConfigSchema.safeParse(this.model());
    if (parsed.success) return [];
    return parsed.error.issues.map((issue) => ({
      path: issue.path.filter((part): part is string | number => typeof part !== 'symbol'),
      message: issue.message,
    }));
  }

  private saveError(error: unknown): SaveResult {
    if (!(error instanceof HttpErrorResponse)) return { kind: 'failed' };
    const payload = (error.error ?? {}) as { code?: string; issues?: ServerIssue[]; currentVersion?: number };
    if (error.status === 400 && payload.code === 'INVALID_CONFIG') {
      return { kind: 'invalid', issues: payload.issues ?? [] };
    }
    if (error.status === 400 && payload.code === 'TRANSPARENCY_CONFIRM_REQUIRED') {
      return { kind: 'confirm_transparency' };
    }
    if (error.status === 409 && payload.code === 'VERSION_CONFLICT') {
      return { kind: 'conflict', currentVersion: payload.currentVersion ?? 0 };
    }
    if (error.status === 409 && payload.code === 'REVIEW_OWNER_ONLY') return { kind: 'owner_only' };
    return { kind: 'failed' };
  }
}
