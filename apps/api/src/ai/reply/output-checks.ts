// Controles de salida (tarea 006): todo texto que se envía como 'ai' pasa por acá. El primero que falla
// bloquea el envío (y la conversación se deriva). checkReply es la única forma de obtener un SafeReply,
// el único tipo que acepta el envío de la IA.
//
// Marcas del catálogo (tarea 007, markers.ts): parseMarkers las separa antes de los controles (que corren
// sobre el texto con un marcador neutro en su lugar) y renderMarkers pone los valores DESPUÉS. Una marca
// inválida bloquea; cualquier otro {{…}} también.
import { normalizeText, type TenantConfig } from '@ventas/shared';
import { AI_REPLY_MAX_CHARS, AI_REPLY_RENDERED_MAX_CHARS } from '../ai.constants.js';
import { canonical, parseArNumber } from '../../catalog/decimal.js';
import type { TurnCatalogContext } from '../tools/turn-catalog-context.js';
import { markersValid, parseMarkers, renderMarkers } from './markers.js';

declare const safeReplyBrand: unique symbol;
/** Texto que pasó los controles de salida. */
export type SafeReply = string & { readonly [safeReplyBrand]: true };

export type OutputControl =
  | 'empty'
  | 'max_length'
  | 'placeholder'
  | 'link'
  | 'email'
  | 'phone'
  | 'money'
  | 'sensitive_request'
  | 'commitment'
  | 'denies_assistant'
  | 'leak'
  | 'marker'
  | 'quantity';

export type CheckResult = { ok: true; reply: SafeReply } | { ok: false; control: OutputControl };

/** Lo que se precalcula de la config una vez por corrida. */
export interface CheckContext {
  /** Forma literal (tokens) del texto de la config, con espacios al borde. */
  literal: string;
  /** Links (normalizados) y emails que aparecen en la config: se exige igualdad, no una subcadena. */
  links: string[];
  emails: string[];
  /** Dígitos de los teléfonos que aparecen en la config. */
  phones: string[];
  /** Lo que devolvieron las herramientas del catálogo en este turno (sin catálogo: undefined). */
  catalog?: TurnCatalogContext;
  /** Números que escribió el cliente (canónicos): los m² que el modelo puede repetir. */
  clientNumbers?: string[];
}

// Cualquier dominio con TLD de letras (no una lista fija: un .xyz también es un link). Un "palabra.Palabra"
// sin espacio puede dar un falso positivo, que solo deriva.
const URL_PATTERN =
  /\b(?:https?:\/\/|www\.)[^\s<>"')]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\b(?:\/[^\s<>"')]*)?/gi;
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_PATTERN = /\+?\d[\d\s().-]{6,}\d/g;
const DATE_LIKE = /^(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})$/;
// Precio sin símbolo de moneda ("el m² sale 12.500"): el número tiene que estar literal en la config.
const PRICE_WORDS = /\b(sale|salen|cuesta|cuestan|precio|precios|valor|vale|valen)\b\D{0,20}?(\d[\d.,]*)/g;
const MONEY_PATTERN =
  /(?:\$|u\$s|\busd\b|\bars\b|€|\beur\b)\s?\d[\d.,]*|\d[\d.,]*\s?(?:\$|u\$s|usd\b|ars\b|€|eur\b|pesos\b|dolares\b)|\d+(?:[.,]\d+)?\s?%/g;
