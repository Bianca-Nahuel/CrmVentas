// Textos del embudo (tarea 028). Funciones puras.
import { BadgeCheck, Flame, Forward, MessageCircle, Star, UserCheck, type IconNode } from 'lucide';
import type { FunnelBlock, FunnelOutcome, FunnelStage } from '../../api/generated';

export interface StageMeta {
  label: string;
  /** Cuándo se alcanza (para la tabla y los lectores de pantalla). */
  description: string;
  icon: IconNode;
}

export const STAGE_META: Record<FunnelStage, StageMeta> = {
  written: { label: 'Escribió', description: 'Escribió al menos un mensaje', icon: MessageCircle },
  qualified: { label: 'Calificado', description: 'Llegó a tibio o caliente', icon: Star },
  hot: { label: 'Caliente', description: 'Llegó a caliente', icon: Flame },
  handed_off: { label: 'Derivado', description: 'Se derivó a una persona', icon: Forward },
  attended: { label: 'Atendido', description: 'Respondió alguien del equipo', icon: UserCheck },
  sold: { label: 'Vendido', description: 'Se cerró como vendido', icon: BadgeCheck },
};

export const OUTCOME_LABELS: Record<FunnelOutcome, string> = {
  not_sold: 'No compró',
  no_response: 'Dejó de responder',
  other: 'Otro motivo',
  not_a_lead: 'No era un lead',
  auto_inactive: 'Cerrada por inactividad',
  open: 'En curso',
};

/** Menos que esto en el período: los porcentajes pueden variar mucho. */
export const LOW_VOLUME = 30;

export function countLabel(count: number, one: string, many: string): string {
  return `${new Intl.NumberFormat('es-AR').format(count)} ${count === 1 ? one : many}`;
}

/** Título de la lista abierta. */
export function listTitle(
  stage: FunnelStage | null,
  dropped: boolean,
  outcome: FunnelOutcome | null,
): string {
  const outcomeText = outcome ? OUTCOME_LABELS[outcome].toLowerCase() : null;
  if (stage && dropped) return `Se perdieron después de «${STAGE_META[stage].label}»`;
  if (stage && outcomeText) return `${STAGE_META[stage].label} · ${outcomeText}`;
  if (stage) return `Llegaron a «${STAGE_META[stage].label}»`;
  if (outcome) return OUTCOME_LABELS[outcome];
  return '';
}

export function stageCount(block: FunnelBlock, stage: FunnelStage): number {
  return block.stages.find((item) => item.stage === stage)?.count ?? 0;
}

const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 1000) / 10 : null);

/**
 * Conversión a venta de cada cohorte semanal: escribió → vendido y caliente → vendido. Las calientes vendidas
 * son las vendidas menos las que se vendieron sin pasar por caliente (el atajo). null sin base.
 */
export function trendPoints(
  weeks: { weekStart: string; block: FunnelBlock }[],
): { weekStart: string; written: number | null; hot: number | null }[] {
  return weeks.map(({ weekStart, block }) => ({
    weekStart,
    written: pct(stageCount(block, 'sold'), stageCount(block, 'written')),
    hot: pct(stageCount(block, 'sold') - block.shortcuts.soldWithoutHot, stageCount(block, 'hot')),
  }));
}
