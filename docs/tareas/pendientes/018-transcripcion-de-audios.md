# Tarea 018: transcripción de audios

## Contexto

Decisión #63 de `docs/decisiones.md`. Los clientes mandan muchos audios. Hoy un entrante sin texto aplica
`unsupported_media`: pide que escriba, o deriva. Las fotos y los videos siguen igual: no se interpretan.

## Objetivo

Un audio del cliente se transcribe y entra a la conversación como texto, con el mismo pipeline que un
mensaje escrito.

## Antes de empezar

1. Leé `CLAUDE.md`, los skills `webhook-whatsapp` y `migracion-db`, y `.claude/rules/whatsapp.md`.
2. Leé la interfaz `WhatsAppProvider` (`whatsapp/provider.ts`), el proveedor WAHA, el worker de entrada y
   `ai-reply.service.ts` (entrante sin texto).
3. **Consultá la documentación actual** de:
   - cómo WAHA entrega y deja descargar un audio (voz y archivo);
   - las opciones de transcripción en español rioplatense: modelos de audio en OpenRouter, Whisper u otros.

   Compará precio por minuto, calidad, retención de datos y si se puede pedir que no guarden el audio.
   **Registrá la elección en `docs/decisiones.md`.**

## Pasos / requisitos

1. **Proveedor:** descarga del audio detrás de `WhatsAppProvider`, con una capability `downloadMedia`, sin
   `if (provider === 'waha')` fuera de `providers/`. Topes: duración (por ejemplo 3 min) y tamaño.
2. **Cola `audio-transcribe`:**
   - el entrante de audio encola la transcripción; el `ai-reply` de ese mensaje espera la transcripción o
     se encola al terminar;
   - el texto se guarda en el mensaje (columna nueva `transcript` o en `body`, con `type` `audio`);
   - el audio **no** se guarda salvo que haga falta; si se guarda, va a R2 con su retención.
3. **Interfaz `Transcriber`** con una implementación elegida en el paso 3 de "Antes de empezar". La clave va
   en `.env` y en `.env.example`.
   - El costo se registra y pasa por el `AiBudgetGuard`.
   - Un audio que no se puede transcribir (muy largo, error, vacío) aplica `unsupported_media` como hoy.
4. **En el prompt:** el historial marca `tipo: audio` y el texto transcripto. La capa fija aclara que puede
   tener errores de transcripción y que, ante una duda importante, conviene confirmar.
5. Datos personales: ni el audio ni la transcripción van a los logs.

## Criterios de aceptación

- [ ] Un audio de prueba entra como texto y la IA responde a su contenido (test e2e con proveedor y
      transcriptor falsos).
- [ ] Un audio de más del tope o con error aplica `unsupported_media` (test).
- [ ] Las fotos y los videos siguen aplicando `unsupported_media` (test).
- [ ] El costo de la transcripción queda registrado y cuenta para el presupuesto.
- [ ] Prueba real: un audio por WhatsApp recibe una respuesta coherente.

## Verificación (obligatoria)

1. `npm run lint && npm run typecheck` → sin errores.
2. `npm run db:migrate` (si hay migración) y `npm run test` → verde.
3. Prueba real por WhatsApp con un audio corto y uno largo.

## Fuera de alcance

- Fotos, videos y documentos.
- Responder con audio.

## Entregable

Resumen con:

- los archivos tocados;
- el proveedor elegido, con su costo y su retención;
- el resultado de la verificación;
- el veredicto de `revisor-codigo` y de `revisor-seguridad`.