const SENSITIVE_PATTERNS = [
  /\b(cvv|cvc|cbu|cvu|dni)\b/,
  /\bcodigo de (verificacion|seguridad)\b/,
  // "código" solo como código de acceso: el de una caja o un producto es un dato legítimo.
  /\bcodigo (de |por )?(acceso|sms|whatsapp)\b/,
  /\b(pasame|pasa|mandame|manda|enviame|envia|decime|deci|necesito|indicame|indica|me das|me pasas|ingresa|escribi|escribime)\b(?:\W+\w+){0,4}?\W+(tarjeta|clave|contrasena|password|pin|documento)\b/,
];
const COMMITMENT_PATTERNS = [
  /\b(hay|tenemos|tengo|queda|quedan) (stock|disponib)/,
  /\besta disponible\b/,
  /\bte (lo|la|los|las) (reservo|guardo|separo|aparto)\b/,
  /\b(queda|esta|quedo) reservad/,
  /\bdescuento/,
  /\bte (hago|dejo) (un|el) precio\b/,
  /\b(te )?llega (hoy|manana|el )/,
];
// Con catálogo, la disponibilidad solo sale de la marca {{stock:SKU}} (que el código escribe después de
// estos controles): cualquier forma de afirmarla o negarla escrita por el modelo bloquea.
const AVAILABILITY_PATTERNS = [
  /\bstock\b/,
  /\bagotad/,
  /\bdisponib/,
  /\bexistencias?\b/,
  /\b(lo|la|los|las) (tenemos|tengo|hay)\b/,
  /\b(hay|tenemos|contamos con|quedan?|nos quedan?) (pocas?|pocos?|cajas|unidades|piezas|metros|m2)\b/,
  /\b(entra|ingresa|llega) (la|el) (semana|mes|lunes|martes|miercoles|jueves|viernes)\b/,
];
const DENIES_ASSISTANT_PATTERNS = [
  /(?<!no )\bsoy (una )?persona\b/,
  /(?<!no )\bsoy (un )?humano\b/,
  /\bno soy (un |una )?(bot|robot|asistente|ia|maquina)\b/,
  /\bno soy automatico\b/,
];
const LEAK_MARKERS = [
  'reglas fijas',
  '<conversacion',
  '<negocio',
  '<datos_del_cliente',
  'handoff_summary',
  'custom_instructions',
  'discovery_guidance',
  'sales_guidance',
  'max_questions_per_message',
];

/** Tokens comparables: sin tildes, sin puntuación, con $ y % como tokens propios. */
function literalForm(text: string): string {
  return normalizeText(text)
    .replace(/([$%€])/g, ' $1 ')
    .replace(/[^\p{L}\p{N}$%€]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function digits(text: string): string {
  return text.replace(/\D/g, '');
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out));
  else if (value && typeof value === 'object')
    Object.values(value).forEach((item) => collectStrings(item, out));
  return out;
}

/**
 * Solo las secciones con datos del negocio que el agente puede repetir. Quedan afuera las prohibiciones,
 * reglas, instrucciones y guías: si no, "nunca ofrezcas 10 % de descuento" habilitaría ese descuento.
 */
function dataStrings(config: TenantConfig): string[] {
  const { handoff, qualification } = config;
  const modes = [
    ...Object.values(handoff.triggers).map((trigger) => trigger.mode),
    ...handoff.custom_triggers.map((trigger) => trigger.mode),
  ];
  return collectStrings([
    config.business,
    config.knowledge,
    config.agent.offers,
    config.agent.persona.name,
    // Las preguntas de un disparador after_fields (intro + how_to_ask) también pasan por los controles.
    qualification.fields.map((field) => [
      field.label,
      field.options,
      field.how_to_ask,
      field.how_to_ask_i18n,
    ]),
    modes.map((mode) => (mode.type === 'after_fields' ? mode.intro : null)),
    handoff.message_in_hours,
    handoff.message_after_hours,
    handoff.unsupported_media.mode === 'ask_text' ? handoff.unsupported_media.message : null,
  ]);
}

export function buildCheckContext(config: TenantConfig): CheckContext {
  const strings = dataStrings(config);
  const text = strings.join('\n');
  // Por texto: buscado sobre todo junto, un teléfono se pegaría con los números del texto siguiente.
  const phones = strings
    .flatMap((value) => [...value.matchAll(PHONE_PATTERN)])
    .map((match) => digits(match[0]))
    .filter((value) => value.length >= 8 && value.length <= 15);
  return {
    literal: ` ${literalForm(text)} `,
    links: [...text.replace(EMAIL_PATTERN, ' ').matchAll(URL_PATTERN)]
      .map((match) => normalizeLink(match[0]))
      .filter(Boolean),
    emails: [...text.matchAll(EMAIL_PATTERN)].map((match) => match[0].toLowerCase()),
    phones,
  };
}

