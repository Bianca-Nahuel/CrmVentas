// Resumen de derivación que se guarda en la conversación: el del modelo, más lo que el código verifica
// que no falte (todos los campos obtenidos y lo descubierto). Si la salida fue inválida, lo arma el código.
import { normalizeText, type TenantConfig } from '@ventas/shared';
import { HANDOFF_SUMMARY_STORED_MAX_CHARS } from '../ai.constants.js';
import type { DiscoveredNote, ExtractedValue } from '../prompts/v3/output-schema.js';

function display(value: ExtractedValue): string {
  if (value === true) return 'sí';
  if (value === false) return 'no';
  return String(value);
}

function mentions(summary: string, value: string): boolean {
  return normalizeText(summary).includes(normalizeText(value));
}

export function composeHandoffSummary(input: {
  modelSummary: string | null;
  reason: string;
  config: TenantConfig;
  extracted: Record<string, ExtractedValue>;
  discovered: DiscoveredNote[];
}): string {
  const { config, extracted, discovered } = input;
  const base =
    input.modelSummary?.trim() || `Derivado automáticamente (${input.reason}), sin resumen del asistente.`;
  const parts = [base];

  const fields = config.qualification.fields;
  const obtained = fields.filter(
    (field) => extracted[field.key] !== null && extracted[field.key] !== undefined,
  );
  const notMentioned = obtained.filter((field) => !mentions(base, display(extracted[field.key]!)));
  if (notMentioned.length > 0) {
    parts.push(
      `Datos obtenidos: ${notMentioned.map((field) => `${field.label}: ${display(extracted[field.key]!)}`).join('; ')}.`,
    );
  }
  if (!input.modelSummary) {
    const missing = fields.filter((field) => field.required && !obtained.includes(field));
    if (missing.length > 0) parts.push(`Faltan: ${missing.map((field) => field.label).join(', ')}.`);
  }
  const notes = discovered.filter((note) => !mentions(base, note.value));
  if (notes.length > 0) {
    parts.push(`Otros datos: ${notes.map((note) => `${note.topic}: ${note.value}`).join('; ')}.`);
  }

  const summary = parts.join('\n');
  return [...summary].length <= HANDOFF_SUMMARY_STORED_MAX_CHARS
    ? summary
    : `${[...summary].slice(0, HANDOFF_SUMMARY_STORED_MAX_CHARS - 1).join('')}…`;
}
