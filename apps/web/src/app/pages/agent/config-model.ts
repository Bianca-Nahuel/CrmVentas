// Piezas puras de la configuración del agente en el panel (tarea 027): la config inicial de una empresa sin
// configuración, la comparación campo por campo (cambios sin guardar e historial) y los nombres de cada campo
// en lenguaje de negocio. Sin Angular: lo usan el borrador, el historial y el catálogo.
import {
  PREDEFINED_TRIGGERS,
  SENSITIVE_FIELD_PATTERN,
  normalizeText,
  tenantConfigSchema,
  type TenantConfig,
  type WeeklyHours,
} from '@ventas/shared/ai';

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = (typeof DAYS)[number];
export const DAY_LABELS: Record<Day, string> = {
  mon: 'Lunes',
  tue: 'Martes',
  wed: 'Miércoles',
  thu: 'Jueves',
  fri: 'Viernes',
  sat: 'Sábado',
  sun: 'Domingo',
};

export const TRIGGER_LABELS: Record<(typeof PREDEFINED_TRIGGERS)[number], string> = {
  asks_human: 'Pide hablar con una persona',
  availability: 'Pregunta por stock o disponibilidad',
  payment_or_reservation: 'Quiere pagar, señar o reservar',
  price_negotiation: 'Quiere negociar el precio',
  complaint: 'Tiene un reclamo',
  frustration: 'Se nota molesto',
  cannot_answer: 'El asistente no sabe qué responder',
};

/** Lo que confirma el owner al activar la revisión de calidad (el servidor guarda quién y cuándo). */
export const TRANSPARENCY_TEXT =
  'La revisión de calidad lee las conversaciones de los vendedores y les pone una nota. Antes de activarla, ' +
  'avisale a tu equipo que sus conversaciones se van a revisar y para qué. Al confirmar, queda registrado ' +
  'que lo hiciste vos y cuándo.';

function weekly(): WeeklyHours {
  const open = [{ open: '09:00', close: '18:00' }];
  return { mon: open, tue: open, wed: open, thu: open, fri: open, sat: [], sun: [] };
}

/**
 * Punto de partida de una empresa sin configuración: los defaults del schema con los datos del negocio vacíos,
 * así no valida (ni se puede guardar) hasta completarlos y nada inventado llega a las respuestas.
 */
export function starterConfig(): TenantConfig {
  const config = tenantConfigSchema.parse({
    schema_version: 1,
    ai: { enabled: false, channel_ids: [] },
    business: {
      name: 'Mi empresa',
      industry: 'Rubro',
      language: 'es',
      branches: [{ name: 'Local', address: 'Dirección', hours: weekly() }],
      service_hours: weekly(),
      payment_methods: [],
      shipping: null,
      website: null,
      email: null,
    },
    knowledge: { faqs: [], policies: { returns: null, warranty: null, shipping: null, financing: null } },
    agent: {
      persona: { name: null, tone: 'amable y claro, tratando de vos' },
      custom_instructions: '',
      sales_guidance: '',
      business_rules: [],
      offers: [],
      must_not: [],
    },
    qualification: {
      fields: [],
      discovery_guidance: '',
      max_questions_per_message: 1,
      max_qualification_turns: 6,
    },
    scoring: {
      dimensions: [{ key: 'intent', description: 'Qué tan decidido está a comprar', weight: 3 }],
      completeness_weight: 2,
      thresholds: { hot: 70, warm: 40 },
    },
    handoff: {
      triggers: Object.fromEntries(
        PREDEFINED_TRIGGERS.map((id) => [id, { enabled: true, mode: { type: 'immediate' } }]),
      ),
      custom_triggers: [],
      message_in_hours: 'Te paso con una persona del equipo, en un ratito te escribe.',
      message_after_hours: 'Ahora estamos cerrados: te escribe una persona del equipo apenas abramos.',
      unsupported_media: { mode: 'handoff' },
    },
  });
  config.business.name = '';
  config.business.industry = '';
  config.business.branches = [{ name: '', address: '', hours: weekly() }];
  return config;
}

/**
 * La config cargada como modelo del formulario: con los valores por defecto del schema. Si la vigente no
 * valida con el schema actual, se usa tal cual sobre la inicial (y el panel avisa).
 */
export function toModel(raw: Record<string, unknown> | null): { config: TenantConfig; valid: boolean } {
  if (!raw) return { config: starterConfig(), valid: true };
  const parsed = tenantConfigSchema.safeParse(raw);
  if (parsed.success) return { config: parsed.data, valid: true };
  return { config: { ...starterConfig(), ...(raw as Partial<TenantConfig>) }, valid: false };
}

export interface FieldChange {
  path: string;
  before: string;
  after: string;
}

function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(prefix, '(vacío)');
    value.forEach((item, index) => flatten(item, `${prefix}.${index}`, out));
  } else if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) out.set(prefix, '(vacío)');
    for (const [key, item] of entries) flatten(item, prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.set(prefix, value === null || value === undefined ? '(sin valor)' : String(value));
  }
}

