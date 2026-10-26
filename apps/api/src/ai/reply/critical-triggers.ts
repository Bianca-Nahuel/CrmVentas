// Respaldo en código de los disparadores críticos (tarea 006): el modelo puede no marcarlos. Si el modelo
// o este detector lo detectan, cuenta como detectado. Corre sobre los mensajes del cliente posteriores al
// último saliente (la ráfaga actual), ya normalizados.
import { CRITICAL_TRIGGERS, normalizeText, type CriticalTrigger, type TenantConfig } from '@ventas/shared';

// Expresiones de fábrica, sobre texto normalizado (minúsculas, sin tildes, abreviaturas expandidas).
const DEFAULT_PATTERNS: Record<CriticalTrigger, RegExp[]> = {
  availability: [
    /\bstock\b/,
    /\bdisponib/,
    /\b(tienen|tenes|hay) para retirar\b/,
    /\bpara retirar hoy\b/,
    /\bles queda(n)?\b/,
    /\bqueda alguno\b/,
    /\bentrega inmediata\b/,
    /\bcuando (les )?(entra|ingresa|vuelve a entrar)\b/,
    /\b(lo|la|los|las) (tienen|tenes)\b/,
    /\b(tienen|tenes) (ese|esa|esos|esas)\b/,
    /\bhay de (ese|esa|esos|esas)\b/,
  ],
  asks_human: [
    /\b(hablar|hablo|comunicarme|charlar) con (alguien|una persona|un humano|una humana|un vendedor|una vendedora|un asesor|una asesora|un representante)\b/,
    /\b(pasame|pasarme|derivame|comunicame) con (alguien|una persona|un humano|un vendedor|una vendedora|un asesor|una asesora|el encargado|la encargada)\b/,
    /\bpersona real\b/,
    /\batencion humana\b/,
    /\b(que me llame alguien|que me llamen|me pueden llamar|me podes llamar|llamenme|llamame)\b/,
    /\bquiero un humano\b/,
  ],
  payment_or_reservation: [
    /\breserv/,
    /\b(me|nos) (lo|la|los|las) (guardan|guardas|separan|separas|apartan|apartas)\b/,
    /\bapart(ar|ame|amelo|amela)\b/,
    /\bsen(a|ar|o|as|amos)\b/,
    /\b(te )?transfiero\b/,
    /\bhago (la|una) transferencia\b/,
    /\bpasame (el |tu |un )?(cbu|cvu|alias)\b/,
    /\b(cbu|cvu)\b/,
    /\blink de pago\b/,
    /\b(mando|te paso|envio) (el )?comprobante\b/,
    /\b(pagar|abonar) (ahora|ya|hoy)\b/,
    /\bte (pago|deposito)\b/,
  ],
};

// Frases que se quitan antes de buscar: no son una consulta de disponibilidad de un producto.
const DEFAULT_EXCLUSIONS: Record<CriticalTrigger, RegExp[]> = {
  availability: [/\bhorarios? disponibles?\b/g, /\bmedios de pago disponibles?\b/g],
  asks_human: [],
  payment_or_reservation: [],
};

/** Normalización para el detector: la de siempre más abreviaturas comunes de WhatsApp. */
export function normalizeForTriggers(text: string): string {
  return normalizeText(text)
    .replace(/\bk(?=[ie])/g, 'qu')
    .replace(/\bxq\b/g, 'porque')
    .replace(/\bq\b/g, 'que')
    .replace(/\bx\b/g, 'por')
    .replace(/\bd\b/g, 'de')
    .replace(/\bp\b/g, 'para');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phraseRegExp(phrase: string, flags = ''): RegExp {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizeForTriggers(phrase))}`, flags);
}

export function detectCriticalTriggers(texts: string[], config: TenantConfig): CriticalTrigger[] {
  const joined = texts.map(normalizeForTriggers).join(' \n ');
  const detected: CriticalTrigger[] = [];
  for (const id of CRITICAL_TRIGGERS) {
    if (!config.handoff.triggers[id].enabled) continue;
    const keywords = config.handoff.keywords[id];
    let text = joined;
    for (const exclusion of DEFAULT_EXCLUSIONS[id]) text = text.replace(exclusion, ' ');
    for (const phrase of keywords?.exclude ?? []) text = text.replace(phraseRegExp(phrase, 'g'), ' ');
    const patterns = [
      ...DEFAULT_PATTERNS[id],
      ...(keywords?.extra ?? []).map((phrase) => phraseRegExp(phrase)),
    ];
    if (patterns.some((pattern) => pattern.test(text))) detected.push(id);
  }
  return detected;
}
