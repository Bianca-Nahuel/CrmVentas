// Sección `catalog` de la configuración de una empresa (tarea 007). Qué páginas se pueden leer, qué
// precio puede citar el agente y cómo se extraen los datos de la web. Nada de un negocio puntual va en el
// código: los selectores, los dominios y los sinónimos salen de acá.
import { z } from 'zod';

/** Campos que el extractor configurable puede sacar de la página de un producto. */
export const EXTRACTOR_FIELDS = [
  'list_price',
  'promo_price',
  'promo_condition',
  'price_no_taxes',
  'price_unit',
  'units_per_package',
  'pieces_per_package',
  'availability',
  'description',
] as const;
export type ExtractorField = (typeof EXTRACTOR_FIELDS)[number];

export const EXTRACTOR_PARSERS = ['price_ar', 'number_ar', 'integer', 'text'] as const;
export type ExtractorParser = (typeof EXTRACTOR_PARSERS)[number];

/** Unidades de venta de un producto. */
export const CATALOG_UNITS = ['m2', 'ml', 'unit', 'box', 'kg', 'l'] as const;
export type CatalogUnit = (typeof CATALOG_UNITS)[number];

const str = (min: number, max: number) => z.string().trim().min(min).max(max);
const key = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'clave en minúsculas, números y _');

/** Un host exacto (sin esquema, puerto ni comodines), con al menos un punto y que no sea una IP. */
export const catalogHostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/,
    'host sin esquema, puerto ni comodines (ej. www.ejemplo.com.ar)',
  )
  .refine((host) => /[a-z]/.test(host.split('.').at(-1)!), 'no puede ser una IP');

/**
 * Cuantificador aplicado a un grupo que ya tiene uno adentro o una alternativa ("(a+)+", "(a|a)*"): la
 * forma típica de un backtracking catastrófico (ReDoS). Se rechaza al cargar la config.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  return /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\}|\|)(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/.test(pattern);
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern, 'iu');
    return true;
  } catch {
    return false;
  }
}

const extractorRuleSchema = z
  .object({
    // CSS. La sintaxis completa la valida el backend al cargar la config (css-select).
    selector: str(1, 200),
    // Atributo del nodo (content, data-price…); por defecto, su texto.
    attribute: z
      .string()
      .regex(/^[a-z][a-z0-9_:-]{0,39}$/)
      .optional(),
    index: z.number().int().min(0).max(20).default(0),
    // Sobre el texto del nodo (cortado): se usa el grupo 1, o todo lo que coincide si no hay grupos.
    regex: str(1, 200)
      .refine(compiles, 'expresión regular inválida')
      .refine((pattern) => !hasNestedQuantifier(pattern), 'cuantificadores anidados (riesgo de ReDoS)')
      .optional(),
    parse: z.enum(EXTRACTOR_PARSERS).optional(),
    // true: le gana a JSON-LD, microdatos y metaetiquetas para este campo.
    prefer: z.boolean().default(false),
    // true: el campo sale solo de esta regla. Si no da un valor queda vacío, aunque lo traigan JSON-LD,
    // microdatos o metaetiquetas (por ejemplo, un JSON-LD que publica el precio promocional como único precio).
    // Con exclusive, prefer no hace falta (no hay otra fuente a la que ganarle).
    exclusive: z.boolean().default(false),
  })
  .strict();
export type ExtractorRule = z.infer<typeof extractorRuleSchema>;

const extractorSchema = z
  .object({
    fields: z
      .object(
        Object.fromEntries(
          EXTRACTOR_FIELDS.map((field) => [field, extractorRuleSchema.optional()]),
        ) as Record<ExtractorField, z.ZodOptional<typeof extractorRuleSchema>>,
      )
      .strict(),
    // Frases (sin tildes ni mayúsculas) que traducen el texto de disponibilidad de la página.
    availability_map: z
      .object({
        in_stock: z.array(str(1, 60)).max(10).default([]),
        out_of_stock: z.array(str(1, 60)).max(10).default([]),
      })
      .strict()
      .default({ in_stock: [], out_of_stock: [] }),
  })
  .strict();
export type ExtractorConfig = z.infer<typeof extractorSchema>;

export const catalogConfigSchema = z
  .object({
    enabled: z.boolean(),
    // Hosts exactos de los que se pueden leer páginas (y a los que puede apuntar una URL del Excel).
    allowed_domains: z.array(catalogHostname).min(1).max(5),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default('ARS'),
    // De dónde sale el precio que se cita: la web, el Excel o el más reciente de los dos.
    price_source: z.enum(['web', 'excel', 'latest']).default('web'),
    price_policy: z
      .object({
        // Qué precio puede citar el agente.
        quote: z.enum(['none', 'list', 'promo', 'both']),
        // Agrega el precio sin impuestos nacionales cuando está.
        show_no_taxes: z.boolean().default(false),
        // Texto fijo después de un precio ("Precio sujeto a cambios."). Vacío = sin nota.
        note: str(0, 120).default('Precio sujeto a cambios.'),
      })
      .strict(),
    // Antigüedad máxima de una lectura de la web para citarla (y para no volver a leer la página).
    max_price_age_minutes: z.number().int().min(5).max(10_080).default(720),
    // Antigüedad máxima de un precio o un stock del Excel para citarlo.
    excel_max_age_days: z.number().int().min(1).max(365).default(30),
    // Control de cordura: un precio que cambia más que esto respecto de la última lectura válida no se usa.
    max_price_change_pct: z.number().int().min(1).max(500).default(40),
    // De dónde sale la disponibilidad. none = el agente nunca la informa.
    availability_source: z.enum(['none', 'web', 'excel']).default('none'),
    extractor: extractorSchema.nullable().default(null),
    // "piso" → ["porcelanato", "ceramica"]: se suman a la búsqueda.
    synonyms: z
      .array(z.object({ term: str(1, 40), equivalents: z.array(str(1, 40)).min(1).max(10) }).strict())
      .max(50)
      .default([]),
    // Atributos del Excel (clave normalizada) que devuelve buscar_productos.
    key_attributes: z.array(key).max(8).default([]),
    // Refresco de fondo de los productos más consultados de la semana.
    refresh: z
      .object({
        enabled: z.boolean().default(false),
        top_n: z.number().int().min(1).max(30).default(10),
      })
      .strict()
      .default({ enabled: false, top_n: 10 }),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    if (new Set(catalog.allowed_domains).size !== catalog.allowed_domains.length) {
      ctx.addIssue({ code: 'custom', path: ['allowed_domains'], message: 'dominio repetido' });
    }
  });

export type CatalogConfig = z.infer<typeof catalogConfigSchema>;

/** La otra variante de un host: con www si no lo tiene, sin www si lo tiene. */
export function wwwVariant(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : `www.${host}`;
}

/**
 * Avisos (no errores) de la sección catalog. Hoy: un dominio permitido sin su variante con o sin www.
 * Si una URL del Excel o una redirección de la web va a esa variante, se rechaza.
 */
export function catalogConfigWarnings(catalog: CatalogConfig | undefined): string[] {
  if (!catalog) return [];
  const warnings: string[] = [];
  for (const host of catalog.allowed_domains) {
    const variant = wwwVariant(host);
    if (!catalog.allowed_domains.includes(variant)) {
      warnings.push(
        `catalog.allowed_domains tiene ${host} pero no ${variant}: una URL o una redirección a ${variant} se va a rechazar.`,
      );
    }
  }
  return warnings;
}
