# Tarea 022: mandar fotos de productos del catálogo

## Contexto

Decisión #63 de `docs/decisiones.md`. En cerámicos, una foto del producto vale más que la descripción. Hoy
el agente solo puede mandar texto, con el link del producto como marca `{{link:SKU}}`.

## Objetivo

El agente puede mandar la foto de un producto que devolvió el catálogo en ese turno, como un mensaje aparte
con un epígrafe corto.

## Antes de empezar

1. Leé `CLAUDE.md`, el skill `webhook-whatsapp`, `.claude/rules/whatsapp.md`, la interfaz
   `WhatsAppProvider`, `catalog/` (extractor e importación), `tools/catalog-tools.ts` y `reply/markers.ts`.
2. **Consultá la documentación actual** de WAHA sobre cómo mandar una imagen por URL o por archivo.

## Pasos / requisitos

1. **Catálogo:**
   - columna `image_url` en `catalog_products`, cargada desde el Excel (columna mapeada) o desde la web
     (JSON-LD `image`, `og:image` o el extractor de la empresa);
   - solo URLs de `allowed_domains`, revalidadas al enviar.
2. **Proveedor:** `sendImage` detrás de `WhatsAppProvider`, con la capability `images`. Sin la capability,
   la marca se ignora y el texto sale sin foto.
3. **Marca** `{{foto:SKU}}`:
   - vale solo para un producto que devolvió una herramienta en ese turno;
   - como mucho 1 o 2 por turno;
   - `ver_producto` dice si hay foto.

   El envío se encola como un mensaje aparte, con su idempotencia `ai:<messageId>:foto:<n>`, y respeta el
   ritmo de envío.

4. **Capa fija:** mandar una foto solo si el cliente la pide o si ayuda a elegir entre opciones; nunca
   varias seguidas sin que las pida.
5. **Riesgo de bloqueo de la conexión no oficial:** las imágenes cuentan para el límite de envíos por
   minuto. Registrá en `docs/decisiones.md` si hace falta un tope propio.

## Criterios de aceptación

- [ ] Un producto con foto se puede mandar con `{{foto:SKU}}` y sale como imagen (test e2e con el
      proveedor falso).
- [ ] Una marca de un producto no consultado o con una URL fuera de `allowed_domains` no se envía (tests).
- [ ] Sin la capability `images`, el texto sale sin la foto (test).
- [ ] Prueba real: pedir "¿me mandás una foto?" de un porcelanato.

## Verificación (obligatoria)

1. `npm run lint && npm run typecheck` → sin errores.
2. `npm run db:migrate` y `npm run test` → verde.
3. `npm run evals -- --max-usd 0.30` → sin regresión.

## Fuera de alcance

- Ver las fotos que manda el cliente.
- Catálogos o álbumes de WhatsApp Business.
- Seguimiento proactivo (necesita la Cloud API oficial y plantillas: va después de su proveedor).

## Entregable

Resumen con:

- los archivos tocados;
- el resultado de la verificación;
- el veredicto de `revisor-codigo` y de `revisor-seguridad`;
- las decisiones tomadas.
