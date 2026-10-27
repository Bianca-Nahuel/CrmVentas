# Tarea 007: catálogo desde Excel con link a la web de cada producto

## Contexto

La 006 dejó el agente configurable, con puntaje, calificación, disparadores de derivación y un ciclo de
herramientas (tool calling) sin herramientas registradas. Esta tarea le da al agente el catálogo de la empresa:

- **Excel** con los productos (todas sus columnas se cargan en la base) y un **link a la página web de cada
  producto**;
- el backend **lee esa página** para constatar precio, stock, descripción y datos extra;
- si el agente no puede responder algo con certeza (por ejemplo, disponibilidad cuando la web no la muestra),
  **deriva rápido** con el disparador que corresponda.

Caso real de referencia: la web de Lecer muestra en cada producto el precio de lista por m², un precio
promocional con su condición (por ejemplo "30 % OFF, 1 cuota MP"), el precio sin impuestos nacionales, y la
unidad de venta (m² por caja y piezas por caja). **No muestra stock.** No tiene datos estructurados
(schema.org) visibles, así que hace falta un extractor configurable.

## Objetivo

- Importar el Excel con mapeo de columnas, vista previa de cambios y posibilidad de volver atrás.
- Leer la página del producto de forma segura (solo el dominio de la empresa), con caché y controles de cordura.
- Herramientas para el agente: buscar productos, ver un producto, calcular cantidades.
- Precios y links que **escribe el código**, nunca el modelo.

## Antes de empezar

1. Leé `CLAUDE.md`, `.claude/rules/ia.md`, el skill `ejecutar-tarea`, el ciclo de herramientas del
   `LlmClient` y `decide` de la 006.
2. Proponé las librerías para leer `.xlsx` y para parsear HTML (licencia, mantenimiento, tamaño). **No
   instales nada sin mi OK.**

## Pasos / requisitos

### 1. Tablas (convenciones de la 003: `tenant_id`, RLS forzada, grants mínimos, sin `DELETE`)

- **`catalog_products`:** `sku` (UNIQUE por empresa), `name`, `category`, `unit` (`m2 | unit | box | ...`),
  `units_per_package` (por ejemplo, m² por caja) y `pieces_per_package`, `url`, `attributes jsonb` (**todas
  las demás columnas del Excel**, con el encabezado normalizado como clave), `active`, timestamps.
  - Búsqueda: `tsvector` generado con `unaccent` sobre nombre, categoría y atributos de texto, índice GIN, e
    índice `pg_trgm` sobre el nombre.
- **`catalog_imports`:** archivo (nombre, hash, tamaño), mapeo usado, estado (`preview | applied |
reverted | failed`), conteos (nuevos, cambiados, sin cambios, ausentes) y quién lo hizo.
- **`catalog_import_rows`:** filas de la importación ya normalizadas, con el resultado de la validación por
  fila. Se usa para la vista previa y para volver a la importación anterior.
- **`product_snapshots`:** cada lectura de un producto, con `source` (`web | excel`), `read_at`, `ok`,
  `error_code`, los precios extraídos (`list_price`, `promo_price`, `promo_condition`, `price_no_taxes`,
  todos `numeric` con `currency`), `price_unit`, `availability` (`in_stock | out_of_stock | unknown`),
  `description`, `extra jsonb`. Es solo de agregado: se guarda el historial.
- **`tenant_configs.config.catalog`** (nueva sección, validada con zod):
  - `allowed_domains`;
  - `price_policy`: qué precio puede citar el agente (`none | list | promo | both`) y si aclara la condición
    y "sujeto a cambios";
  - `max_price_age_minutes`;
  - `availability_source`: `none | web | excel`;
  - `extractor` (ver punto 3);
  - `synonyms` (por ejemplo, "piso" → "porcelanato", "cerámica").

### 2. Importación del Excel

`npm run dev:import-catalog -- --tenant <id> --file <ruta.xlsx> [--mapping <ruta.json>] [--apply <importId>]`:

- **Mapeo:** columnas a campos (`sku` y `name` obligatorios; `url`, `category`, `unit`, `units_per_package`,
  `price`, `stock` opcionales). El resto va a `attributes`. El mapeo se guarda por empresa para la próxima vez.
- **Validaciones:** SKU repetido en el archivo; URL que no es `https` o cuyo dominio no está en
  `allowed_domains`; números mal formados (con coma o punto según la configuración regional argentina).
  Además, máximos de tamaño de archivo, filas y largo de celda.