/** ¿El texto aparece tal cual en la config (a nivel de tokens)? */
function inConfig(candidate: string, context: CheckContext): boolean {
  const form = literalForm(candidate);
  return form !== '' && context.literal.includes(` ${form} `);
}

/**
 * Excepción literal de commitment y sensitive_request: la coincidencia pasa si aparece en la config junto
 * con al menos dos palabras vecinas del reply ("de descuento pagando"); la palabra suelta no alcanza.
 */
function matchInConfigWithContext(
  normalized: string,
  matchIndex: number,
  matchLength: number,
  context: CheckContext,
) {
  const before = literalForm(normalized.slice(0, matchIndex)).split(' ').filter(Boolean);
  const matched = literalForm(normalized.slice(matchIndex, matchIndex + matchLength))
    .split(' ')
    .filter(Boolean);
  const after = literalForm(normalized.slice(matchIndex + matchLength))
    .split(' ')
    .filter(Boolean);
  for (let left = 0; left <= 3; left++) {
    for (let right = 0; right <= 3; right++) {
      if (left + right < 2 || left > before.length || right > after.length) continue;
      const window = [...before.slice(before.length - left), ...matched, ...after.slice(0, right)].join(' ');
      if (context.literal.includes(` ${window} `)) return true;
    }
  }
  return false;
}

function failsWithLiteralException(patterns: RegExp[], normalized: string, context: CheckContext): boolean {
  for (const pattern of patterns) {
    const global = new RegExp(pattern.source, 'g');
    for (const match of normalized.matchAll(global)) {
      if (!matchInConfigWithContext(normalized, match.index, match[0].length, context)) return true;
    }
  }
  return false;
}

function normalizeLink(link: string): string {
  return link
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[.,;:!?/]+$/, '');
}

// Cantidades escritas por el modelo: cajas o piezas nunca (van con marcas); m² solo si los dijo el cliente.
const PACKAGE_QUANTITY = /\b\d+(?:[.,]\d+)?\s*(cajas?|piezas?)\b/;
const AREA_QUANTITY = /\b(\d+(?:[.,]\d+)?)\s*(?:m2|m²|mts?2|metros? cuadrados?)/g;

/** Los números de un texto, canónicos ("45", "45,5" → "45.5"). */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(/(?<![\p{L}\d])\d+(?:[.,]\d+)*/gu)]
    .map((match) => parseArNumber(match[0]) ?? canonical(match[0].replace(',', '.')))
    .filter((value): value is string => value !== null);
}

