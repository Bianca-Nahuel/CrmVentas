import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';

/** Control de gasto antes y después de cada llamada al modelo. La tarea 008 trae la implementación real. */
export const AI_BUDGET_GUARD = Symbol('AI_BUDGET_GUARD');

export type ReserveResult =
  { ok: true; reservationId: string } | { ok: false; reason: 'no_credits' | 'platform_cap' | 'byok_budget' };

export interface AiBudgetGuard {
  /** Antes de llamar: reserva la estimación (tokens de entrada aproximados + maxOutputTokens × precio). */
  reserve(tenantId: string, estimateUsd: string): Promise<ReserveResult>;
  /** Después de una llamada con costo (aunque la salida haya sido inválida). */
  settle(reservationId: string, actualUsd: string, aiRunId: string): Promise<void>;
  /** Si la llamada falló sin costo conocido. */
  release(reservationId: string): Promise<void>;
}

/** Tarea 006: no bloquea nada. */
@Injectable()
export class NoopBudgetGuard implements AiBudgetGuard {
  async reserve(): Promise<ReserveResult> {
    return { ok: true, reservationId: randomUUID() };
  }

  async settle(): Promise<void> {}

  async release(): Promise<void> {}
}
