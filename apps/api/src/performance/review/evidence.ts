// Validación de las citas del analista (tarea 026): cada evidencia tiene que aparecer literalmente (con los
// espacios normalizados) en el mensaje que indica, y ese mensaje tiene que ser del autor que corresponde.
// Lo que no cumple se descarta y queda registrado (sin el texto de la cita). Así el analista no puede
// inventar citas.
import type { Evidence, ReviewAuthor, ReviewMessage, ReviewOutput } from './prompt-v1.js';

export type DiscardReason =
  'no_evidence' | 'message_not_found' | 'wrong_author' | 'quote_not_found' | 'too_short';

export interface Discarded {
  /** criteria.<clave>, customer_outcome, issues[2], highlights[0]. */
  path: string;
  reason: DiscardReason;
}

/** Una cita más corta que esto no prueba nada ("sí", "ok"). */
export const MIN_QUOTE_CHARS = 3;

/** NFC y cualquier secuencia de espacios (incluidos saltos de línea y espacios duros) como un espacio. */
export function normalizeForQuote(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** La cita sin comillas ni puntos suspensivos alrededor (los modelos los agregan aunque se les pida que no). */
export function cleanQuote(quote: string): string {
  return normalizeForQuote(quote)
    .replace(/^["'“”‘’«»…]+|["'“”‘’«»…]+$/gu, '')
    .replace(/^\.{3}|\.{3}$/gu, '')
    .trim();
}

export function checkEvidence(
  evidence: Evidence | null,
  messages: ReviewMessage[],
  author: ReviewAuthor,
): DiscardReason | null {
  if (!evidence) return 'no_evidence';
  const message = messages[evidence.message];
  if (!message || message.index !== evidence.message) return 'message_not_found';
  if (message.author !== author) return 'wrong_author';
  const quote = cleanQuote(evidence.quote);
  if ([...quote].length < MIN_QUOTE_CHARS) return 'too_short';
  return normalizeForQuote(message.text).includes(quote) ? null : 'quote_not_found';
}

/**
 * Devuelve la revisión con solo las evidencias verificadas (con la cita limpia) y lo descartado:
 * - criterio con evidencia inválida o sin evidencia → score null;
 * - resultado del cliente distinto de unknown sin evidencia válida → unknown;
 * - problema o cosa bien hecha con evidencia inválida → fuera de la lista.
 */
export function validateReview(
  output: ReviewOutput,
  messages: ReviewMessage[],
): { review: ReviewOutput; discarded: Discarded[] } {
  const discarded: Discarded[] = [];
  const keep = (path: string, evidence: Evidence | null, author: ReviewAuthor): Evidence | null => {
    const reason = checkEvidence(evidence, messages, author);
    if (reason) {
      discarded.push({ path, reason });
      return null;
    }
    return { message: evidence!.message, quote: cleanQuote(evidence!.quote) };
  };

  const criteria: ReviewOutput['criteria'] = {};
  for (const [key, value] of Object.entries(output.criteria)) {
    if (value.score === null) {
      criteria[key] = { score: null, evidence: null };
      continue;
    }
    const evidence = keep(`criteria.${key}`, value.evidence, 'equipo');
    criteria[key] = evidence ? { score: value.score, evidence } : { score: null, evidence: null };
  }

  let customerOutcome: ReviewOutput['customer_outcome'] = { value: 'unknown', evidence: null };
  if (output.customer_outcome.value !== 'unknown') {
    const evidence = keep('customer_outcome', output.customer_outcome.evidence, 'cliente');
    if (evidence) customerOutcome = { value: output.customer_outcome.value, evidence };
  }

  const issues: ReviewOutput['issues'] = [];
  output.issues.forEach((issue, index) => {
    const evidence = keep(`issues[${index}]`, issue.evidence, 'equipo');
    if (evidence) issues.push({ ...issue, evidence });
  });
  const highlights: ReviewOutput['highlights'] = [];
  output.highlights.forEach((highlight, index) => {
    const evidence = keep(`highlights[${index}]`, highlight.evidence, 'equipo');
    if (evidence) highlights.push({ ...highlight, evidence });
  });

  return {
    review: {
      customer_outcome: customerOutcome,
      resolved: output.resolved,
      criteria,
      issues,
      highlights,
      coaching_tip: output.coaching_tip,
      summary: output.summary,
    },
    discarded,
  };
}
