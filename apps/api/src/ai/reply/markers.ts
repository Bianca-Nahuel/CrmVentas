// Marcas del catálogo en la respuesta del modelo (tarea 007). El modelo escribe la marca y el código pone
// el valor, sacado de lo que devolvieron las herramientas en este turno:
//
//   marca  := "{{" tipo ":" SKU [":" arg] "}}"          (se toleran espacios alrededor de los ":")
//   {{precio:SKU:lista}} {{precio:SKU:promo}}  precio vigente, del tipo permitido por price_policy
//   {{link:SKU}}                                 la URL del producto
//   {{cajas:SKU:45}}                             cajas para cubrir 45 (m² o la unidad del producto) y el total
//   {{por_caja:SKU}}                             m² (o unidades) y piezas por caja
//   {{stock:SKU}}                                disponibilidad informada por la fuente configurada
//   SKU := [A-Za-z0-9._/-]{1,64}                 arg de cajas := \d{1,6}([.,]\d{1,2})?
//
// Una marca vale solo si el producto lo devolvió una herramienta EN ESTE TURNO (precio y stock: ver_producto)
// y el dato está vigente. Si una sola marca no vale, la respuesta entera se bloquea y se deriva.
import { formatArMoney, formatArNumber, packagesFor, parseArNumber } from '../../catalog/decimal.js';
import { urlError } from '../../catalog/import/normalize-rows.js';
import { localTime } from './business-hours.js';
import type { TurnCatalogContext } from '../tools/turn-catalog-context.js';

export const MAX_MARKERS_PER_REPLY = 6;
const MARKER =
  /\{\{\s*(precio|link|cajas|por_caja|stock)\s*:\s*([A-Za-z0-9._/-]{1,64})\s*(?::\s*([^{}]{1,20}?)\s*)?\}\}/g;
/** Lo que ocupa el lugar de una marca mientras corren los controles de salida. */
export const MARKER_PLACEHOLDER = 'dato';

export type MarkerKind = 'precio' | 'link' | 'cajas' | 'por_caja' | 'stock';

export interface Marker {
  kind: MarkerKind;
  sku: string;
  arg: string | null;
  start: number;
  end: number;
}

export function parseMarkers(text: string): { markers: Marker[]; template: string } {
  const markers: Marker[] = [];
  let template = '';
  let last = 0;
  for (const match of text.matchAll(MARKER)) {
    markers.push({
      kind: match[1] as MarkerKind,
      sku: match[2]!,
      arg: match[3]?.trim() ?? null,
      start: match.index,
      end: match.index + match[0].length,
    });
    template += `${text.slice(last, match.index)}${MARKER_PLACEHOLDER}`;
    last = match.index + match[0].length;
  }
  return { markers, template: template + text.slice(last) };
}

const UNIT_PHRASE: Record<string, string> = {
  m2: 'por m²',
  ml: 'por metro lineal',
  unit: 'por unidad',
  box: 'por caja',
  kg: 'por kg',
  l: 'por litro',
};
const UNIT_SHORT: Record<string, string> = {
  m2: 'm²',
  ml: 'm',
  unit: 'unidades',
  box: 'cajas',
  kg: 'kg',
  l: 'l',
};

type Rendered = { ok: true; value: string } | { ok: false };