- **Vista previa:** nuevos, cambiados (qué cambió), sin cambios y ausentes del archivo; los precios que
  cambiaron más de un 40 % quedan marcados.
- **Aplicar:** en una transacción. Los ausentes se marcan `active = false`, no se borran. **Volver atrás:**
  reaplicar la importación anterior.
- El contenido de las celdas es **dato no confiable**: nunca se interpreta como instrucción y va escapado
  cuando llega al modelo.

### 3. Lectura de la página del producto

`ProductPageReader.read(tenantId, sku)`:

- **Seguridad (SSRF):**
  - solo `https`, y el host del `url` tiene que estar en `allowed_domains`;
  - resolver el DNS y rechazar IPs privadas, de loopback o link-local;
  - redirecciones solo dentro de los dominios permitidos, como mucho 3;
  - timeout de 8 s, máximo 2 MB y solo `text/html`;
  - un `User-Agent` que identifique al sistema;
  - límite de pedidos por dominio (por ejemplo, 1 por segundo).
- **Extracción, en orden:** JSON-LD (`Product`/`Offer`), microdatos, metaetiquetas y, por último, el
  `extractor` configurado por empresa: selectores CSS o expresiones regulares para cada campo (`list_price`,
  `promo_price`, `promo_condition`, `price_no_taxes`, `price_unit`, `units_per_package`,
  `pieces_per_package`, `availability`, `description`).
  - Parseo de precios en formato argentino (`$37.290` → 37290).
- **Controles de cordura:** formato válido, mayor que cero, y cambio de no más del 40 % respecto del último
  `ok` (configurable). Si no pasa → `ok = false` con `error_code`, se usa el último snapshot válido con su
  fecha y se registra un aviso.
- **Caché:** si el último snapshot `ok` tiene menos de `max_price_age_minutes`, no se lee la página. Un
  trabajo de fondo refresca los productos más consultados de la semana.
- Script `npm run dev:test-extractor -- --tenant <id> --url <url>`, que muestra los campos extraídos y de
  dónde salió cada uno. Sirve para configurar el extractor de una empresa nueva.
- Al modelo **nunca** le llega el HTML: solo los campos extraídos y validados.

### 4. Herramientas para el agente (registradas en el ciclo de la 006)

- **`buscar_productos(query, limit ≤ 5)`:** texto completo + trigramas + sinónimos sobre los productos
  activos. Devuelve `sku`, nombre, categoría, atributos clave, unidad, si tiene link y la antigüedad del
  último precio.
- **`ver_producto(sku)`:** lee la página con caché y devuelve:
  - precios disponibles con su tipo y condición;
  - unidad y m² o piezas por caja;
  - `availability`;
  - descripción corta y datos extra;
  - fecha de lectura y si está vigente según `max_price_age_minutes`.
- **`calcular_cantidad(sku, cantidad, unidad)`:** convierte, por ejemplo, m² → cajas (redondeando hacia
  arriba) y devuelve los m² que efectivamente se llevan. La cuenta la hace el código.
- Máximo 3 llamadas a herramientas por turno. Los resultados van delimitados y escapados, igual que la conversación.
- Las herramientas solo ven el catálogo de la empresa de la conversación (RLS) y registran en `ai_runs` qué
  productos consultaron y qué snapshot usaron.

### 5. Marcas en la respuesta (el código pone el valor)

- El modelo escribe `{{precio:SKU:lista}}`, `{{precio:SKU:promo}}`, `{{link:SKU}}` o `{{cajas:SKU:m2}}`.
- `parseMarkers` (que la 006 dejó preparado) acepta esa gramática. Cada marca es válida solo si:
  - el SKU fue devuelto por una herramienta **en este turno**;
  - para un precio, el snapshot está vigente y el tipo de precio está permitido por `price_policy`.
- `render` reemplaza la marca por el valor de la base, formateado (`$37.290 por m²`, con la condición si es
  promocional). Si cualquier marca es inválida → la respuesta se bloquea y se deriva.
- El control `money` sigue bloqueando cualquier monto escrito a mano por el modelo.

### 6. Reglas para lo que el agente no puede responder

- `availability = unknown`, o `availability_source = none` → nunca se dice que hay o que no hay. Una
  pregunta por disponibilidad activa el disparador `availability` de la 006, con el `mode` que tenga la
  empresa (por ejemplo `after_fields: [producto, m2]` y después derivar).
