// Herramientas del catálogo para el agente (tarea 007): buscar_productos, ver_producto y
// calcular_cantidad. Solo ven el catálogo de la empresa de la conversación (el CatalogStore va atado a
// ella). Nunca devuelven montos ni cantidades calculadas: devuelven marcas, y el código pone los valores
// al armar la respuesta (markers.ts). Lo que devuelven es dato no confiable (sale del Excel o de la web):
// el cliente de OpenRouter lo manda escapado dentro de <resultado_herramienta>.
import { normalizeText } from '@ventas/shared';
import { z } from 'zod';
import { canonical } from '../../catalog/decimal.js';
import type { CatalogViewer } from '../../catalog/catalog-viewer.js';
import type { CatalogStore, SnapshotSource } from '../../catalog/catalog.types.js';
import type { LlmTool } from '../llm/llm-client.js';
import type { TurnCatalogContext } from './turn-catalog-context.js';

export const CATALOG_TOOL_NAMES = ['buscar_productos', 'ver_producto', 'calcular_cantidad'] as const;
const MAX_RESULTS = 5;
const ATTRIBUTE_CHARS = 100;
const DESCRIPTION_CHARS = 300;
// Atributos del Excel que parecen de stock no se le muestran al modelo: la disponibilidad solo sale de
// availability_source y de la marca {{stock:SKU}}.
const STOCK_LIKE_KEY = /stock|existen|dispon|inventario|cantidad/;

export interface CatalogToolDeps {
  store: CatalogStore;
  viewer: CatalogViewer;
  context: TurnCatalogContext;
}

const sku = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._/-]{1,64}$/);

const searchArgs = z
  .object({
    query: z.string().trim().min(1).max(100).describe('Qué busca el cliente, en pocas palabras'),
    limit: z.number().int().min(1).max(MAX_RESULTS).optional(),
    precio_max: z
      .number()
      .positive()
      .max(1_000_000_000)
      .optional()
      .describe('Solo si el cliente dijo un precio máximo: el número que dijo (sin símbolos)'),
    orden: z.enum(['relevancia', 'precio_asc', 'precio_desc']).optional(),
  })
  .strict();
const viewArgs = z.object({ sku }).strict();
const calcArgs = z
  .object({
    sku,
    cantidad: z.number().positive().max(100_000).describe('La cantidad que dijo el cliente'),
    unidad: z.enum(['m2', 'ml']).describe('La unidad de esa cantidad'),
  })
  .strict();

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

