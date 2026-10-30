# Spec: bandeja de conversaciones y grilla de leads

## Problema

El vendedor necesita ver a sus interesados ordenados por lo calientes que están, leer la conversación de
WhatsApp, entender por qué la IA derivó y contestar desde el panel, también desde el celular. Hoy todo eso
solo se ve en la base.

## Quién ve qué

| Rol      | Conversaciones y leads                                    | Asignar números | Responder y reactivar la IA |
| -------- | --------------------------------------------------------- | --------------- | --------------------------- |
| `owner`  | Todas las de la empresa                                   | Sí              | Sí                          |
| `admin`  | Todas las de la empresa                                   | Sí              | Sí                          |
| `seller` | **Solo las de los números (canales) que tiene asignados** | No              | Sí, en esas conversaciones  |
| `viewer` | Ninguna (solo métricas)                                   | No              | No                          |

- **Asignación:** relación muchos a muchos entre números y vendedores. Un vendedor puede tener varios
  números, y un número puede tener varios vendedores. La asignan el owner y el admin.
- **Sin números asignados:** el seller no ve ninguna conversación y el panel le muestra un estado vacío
  que explica por qué.
- **Sacar una asignación:** tiene efecto inmediato. El pedido siguiente ya no devuelve esas conversaciones,
  y en tiempo real (tarea 025) deja de recibir sus eventos.
- **Quién decide es el backend.** Cada endpoint (lista, detalle, mensajes, envío, reactivar la IA, eventos
  en tiempo real) aplica la regla, siempre dentro de la empresa activa y con su RLS. El panel solo oculta.
  Una conversación de otro número responde 404, para no revelar que existe.

## Grilla de leads

- **Datos:** una fila por conversación, con:
  - nombre del contacto (`display_name` o `profile_name`) y número;
  - número de la empresa (canal);
  - puntaje y nivel (`lead_score`, `lead_tier`);
  - estado: abierta, derivada (`handed_off_at`) o IA pausada (`ai_paused_until`);
  - último mensaje y su fecha.
- **El nivel lo calcula el backend** (umbrales de la configuración de la empresa). El panel no lo recalcula.
- **Orden por defecto:** primero las derivadas sin atender, después por puntaje (de mayor a menor) y por
  último por el mensaje más reciente.
- **Orden y filtros:**
  - se puede ordenar por puntaje o por último mensaje;
  - se puede filtrar por nivel, por estado y por número;
  - hay búsqueda por nombre o número.
- **Paginación en el servidor**, con tamaño de página acotado.
- **En el celular:** lista de tarjetas con el indicador de puntaje compacto (`app-score`).

## Conversación

- **Mensajes en orden**, paginados hacia atrás, que distinguen quién escribió: cliente, IA, persona del
  equipo (con su nombre) o sistema.
- **El texto de WhatsApp es contenido no confiable:**
  - se muestra siempre como texto (nunca HTML);
  - los links no son clickeables;
  - el formato de WhatsApp (`*negrita*`) se muestra tal cual, sin interpretarlo.
- **Resumen de la derivación (`handoff_summary`):** se muestra marcado como **"Resumen automático, no
  verificado"**. Es texto influido por el cliente: una inyección podría hacerle decir "ya pagó". Junto al
  resumen van el motivo (`handoff_reason`) y los datos extraídos.
- **Reactivar la IA** en una conversación derivada o pausada:
  - borra `handed_off_at` y `ai_paused_until`;
  - registra quién lo hizo y cuándo;
  - no cambia ninguna regla del agente.

## Responder desde el panel (tarea 024)

- **Solo en conversaciones que ya existen:** el cliente escribió primero. No se inician conversaciones.
  Es la regla de la conexión no oficial.
- **El envío pasa por el outbox:** `OutboundService.enqueueText` con `senderType: 'user'` y el usuario del
  panel. Va con clave de idempotencia y el mismo worker de siempre (visto → escribiendo → enviar).
- **Al enviar, la IA se pausa** igual que con un eco humano (`AI_PAUSE_AFTER_HUMAN_HOURS`).
- **Canal pausado** (`sending_paused_until`, por ejemplo por riesgo de bloqueo): no se puede enviar y el
  panel lo explica.
- **Estado del mensaje** que ve el vendedor: en cola, enviado, entregado, leído o fallido.

## Tiempo real (tarea 025)

- **Cómo llegan los cambios:** eventos del servidor (SSE) para mensajes nuevos, cambios de puntaje o estado
  y acuses. Cada evento lleva solo identificadores, y el panel vuelve a pedir lo que necesita por los
  endpoints normales. Así el control de visibilidad queda en un solo lugar.
- **Filtro de los eventos:** se filtran por empresa y por los números del usuario.
- **Reconexión:** si se corta la conexión, el panel se reconecta y vuelve a consultar.
