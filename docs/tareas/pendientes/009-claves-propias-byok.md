# Tarea 009: claves propias de la empresa (Anthropic, OpenAI) y elección de modelo

## Contexto

La 006 dejó el `LlmClient` con una interfaz pensada para varios proveedores, pero solo con OpenRouter
implementado. La 008 agregó los créditos del modo `platform` y el reporte de consumo.

Esta tarea agrega el modo **`byok`** ("bring your own key"): la empresa carga su propia clave de Anthropic
(Claude) u OpenAI (ChatGPT), elige el modelo, paga directamente a su proveedor y en nuestro sistema ve
cuánto lleva gastado.

Lo más delicado de esta tarea es guardar claves de terceros: si se filtran, la empresa pierde plata y
nosotros, confianza.

## Objetivo

- Claves de cada empresa guardadas **cifradas**, que nunca se muestran ni se loguean.
- Clientes de Anthropic y OpenAI detrás de la misma interfaz `LlmClient`.
- Elección de modelo por empresa, limitada a los modelos que pasaron nuestros evals.
- Costo estimado por corrida y presupuesto mensual opcional en USD.

## Antes de empezar

1. Leé `CLAUDE.md`, el skill `ejecutar-tarea`, `.claude/rules/ia.md`, y el `LlmClient`, el `LlmClientFactory`
   y el `AiBudgetGuard` de la 006 y la 008.
2. **Consultá la documentación actual** de:
   - la API de Anthropic: Messages API, salida estructurada o uso de herramientas para devolver JSON con
     schema, datos de uso y endpoint para listar modelos;
   - la API de OpenAI: la API recomendada hoy, salida estructurada con JSON schema, datos de uso y endpoint
     para listar modelos;
   - los precios por millón de tokens de entrada y de salida de los modelos que propongas.
     No inventes parámetros ni precios: anotá en el código la fuente y la fecha de cada precio.

## Pasos / requisitos

### 1. Variables de entorno

- `AI_KEYS_ENCRYPTION_KEY`: 32 bytes en base64, validada al arrancar.
- `AI_KEYS_ENCRYPTION_KEY_VERSION`: versión de la clave maestra, para poder rotarla.

Dame el comando para generarla y las líneas para mi `.env`; las cargo yo. Esperá mi confirmación. Anotá en
`docs/decisiones.md` que en producción esta clave **no** puede estar en el mismo backup que la base.

### 2. Credenciales cifradas (`tenant_ai_credentials`)

- `tenant_id`, `provider` (`anthropic` | `openai`), `ciphertext bytea`, `iv bytea`, `auth_tag bytea`,
  `key_version int`, `last4 text`, `status` (`active` | `invalid` | `revoked`), `validated_at`,
  `created_by`, timestamps. UNIQUE `(tenant_id, provider) WHERE status = 'active'`.
- Cifrado **AES-256-GCM** en la aplicación, con IV aleatorio por clave y **datos adicionales autenticados
  = `tenant_id` + `provider`**. Así un texto cifrado copiado a otra empresa no se puede descifrar.
- Módulo de cifrado chico y aislado, con tests propios: ida y vuelta, IV distinto cada vez, falla con otro
  `tenant_id`, falla con un byte alterado, y descifra con la versión de clave que corresponde.
- La clave en claro existe solo en memoria, dentro de la llamada al proveedor. **Nunca** se devuelve por
  ningún endpoint, **nunca** se loguea, y los errores del proveedor se sanitizan antes de loguearlos.
- Solo `owner` y `admin` de la empresa pueden cargar, reemplazar o revocar una clave (validado en el servicio).
- RLS forzada y grants mínimos: sin `DELETE`, y revocar es cambiar el `status`.

### 3. Alta de una clave

`AiCredentialsService.setKey(tenantId, provider, plainKey)`:

1. Valida el formato básico.
2. Hace una llamada barata al proveedor (por ejemplo, listar modelos) para comprobar que funciona.
3. Si funciona: cifra, guarda, marca `active` y revoca la anterior de ese proveedor.
4. Si no: error claro, sin guardar nada.

Script `npm run dev:set-ai-key -- --tenant <id> --provider anthropic` que **pide la clave por la terminal
sin mostrarla** (nunca como argumento, para que no quede en el historial). Solo fuera de `production`.

### 4. Clientes de Anthropic y OpenAI

- `AnthropicClient` y `OpenAiClient` implementan `LlmClient`, con la misma salida estructurada validada
  con zod que OpenRouter. Lo específico de cada uno queda en su carpeta.