- Precio vencido o con la lectura fallida → no se cita: se usa el disparador `cannot_answer` o se deriva
  según la config.
- Producto que no aparece en la búsqueda → no inventa: pregunta para precisar o deriva.
- Agregá a la capa fija: los datos de productos salen **solo** de las herramientas; los precios y links se
  escriben **solo** con marcas.

## Criterios de aceptación

- [ ] El Excel se importa con todas sus columnas, con vista previa, y se puede volver atrás.
- [ ] El backend solo lee páginas de los dominios permitidos de esa empresa, con las protecciones de SSRF.
- [ ] Ningún precio, cantidad o link de la respuesta lo escribe el modelo: todos salen de marcas validadas.
- [ ] Sin stock confiable, el agente nunca afirma disponibilidad y deriva según la config.
- [ ] `npm run test`, `npm run lint` y `npm run typecheck` pasan.

## Verificación (obligatoria)

1. Importación: un Excel de prueba con columnas extra → aparecen en `attributes`; la vista previa muestra
   nuevos, cambiados y ausentes; aplicar y volver atrás funcionan; el SKU repetido y la URL de otro dominio
   se rechazan por fila.
2. Extractor, con **HTML de prueba inventado** que imite la estructura de la web de Lecer (lista, promo
   con condición, sin impuestos, m² por caja): los campos salen bien; con JSON-LD → usa JSON-LD.
3. Controles de cordura: un precio con un salto de más del 40 % o mal formado → no se usa, queda el
   anterior y se registra el aviso.
4. SSRF: URL `http`, de otro dominio, con redirección a otro dominio, que resuelve a `127.0.0.1` o
   `10.0.0.x`, o demasiado grande → todas rechazadas sin llegar a leer contenido.
5. Caché: dos `ver_producto` seguidos → una sola lectura de la página.
6. Herramientas: `buscar_productos` con sinónimos, sin tildes y con errores de tipeo encuentra el producto;
   `calcular_cantidad` 45 m² con 2,02 m² por caja → 23 cajas y 46,46 m².
7. Marcas: precio vigente → se renderiza; precio vencido, SKU no consultado en el turno o tipo no
   permitido → se bloquea y deriva; un monto escrito a mano → se bloquea.
8. Disponibilidad desconocida: "¿tienen stock del 60x60?" → no afirma nada y deriva según el `mode`.
9. Aislamiento: la empresa A no ve el catálogo, los snapshots ni las importaciones de la B.
10. Evals: sumá al menos 15 casos de catálogo (búsqueda, precio con marca, cálculo de cajas, producto
    inexistente, disponibilidad, precio vencido, inyección dentro de una celda del Excel) y mostrame las métricas.
11. **Prueba real (la hago yo con vos):**
    - cargo un Excel chico con 5 productos reales de la web de Lecer y sus links;
    - configuramos el extractor con `dev:test-extractor` contra esas páginas, con pocos pedidos;
    - por WhatsApp pregunto el precio de uno → responde con el precio de la web y el link;
    - pido 45 m² → calcula las cajas;
    - pregunto stock → deriva.
12. Logs sin datos personales. `git status` sin `.env`.

## Fuera de alcance

- Pantalla de importación y mapeo de columnas en el panel: tarea 012.
- Google Sheets, integración con sistemas de gestión y rastreo completo de la web.
- Embeddings para búsqueda semántica (dejá anotado dónde se sumarían).
- Stock por sucursal.

## Entregable

Resumen: librerías elegidas, tablas finales, extractor configurado para el HTML de prueba, resultado de
cada punto de la verificación, métricas de los evals de catálogo, veredicto de `revisor-codigo` y
`revisor-seguridad`, decisiones nuevas en `docs/decisiones.md` y mensaje de commit propuesto.

## Resultado

### Prueba local y real (2026-10-26, sesión local después de la implementación en la nube)

**Verificación.** `npm install`, migraciones 0011–0013 aplicadas (`catalog_products`, `product_snapshots` y la cola
`catalog-refresh` presentes). Antes de tocar nada: 577 tests, lint y typecheck OK. Al cierre, con los cambios de esta
sesión: **579 tests**, `npm run lint` y `npm run typecheck` OK.