/** Diferencias hoja por hoja (texto plano, nunca HTML). */
export function diffConfigs(before: unknown, after: unknown): FieldChange[] {
  const a = new Map<string, string>();
  const b = new Map<string, string>();
  flatten(before, '', a);
  flatten(after, '', b);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  return paths
    .filter((path) => a.get(path) !== b.get(path))
    .map((path) => ({ path, before: a.get(path) ?? '(no estaba)', after: b.get(path) ?? '(se quitó)' }));
}

const SECTION_LABELS: Record<string, string> = {
  ai: 'General',
  business: 'Negocio',
  knowledge: 'Conocimiento',
  agent: 'Personalidad y reglas',
  qualification: 'Calificación',
  scoring: 'Puntaje',
  handoff: 'Derivación',
  inbox: 'Bandeja',
  review: 'Revisión de calidad',
  catalog: 'Catálogo',
  schema_version: 'Versión del formato',
};

const KEY_LABELS: Record<string, string> = {
  enabled: 'activado',
  channel_ids: 'números',
  model: 'modelo',
  name: 'nombre',
  industry: 'rubro',
  branches: 'sucursal',
  address: 'dirección',
  hours: 'horario',
  phone: 'teléfono',
  notes: 'notas',
  service_hours: 'horario de atención',
  payment_methods: 'medio de pago',
  shipping: 'envíos',
  website: 'sitio web',
  email: 'email',
  faqs: 'pregunta frecuente',
  question: 'pregunta',
  answer: 'respuesta',
  policies: 'políticas',
  returns: 'cambios y devoluciones',
  warranty: 'garantía',
  financing: 'financiación',
  persona: 'asistente',
  tone: 'tono',
  custom_instructions: 'instrucciones',
  sales_guidance: 'guía de sugerencias',
  business_rules: 'regla',
  text: 'texto',
  offers: 'oferta',
  description: 'descripción',
  when: 'cuándo',
  must_not: 'nunca debe',
  fields: 'dato',
  label: 'nombre',
  how_to_ask: 'cómo preguntarlo',
  required: 'obligatorio',
  priority: 'prioridad',
  options: 'opción',
  discovery_guidance: 'guía de descubrimiento',
  max_questions_per_message: 'preguntas por mensaje',
  max_qualification_turns: 'mensajes para calificar',
  max_turns_when_hot: 'mensajes con un lead caliente',
  dimensions: 'aspecto',
  weight: 'peso',
  completeness_weight: 'peso de los datos obligatorios',
  thresholds: 'umbrales',
  hot: 'caliente',
  warm: 'tibio',
  triggers: 'disparador',
  custom_triggers: 'situación propia',
  mode: 'modo',
  intro: 'texto de introducción',
  keywords: 'palabras',
  extra: 'frases extra',
  exclude: 'frases a ignorar',
  message_in_hours: 'texto en horario',
  message_after_hours: 'texto fuera de horario',
  qualify_after_hours: 'calificar fuera de horario',
  unsupported_media: 'audios e imágenes',
  sellers_see_all_channels: 'vendedores ven todos los números',
  auto_close_after_days: 'cierre automático',
  max_per_day: 'revisiones por día',
  criteria: 'criterio',
  guidance: 'indicaciones',
  weekly_digest: 'resumen semanal',
  allowed_domains: 'dominio permitido',
  price_policy: 'precio a citar',
  extractor: 'extractor',
  synonyms: 'sinónimo',
  key_attributes: 'atributo clave',
  ...TRIGGER_LABELS,
};

/** "business.branches.0.name" → "Negocio · sucursal 1 · nombre": en palabras de negocio y la posición desde 1. */
export function describePath(path: string): string {
  const [section, ...rest] = path.split('.');
  const tail = rest.map((part) =>
    /^\d+$/.test(part) ? String(Number(part) + 1) : (KEY_LABELS[part] ?? part.replace(/_/g, ' ')),
  );
  return [SECTION_LABELS[section!] ?? section, ...tail].join(' · ');
}

/** Sección (ruta del panel) de un campo, para llevar a la persona al error del servidor. */
export function sectionOf(path: (string | number)[]): string {
  const top = String(path[0] ?? '');
  const map: Record<string, string> = {
    ai: 'general',
    business: 'negocio',
    knowledge: 'conocimiento',
    agent: 'personalidad',
    qualification: 'calificacion',
    scoring: 'puntaje',
    handoff: 'derivacion',
    inbox: 'bandeja',
    review: 'bandeja',
  };
  return map[top] ?? 'general';
}

/** ¿El campo pide un dato que el servidor va a rechazar (DNI, tarjeta, CBU…)? La misma regla que el schema. */
export function asksSensitiveData(field: { key: string; label: string; how_to_ask: string }): boolean {
  return [field.key.replace(/_/g, ' '), field.label, field.how_to_ask].some((text) =>
    SENSITIVE_FIELD_PATTERN.test(normalizeText(text)),
  );
}

/** Clave válida (minúsculas, números y _) a partir de un texto. */
export function keyFrom(text: string, prefix = ''): string {
  const base = normalizeText(text)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
  const key = `${prefix}${base || 'item'}`;
  return /^[a-z]/.test(key) ? key : `k_${key}`;
}