- `costSource = 'estimated'`: tokens × precio de la tabla `MODEL_PRICES` del código, que tiene proveedor,
  modelo, precio de entrada y de salida por millón, y fuente y fecha.
- Mismo manejo de timeout y reintentos que la 006.

### 5. Elección de modelo

- `ALLOWED_MODELS` (de la 006) suma los modelos de Anthropic y OpenAI. **Solo se pueden elegir modelos que
  hayan pasado los evals**: corré los evals con cada modelo propuesto y agregá a la lista solo los que
  alcancen las metas.
- `tenant_configs.config.ai` pasa a tener `provider` y `model`. La validación exige que el par esté en
  `ALLOWED_MODELS` y que la empresa tenga una clave `active` de ese proveedor, salvo que el proveedor sea
  OpenRouter de la plataforma.
- El `LlmClientFactory` elige:
  - `billing_mode = 'platform'` → OpenRouter con nuestra clave y créditos (008);
  - `billing_mode = 'byok'` → el cliente del proveedor de la config con la clave descifrada.

### 6. Fallas de una clave propia

- 401 o 403 → la credencial pasa a `invalid`, la conversación se deriva, se registra un aviso
  (`ai_billing_alerts`) y no se reintenta.
- Cuota o saldo agotados en su proveedor → igual: deriva y aviso.
- **No se pasa automáticamente a nuestra clave de OpenRouter**: sería gastar nuestra plata sin acuerdo. Si
  después lo queremos, que sea una opción explícita de la configuración de facturación, apagada por defecto.

### 7. Presupuesto mensual opcional (modo `byok`)

- `tenant_ai_billing.byok_monthly_budget_usd` (nulo = sin límite).
- El `AiBudgetGuard` en modo `byok` usa el costo estimado de `ai_runs` del mes, con la misma lógica de
  reserva y lock de la 008, y los mismos avisos del 80 % y el 100 %.
- El reporte `ai:usage` aclara que en `byok` el costo es **estimado** y que el gasto real figura en la
  cuenta de la empresa en su proveedor.

## Criterios de aceptación

- [ ] Una clave nunca aparece en claro en la base, en los logs, en respuestas de la API ni en el historial
      de la terminal.
- [ ] Un texto cifrado de la empresa A no se puede usar en la B.
- [ ] Una empresa solo puede usar modelos de `ALLOWED_MODELS` y de un proveedor con clave activa.
- [ ] Una clave inválida deriva la conversación, avisa y no gasta nuestra plata.
- [ ] `npm run test`, `npm run lint` y `npm run typecheck` pasan.

## Verificación (obligatoria)

1. Tests del módulo de cifrado (los cinco casos del punto 2).
2. En la base, `ciphertext` no contiene la clave en claro (buscala como texto y como bytes) y `last4` coincide.
3. Alta con una clave falsa → no se guarda nada; alta válida (con proveedor falso) → `active` y la anterior `revoked`.
4. Un usuario `seller` intenta cargar una clave → rechazado.
5. Config con un modelo fuera de `ALLOWED_MODELS`, o con un proveedor sin clave activa → la validación falla.
6. `LlmClientFactory`: modo `platform` → OpenRouter; modo `byok` → el cliente del proveedor con la clave de esa empresa.
7. 401 del proveedor → credencial `invalid`, conversación derivada, aviso y sin llamada a OpenRouter.
8. Presupuesto `byok` agotado → no se llama al modelo; avisos del 80 % y del 100 %.
9. Costo estimado = tokens × precio de la tabla, y `cost_source = 'estimated'`.
10. Logs y errores capturados durante todos los tests: ninguno contiene la clave (buscá el valor de prueba).
11. Aislamiento: la empresa A no ve ni usa las credenciales de la B.
12. Evals con los modelos propuestos de Anthropic y OpenAI, y comparación con los de OpenRouter.
13. **Prueba real (la hago yo con vos):** cargo una clave mía de Anthropic u OpenAI con el script, paso la
    empresa de cerámicos a `byok`, pregunto un horario por WhatsApp → responde, y `ai:usage` muestra el
    costo estimado.
14. `git status`: sin `.env`.

## Fuera de alcance

- Pantalla para cargar la clave y elegir el modelo (va con el panel de configuración, tarea 012).
- Otros proveedores (Google, modelos propios).
- Rotación automática de la clave maestra (dejá el procedimiento manual documentado).

## Entregable

Resumen: archivos creados, modelos que pasaron los evals con su costo por caso, tabla de precios con
fuentes, resultado de cada punto de la verificación, veredicto de `revisor-codigo` y `revisor-seguridad`,
decisiones nuevas en `docs/decisiones.md` y mensaje de commit propuesto.