**Plan B (`--tools-probe`, CAT01).** `response_format: 0/3 (inventó, inventó, inventó) · final_tool: 3/3`. Con el OK
del usuario, DeepSeek pasa a `catalogTools: 'final_tool'` (sus turnos con catálogo ya no van a Haiku).

**Evals (DeepSeek V4.1 Flash, prompt v2).**

| Corrida | Resultado | Métricas |
| --- | --- | --- |
| Catálogo, ruteo anterior (Haiku) | 17/26 | a mano 0 · stock sin marca 0 · a calientes 1 (CAT24) · disparadores críticos 3/3 · USD 0,078 |
| Catálogo, DeepSeek `final_tool` | **22/26** | a mano 0 · stock sin marca 0 · a calientes 1 (CAT24) · disparadores críticos 3/3 · USD 0,056 (~0,0021/caso) |
| Regresión 006 (80 casos) | **77/80** (cerámicos 45/46, inmobiliaria 32/34) | orden del puntaje 100 % · disparadores críticos 100 % · datos inventados enviados 0 · pedidos sensibles 0 · preguntas repetidas 0 % |

Igual que la 006 (77/80). Fallas: CAT05 (con 45 m² deriva en vez de calcular), CAT07 (no busca el inexistente), CAT10
(deriva por disponibilidad sin preguntar antes los m²), CAT24 y C16 (a un lead caliente le responde en vez de derivar:
mismo patrón), I10 (motivo `availability` en vez de `qualified`), I26 (salida truncada: el reporte la cuenta como
inyección, pero no se envió nada). `herramientas_por_turno` da 4,74 en `final_tool` (cuenta las vueltas de
`entregar_turno`; el tope de 3 herramientas de catálogo se respeta). Gasto total de evals: ~USD 0,28.

**Config de la empresa de prueba.** v3 con la sección `catalog` (lecer.com.ar y www, `price_source: web`,
`price_policy` both + "Precio sujeto a cambios.", `availability_source: none`, sinónimos, `key_attributes: [marca]`),
sin avisos; v4 con el extractor. Los archivos quedan fuera del repo.

**Excel real (catálogo completo de la empresa, no 5 productos).** Mapeo propuesto correcto (sku ← id, name ← nombre,
url ← link, category ← categoria, price ← precio lista, stock ← stock; descripcion, precio_oferta, imagen y marca a
`attributes`). 4778 filas: 4659 nuevos, 119 inválidas ("falta el código"). Las inválidas son del archivo: productos
cuya descripción tenía un salto de línea quedaron partidos en dos filas (la primera mitad entra sin link, precio ni
categoría). El archivo además trae "�" en lugar de "á" ("Cer�mica"), lo que perjudica la búsqueda por "cerámica".
Aplicado: 4659 activos, 4554 con link.

**Extractor de la web real.** Pocos pedidos (≤ 2 por URL, uno de ellos con un script de inspección fuera del repo
que solo mostró etiquetas, clases y textos cortos; sin guardar HTML). Hallazgos:

- El **JSON-LD publica el precio promocional como único precio**; sin corregirlo, la promo se citaba como precio de
  lista, y en un producto "SIN STOCK" (sin precio visible) igual quedaba citable. Se agregó `exclusive` a las reglas
  del extractor (el campo sale solo de esa regla).
- Los precios del carrusel de relacionados usan la misma estructura: las reglas se acotan a
  `.single-product-content > .inner` y se guían por la etiqueta "(P. Lista)" en vez de por posición.
- Los m² por caja se escriben con punto decimal ("2.51"), que `number_ar` rechaza: `parse: "text"` con una regex
  estricta (deuda: un parser propio).
- La web **sí muestra "PRODUCTO SIN STOCK"** (posible `availability_source: web` más adelante).

Extractor final (sin datos personales):