export function checkReply(reply: string, context: CheckContext): CheckResult {
  const fail = (control: OutputControl): CheckResult => ({ ok: false, control });
  const original = reply.trim();
  const { markers, template } = parseMarkers(original);
  const text = template.trim();
  if (text === '') return fail('empty');
  if ([...text].length > AI_REPLY_MAX_CHARS) return fail('max_length');
  if (/\{\{|\}\}/.test(text)) return fail('placeholder');
  if (!markersValid(markers, context.catalog)) return fail('marker');

  const emails = [...text.matchAll(EMAIL_PATTERN)].map((match) => match[0].toLowerCase());
  if (emails.some((email) => !context.emails.includes(email))) return fail('email');
  const withoutEmails = text.replace(EMAIL_PATTERN, ' ');
  for (const match of withoutEmails.matchAll(URL_PATTERN)) {
    const link = normalizeLink(match[0]);
    // Igual a un link de la config, o una ruta debajo de uno ("sitio.com/catalogo"); nunca un recorte.
    const allowed = context.links.some((known) => link === known || link.startsWith(`${known}/`));
    if (link === '' || !allowed) return fail('link');
  }

  // Los montos no son teléfonos ("$ 12.000.000"): se sacan antes de buscar teléfonos.
  const forPhones = normalizeText(withoutEmails).replace(MONEY_PATTERN, ' ');
  for (const match of forPhones.matchAll(PHONE_PATTERN)) {
    const value = digits(match[0]);
    if (value.length < 8 || value.length > 15 || DATE_LIKE.test(match[0].trim())) continue;
    const tail = value.slice(-10);
    if (!context.phones.some((phone) => phone.slice(-10) === tail)) return fail('phone');
  }

  const normalized = normalizeText(text);
  for (const match of normalized.matchAll(MONEY_PATTERN)) {
    if (!inConfig(match[0], context)) return fail('money');
  }
  for (const match of normalized.matchAll(PRICE_WORDS)) {
    if (digits(match[2]!).length >= 3 && !inConfig(match[2]!, context)) return fail('money');
  }
  if (context.catalog) {
    if (PACKAGE_QUANTITY.test(normalized)) return fail('quantity');
    const said = new Set(context.clientNumbers ?? []);
    for (const match of text.toLowerCase().matchAll(AREA_QUANTITY)) {
      const value = numbersIn(match[1]!)[0];
      if (!value || !said.has(value)) return fail('quantity');
    }
  }
  if (failsWithLiteralException(SENSITIVE_PATTERNS, normalized, context)) return fail('sensitive_request');
  if (failsWithLiteralException(COMMITMENT_PATTERNS, normalized, context)) return fail('commitment');
  if (context.catalog && failsWithLiteralException(AVAILABILITY_PATTERNS, normalized, context)) {
    return fail('commitment');
  }
  if (DENIES_ASSISTANT_PATTERNS.some((pattern) => pattern.test(normalized))) return fail('denies_assistant');
  if (LEAK_MARKERS.some((marker) => normalized.includes(marker))) return fail('leak');

  // Recién acá se ponen los valores (y se registran las citas).
  const rendered = renderMarkers(original, markers, context.catalog);
  if ([...rendered].length > AI_REPLY_RENDERED_MAX_CHARS) return fail('max_length');
  return { ok: true, reply: rendered as SafeReply };
}

export type CheckPartsResult = { ok: true; parts: SafeReply[] } | { ok: false; control: OutputControl };

/**
 * Respuesta en varios mensajes (tarea 010): los controles corren sobre el texto unido (una frase partida
 * entre dos mensajes, "te lo" + "reservo", se lee entera en el chat) y sobre cada parte; los topes de largo
 * valen para el total. Una parte que falla bloquea todas.
 */
export function checkReplies(parts: string[], context: CheckContext): CheckPartsResult {
  const nonEmpty = parts.map((part) => part.trim()).filter((part) => part !== '');
  if (nonEmpty.length === 0) return { ok: false, control: 'empty' };
  const templateChars = nonEmpty.reduce(
    (total, part) => total + [...parseMarkers(part).template.trim()].length,
    0,
  );
  if (templateChars > AI_REPLY_MAX_CHARS) return { ok: false, control: 'max_length' };
  // checkReply registra las citas al renderizar: si una parte posterior falla, no sale nada y se descartan.
  const cited = context.catalog?.cited;
  const citedBefore = cited?.length ?? 0;
  const fail = (control: OutputControl): CheckPartsResult => {
    if (cited) cited.length = citedBefore;
    return { ok: false, control };
  };
  // Sobre todo junto (las citas que registra este paso se descartan: las registran las partes).
  if (nonEmpty.length > 1) {
    const joined = checkReply(nonEmpty.join(' '), context);
    if (cited) cited.length = citedBefore;
    if (!joined.ok) return fail(joined.control);
  }
  const checked: SafeReply[] = [];
  for (const part of nonEmpty) {
    const result = checkReply(part, context);
    if (!result.ok) return fail(result.control);
    checked.push(result.reply);
  }
  const renderedChars = checked.reduce((total, part) => total + [...part].length, 0);
  if (renderedChars > AI_REPLY_RENDERED_MAX_CHARS) return fail('max_length');
  return { ok: true, parts: checked };
}