function truncate(value: unknown, max: number): string | number | boolean {
  if (typeof value !== 'string') return value as number | boolean;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Palabras de la búsqueda (sin tildes) más los sinónimos de la empresa. */
export function searchTerms(query: string, synonyms: { term: string; equivalents: string[] }[]) {
  const text = normalizeText(query);
  const words = (value: string) => value.match(/[a-z0-9]+/g) ?? [];
  const terms = new Set(words(text).filter((word) => word.length >= 2));
  for (const synonym of synonyms) {
    const term = normalizeText(synonym.term);
    if (` ${words(text).join(' ')} `.includes(` ${words(term).join(' ')} `)) {
      for (const equivalent of synonym.equivalents)
        words(normalizeText(equivalent)).forEach((word) => terms.add(word));
    }
  }
  return { text, terms: [...terms] };
}

function priceSources(source: 'web' | 'excel' | 'latest'): SnapshotSource[] {
  return source === 'latest' ? ['web', 'excel'] : [source];
}

export function buildCatalogTools({ store, viewer, context }: CatalogToolDeps): LlmTool[] {
  const { catalog } = context;

  const buscar: LlmTool<z.infer<typeof searchArgs>> = {
    name: 'buscar_productos',
    description:
      'Busca productos del catálogo del negocio por texto (acepta sinónimos y errores de tipeo). Devuelve hasta 5 productos con su SKU, sin precios. Con precio_max filtra por precio y con orden precio_asc/precio_desc los ordena por precio (el monto nunca se devuelve).',
    parameters: jsonSchema(searchArgs),
    args: searchArgs,
    async execute(args) {
      const limit = args.limit ?? MAX_RESULTS;
      const { text, terms } = searchTerms(args.query, catalog.synonyms);
      const maxPrice = args.precio_max === undefined ? null : canonical(args.precio_max);
      const order =
        args.orden === 'precio_asc' ? 'price_asc' : args.orden === 'precio_desc' ? 'price_desc' : 'relevance';
      const hits = await store.search({
        terms,
        text,
        limit,
        maxPrice,
        order,
        priceSources: priceSources(catalog.price_source),
        usePromo: catalog.price_policy.quote === 'promo' || catalog.price_policy.quote === 'both',
      });
      const now = context.now.getTime();
      const results = hits.slice(0, limit).map(({ product, priceReadAt }) => {
        context.noteFound('buscar_productos', product);
        const attributes = Object.fromEntries(
          catalog.key_attributes
            .filter((key) => product.attributes[key] !== undefined && !STOCK_LIKE_KEY.test(key))
            .map((key) => [key, truncate(product.attributes[key], ATTRIBUTE_CHARS)]),
        );
        return {
          sku: product.sku,
          nombre: product.name,
          categoria: product.category,
          unidad: product.unit,
          atributos: attributes,
          tiene_link: product.url !== null,
          precio_antiguedad_min: priceReadAt
            ? Math.max(0, Math.round((now - priceReadAt.getTime()) / 60_000))
            : null,
        };
      });
      return {
        resultados: results,
        hay_mas: hits.length > limit,
        ...(maxPrice !== null ? { filtrado_por_precio: true } : {}),
        ...(order !== 'relevance'
          ? { ordenado_por_precio: order === 'price_asc' ? 'menor_a_mayor' : 'mayor_a_menor' }
          : {}),
      };
    },
  };

  const ver: LlmTool<z.infer<typeof viewArgs>> = {
    name: 'ver_producto',
    description:
      'Datos de un producto por su SKU (de buscar_productos): si su precio se puede citar y con qué marca, si se puede informar la disponibilidad, unidad, m² o piezas por caja, link y descripción. Lee la página del producto si hace falta.',
    parameters: jsonSchema(viewArgs),
    args: viewArgs,
    async execute(args) {
      const view = await viewer.view(store, catalog, args.sku);
      if (!view) return { encontrado: false };
      context.noteView(view);
      const { product, price } = view;
      const quote = catalog.price_policy.quote;
      const types: ('lista' | 'promo')[] = [];
      if (price?.current) {
        if ((quote === 'list' || quote === 'both') && price.snapshot.listPrice) types.push('lista');
        if ((quote === 'promo' || quote === 'both') && price.snapshot.promoPrice) types.push('promo');
      }
      const priceReason =
        quote === 'none'
          ? 'el negocio no informa precios por este medio'
          : !price
            ? 'no hay un precio cargado'
            : !price.current
              ? 'el último precio está vencido o no se pudo leer'
              : types.length === 0
                ? 'no hay un precio del tipo que el negocio permite citar'
                : null;
      const { units, pieces } = context.perPackage(product.sku);
      const availability = view.availability;
      const availabilityReason =
        catalog.availability_source === 'none'
          ? 'el negocio no informa disponibilidad por este medio'
          : !availability
            ? 'la fuente no muestra la disponibilidad'
            : !availability.current
              ? 'el dato de disponibilidad está vencido'
              : null;
      return {
        encontrado: true,
        sku: product.sku,
        nombre: product.name,
        categoria: product.category,
        unidad: product.unit,
        precio:
          priceReason === null
            ? {
                citable: true,
                tipos: types,
                marcas: types.map((type) => `{{precio:${product.sku}:${type}}}`),
                tiene_condicion: types.includes('promo') && !!price!.snapshot.promoCondition,
              }
            : { citable: false, motivo: priceReason },
        disponibilidad:
          availabilityReason === null
            ? { informable: true, marca: `{{stock:${product.sku}}}` }
            : { informable: false, motivo: availabilityReason },
        por_caja: units || pieces ? { marca: `{{por_caja:${product.sku}}}` } : null,
        calculo_de_cajas: !!units && (product.unit === 'm2' || product.unit === 'ml'),
        link: product.url ? { marca: `{{link:${product.sku}}}` } : null,
        descripcion: view.web?.description ? truncate(view.web.description, DESCRIPTION_CHARS) : null,
        atributos: Object.fromEntries(
          catalog.key_attributes
            .filter((key) => product.attributes[key] !== undefined && !STOCK_LIKE_KEY.test(key))
            .map((key) => [key, truncate(product.attributes[key], ATTRIBUTE_CHARS)]),
        ),
      };
    },
  };

  const calcular: LlmTool<z.infer<typeof calcArgs>> = {
    name: 'calcular_cantidad',
    description:
      'Cuántas cajas hacen falta para cubrir una cantidad (m² o metros) de un producto, redondeando hacia arriba. La cuenta la hace el sistema: devuelve la marca a escribir en la respuesta.',
    parameters: jsonSchema(calcArgs),
    args: calcArgs,
    async execute(args) {
      let product = context.product(args.sku);
      if (!product) {
        const found = await store.findProduct(args.sku);
        if (!found) return { posible: false, motivo: 'no existe ese producto' };
        context.noteFound('calcular_cantidad', found);
        product = found;
      } else {
        context.consulted.push({ tool: 'calcular_cantidad', sku: product.sku });
      }
      if (product.unit !== args.unidad) {
        return { posible: false, motivo: `el producto se vende por ${product.unit}, no por ${args.unidad}` };
      }
      const { units } = context.perPackage(product.sku);
      if (!units)
        return { posible: false, motivo: 'no se sabe cuánto trae cada caja (probá con ver_producto)' };
      const quantity = canonical(args.cantidad);
      if (!quantity || !/^\d{1,6}(\.\d{1,2})?$/.test(quantity)) {
        return { posible: false, motivo: 'cantidad fuera de rango' };
      }
      context.noteCalculated(product.sku, quantity);
      return { posible: true, marca: `{{cajas:${product.sku}:${quantity.replace('.', ',')}}}` };
    },
  };

  return [buscar, ver, calcular] as LlmTool[];
}