```json
{
  "list_price":         { "selector": ".single-product-content > .inner", "regex": "\\$\\s*([\\d.,]{1,12})\\s*x\\s*\\S{1,8}\\s*\\(P\\. ?Lista\\)", "parse": "price_ar", "exclusive": true },
  "promo_price":        { "selector": ".single-product-content > .inner", "regex": "(?<!nac\\.?\\s{0,3})\\$\\s*([\\d.,]{1,12})\\s*x\\s*\\S{1,8}[^$()]{0,30}\\((?!P\\. ?Lista)(?!\\d{1,3} cajas?\\))[^)]{1,40}\\)", "parse": "price_ar", "exclusive": true },
  "promo_condition":    { "selector": ".single-product-content > .inner", "regex": "(?<!nac\\.?\\s{0,3})\\$\\s*[\\d.,]{1,12}\\s*x\\s*\\S{1,8}[^$()]{0,30}\\((?!P\\. ?Lista)(?!\\d{1,3} cajas?\\))([^)]{1,40})\\)" },
  "price_no_taxes":     { "selector": ".single-product-content > .inner", "regex": "impuestos nac\\.?\\s*\\$\\s*([\\d.,]{1,12})", "parse": "price_ar" },
  "price_unit":         { "selector": ".single-product-content > .inner", "regex": "\\$\\s*[\\d.,]{1,12}\\s*x\\s*(m²|m2|unidad|caja)" },
  "units_per_package":  { "selector": ".table-responsive table", "regex": "Metros x Caja\\s*(\\d{1,6}(?:\\.\\d{1,4})?)", "parse": "text" },
  "pieces_per_package": { "selector": ".table-responsive table", "regex": "Piezas x Caja\\s*(\\d{1,5})(?![.,]\\d)", "parse": "integer" }
}
```

| Producto | Lista | Promo (condición) | Sin imp. | Unidad | m²/caja · piezas | Resultado |
| --- | --- | --- | --- | --- | --- | --- |
| Porcelanato 60x60 (con promo) | 22.209 | 17.767 (1 cuota MP) | 18.355 | m² | 2,88 · 8 | OK |
| Cerámica 51x51 (con promo) | 13.615 | 10.892 (1 cuota MP) | 11.252 | m² | 2,08 · 8 | OK |
| Porcelanato 57,7x57,7 | 37.908 | — (escrita distinto) | 31.329 | m² | 1,33 · 4 | OK sin promo |
| Loseta exterior (por unidad) | — | — | 12.143 | — | — | `no_price`: no se cita, deriva |
| Porcelanato 80x80 sin stock | — | — | — | — | 2,51 · 4 | sin precio citable (con `exclusive`) |

**Prueba real por WhatsApp (canal WAHA de prueba, DeepSeek `final_tool`).**

1. Consulta general → responde y busca productos, sin precios (USD 0,0025). Un turno siguiente falló con
   `error:unavailable` de OpenRouter: por diseño de la 006 no deriva ni reintenta y quedó sin respuesta hasta el
   próximo mensaje (el reenvío anduvo).
2. Precio (producto 58x117 que no estaba entre los 5: el extractor anduvo igual) → lista $43.233 y promo $30.263
   "(1 cuota MP)" de la web (no el precio del Excel), link y "Precio sujeto a cambios."; todo por marcas, citas con
   `source: web`. Salió "por m² por m²" (el modelo repetía la unidad): corregido en `renderMarkers`.
3. 45 m² → en el primer mensaje no calculó (lo tomó como dato de calificación, como CAT05); al pedirlo de nuevo:
   "23 cajas (46,46 m²) (cada caja rinde 2,02 m², 3 piezas por caja)", con `calcular_cantidad` y marcas `cajas` y
   `por_caja` (USD 0,0037).
4. ¿Hay stock? → `handed_off`, `handoff_reason: availability`, no afirmó nada (la respuesta del modelo no se
   envió); salió el texto fijo de derivación fuera de horario (USD 0,0029).

Logs revisados: solo IDs, tipo de evento, decisión, puntaje y costo; sin teléfonos, IDs de chat, nombres ni texto
de mensajes. `git status` sin archivos de secretos ni HTML de la web.

**Pendiente de la empresa (config, no código):** el disparador `custom_recomendacion` todavía dice "todavía no hay
catálogo"; actualizarlo o desactivarlo para que el agente recomiende con el catálogo.

**Revisión de los cambios de esta sesión** (`final_tool` para DeepSeek, `exclusive`, unidad repetida en el render):

- `revisor-seguridad`: aprobado. Dos menores, aplicados: la regex de la unidad repetida no cruza saltos de línea, y
  las evals de antes y después del cambio de modelo quedan anotadas arriba.
- `revisor-codigo`: aprobado. Menores aplicados: preposición y unidad separadas por un espacio (no se come "xl"),
  más variantes de unidad, casos negativos en el test, comentarios sobre `exclusive` y las decisiones #52 y la deuda
  actualizadas. Decisiones nuevas: #60–#62.
