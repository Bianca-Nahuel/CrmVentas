// Puntaje de lead (tarea 006), en código: el modelo da señales de 0 a 5 por dimensión y el código pone
// los pesos, la completitud y los umbrales de la config.
//
//   completitud = requeridos obtenidos / requeridos totales
//   score = round(100 × (Σ peso_d × señal_d / 5 + completeness_weight × completitud)
//                     / (Σ peso_d + completeness_weight))
//
// Sin campos requeridos, la completitud sale del numerador y del denominador.
import type { TenantConfig } from '@ventas/shared';

export type LeadTier = 'hot' | 'warm' | 'cold';

export interface ScoreBreakdown {
  dimensions: Record<string, { signal: number; weight: number; points: number }>;
  completeness: { value: number; weight: number; obtained: string[]; missing: string[] } | null;
  score: number;
  tier: LeadTier;
}

export function tierFor(score: number, thresholds: TenantConfig['scoring']['thresholds']): LeadTier {
  if (score >= thresholds.hot) return 'hot';
  if (score >= thresholds.warm) return 'warm';
  return 'cold';
}

export function computeScore(
  config: TenantConfig,
  signals: Record<string, { score: number }>,
  obtainedKeys: ReadonlySet<string>,
): ScoreBreakdown {
  const required = config.qualification.fields.filter((field) => field.required).map((field) => field.key);
  const dimensions: ScoreBreakdown['dimensions'] = {};
  let numerator = 0;
  let denominator = 0;
  for (const dimension of config.scoring.dimensions) {
    const signal = Math.min(5, Math.max(0, Math.round(signals[dimension.key]?.score ?? 0)));
    const points = (dimension.weight * signal) / 5;
    dimensions[dimension.key] = { signal, weight: dimension.weight, points };
    numerator += points;
    denominator += dimension.weight;
  }

  let completeness: ScoreBreakdown['completeness'] = null;
  if (required.length > 0) {
    const obtained = required.filter((key) => obtainedKeys.has(key));
    const value = obtained.length / required.length;
    const weight = config.scoring.completeness_weight;
    completeness = { value, weight, obtained, missing: required.filter((key) => !obtainedKeys.has(key)) };
    numerator += weight * value;
    denominator += weight;
  }

  const score = denominator > 0 ? Math.round((100 * numerator) / denominator) : 0;
  return { dimensions, completeness, score, tier: tierFor(score, config.scoring.thresholds) };
}