/** Valida y renderiza una marca. No registra nada (eso lo hace renderMarkers con el texto final). */
function renderOne(
  marker: Marker,
  context: TurnCatalogContext,
): Rendered & { citation?: Parameters<TurnCatalogContext['cite']>[0] } {
  const fail: Rendered = { ok: false };
  const product = context.product(marker.sku);
  if (!product) return fail;
  const { catalog } = context;
  switch (marker.kind) {
    case 'precio': {
      if (marker.arg !== 'lista' && marker.arg !== 'promo') return fail;
      const view = context.view(marker.sku);
      if (!view?.price?.current) return fail;
      const quote = catalog.price_policy.quote;
      const snapshot = view.price.snapshot;
      const unit = UNIT_PHRASE[snapshot.priceUnit ?? product.unit] ?? '';
      let value: string;
      if (marker.arg === 'lista') {
        if ((quote !== 'list' && quote !== 'both') || !snapshot.listPrice) return fail;
        value = `${formatArMoney(snapshot.listPrice)} ${unit}`.trim();
      } else {
        if ((quote !== 'promo' && quote !== 'both') || !snapshot.promoPrice) return fail;
        value = `${formatArMoney(snapshot.promoPrice)} ${unit}`.trim();
        if (snapshot.promoCondition) value += ` (${snapshot.promoCondition})`;
      }
      if (catalog.price_policy.show_no_taxes && snapshot.priceNoTaxes) {
        value += ` (sin impuestos nacionales: ${formatArMoney(snapshot.priceNoTaxes)})`;
      }
      return {
        ok: true,
        value,
        citation: {
          kind: 'precio',
          sku: product.sku,
          price_type: marker.arg,
          snapshot_id: snapshot.id,
          source: view.price.source,
        },
      };
    }
    case 'link':
      // Se revalida contra los dominios vigentes (un revert puede reaplicar una URL de una config vieja).
      if (marker.arg !== null || !product.url || urlError(product.url, catalog.allowed_domains) !== null)
        return fail;
      return { ok: true, value: product.url, citation: { kind: 'link', sku: product.sku } };
    case 'cajas': {
      const { units } = context.perPackage(marker.sku);
      if (!units || (product.unit !== 'm2' && product.unit !== 'ml') || marker.arg === null) return fail;
      if (!/^\d{1,6}([.,]\d{1,2})?$/.test(marker.arg)) return fail;
      const quantity = parseArNumber(marker.arg.replace('.', ','));
      // La cantidad tiene que ser una que calculó calcular_cantidad en este turno: el modelo no la inventa.
      // Y una que dijo el cliente (el modelo pudo pedirle a calcular_cantidad otra cantidad).
      if (
        !quantity ||
        !context.calculated(marker.sku).includes(quantity) ||
        !context.clientNumbers.includes(quantity)
      ) {
        return fail;
      }
      const { packages, total } = packagesFor(quantity, units);
      const boxes = packages === 1 ? '1 caja' : `${packages} cajas`;
      return {
        ok: true,
        value: `${boxes} (${formatArNumber(total)} ${UNIT_SHORT[product.unit]})`,
        citation: { kind: 'cajas', sku: product.sku },
      };
    }
    case 'por_caja': {
      const { units, pieces } = context.perPackage(marker.sku);
      if (marker.arg !== null || (!units && !pieces)) return fail;
      const parts = [
        units ? `${formatArNumber(units)} ${UNIT_SHORT[product.unit] ?? ''}`.trim() : null,
        pieces ? `${pieces} ${pieces === 1 ? 'pieza' : 'piezas'}` : null,
      ].filter(Boolean);
      return {
        ok: true,
        value: `${parts.join(', ')} por caja`,
        citation: { kind: 'por_caja', sku: product.sku },
      };
    }
    case 'stock': {
      if (marker.arg !== null || catalog.availability_source === 'none') return fail;
      const availability = context.view(marker.sku)?.availability;
      if (!availability?.current) return fail;
      const { snapshot } = availability;
      const where = snapshot.source === 'web' ? 'en la web' : 'en nuestra lista';
      const local = localTime(snapshot.readAt, context.timezone);
      const [, month, day] = local.date.split('-');
      const status = availability.value === 'in_stock' ? 'figura con stock' : 'figura sin stock';
      return {
        ok: true,
        value: `${status} ${where} (consultado el ${day}/${month} ${local.time})`,
        citation: { kind: 'stock', sku: product.sku, snapshot_id: snapshot.id, source: snapshot.source },
      };
    }
  }
}

/** ¿Todas las marcas valen? (no registra citas). */
export function markersValid(markers: Marker[], context: TurnCatalogContext | undefined): boolean {
  if (markers.length === 0) return true;
  if (!context || markers.length > MAX_MARKERS_PER_REPLY) return false;
  return markers.every((marker) => renderOne(marker, context).ok);
}

/** ¿La respuesta informa la disponibilidad con una marca de stock válida? */
export function answersAvailability(reply: string | null, context: TurnCatalogContext | undefined): boolean {
  if (!reply || !context) return false;
  const { markers } = parseMarkers(reply);
  return markers.some((marker) => marker.kind === 'stock') && markersValid(markers, context);
}

/**
 * Reemplaza las marcas por sus valores (ya validadas) y registra las citas. Si hubo algún precio, agrega
 * una vez al final la nota de la empresa ("Precio sujeto a cambios.").
 */
export function renderMarkers(
  text: string,
  markers: Marker[],
  context: TurnCatalogContext | undefined,
): string {
  if (markers.length === 0 || !context) return text;
  let out = '';
  let last = 0;
  let priced = false;
  for (const marker of markers) {
    const rendered = renderOne(marker, context);
    if (!rendered.ok) throw new Error('renderMarkers con una marca inválida');
    if (rendered.citation) context.cite(rendered.citation);
    if (marker.kind === 'precio') priced = true;
    out += text.slice(last, marker.start) + rendered.value;
    last = marker.end;
  }
  out += text.slice(last);
  const note = context.catalog.price_policy.note;
  return priced && note ? `${out.trimEnd()} ${note}` : out;
}
