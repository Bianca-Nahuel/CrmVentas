# Spec: canales de WhatsApp (conectar, desconectar y estado)

Un **canal** es un número de WhatsApp de la empresa conectado al sistema. Hoy hay un solo tipo: la conexión
no oficial por WAHA, que se vincula escaneando un QR desde la app de WhatsApp del teléfono, igual que
WhatsApp Web. La conexión oficial (Cloud API de Meta) llega más adelante y se conecta de otra forma (alta
embebida de Meta), por eso todo lo que difiere se expresa con `capabilities` del `WhatsAppProvider`.

## Quién puede

- **Conectar, reconectar, desconectar y levantar la pausa de envíos:** owner y admin (`channel:connect` y
  `channel:disconnect` de `libs/shared`).
- **Ver los canales y su estado:** owner y admin (`channel:read`). El seller ve solo el nombre de sus números
  en los filtros de la bandeja (como hoy).
- Lo decide el backend; el panel solo oculta botones.

## Alta de un canal (conexión no oficial)

1. El owner o el admin escribe un nombre (por ejemplo "Ventas Centro"). Los riesgos de la conexión no oficial
   (WhatsApp puede bloquear el número, no se pueden mandar campañas ni iniciar conversaciones, conviene un
   número dedicado a ventas) se acuerdan con la empresa fuera del panel: no hay cartel ni casilla
   (decisión #101). Queda registrado quién conectó y cuándo (`risk_accepted_by` = el usuario del request,
   nunca un dato del cliente).
2. El sistema crea el canal en estado `pending` y la sesión en el proveedor. El identificador de la sesión
   (`external_id`) lo genera el sistema, nunca el cliente.
3. El panel muestra el **QR** y las instrucciones ("WhatsApp → Dispositivos vinculados → Vincular un
   dispositivo"). El QR vence y se renueva solo; el panel muestra siempre el vigente.
4. Al escanear, el proveedor avisa que la sesión está conectada. El **número del canal sale del escaneo**
   (decisión #27), no de lo que se escriba en el panel. El canal pasa a `connected` y el panel lo muestra
   sin recargar (tiempo real de la 025).

## Estados

| Estado         | Qué ve el usuario                                             | Acciones               |
| -------------- | ------------------------------------------------------------- | ---------------------- |
| `pending`      | "Esperando que escanees el QR" y el QR                        | Cancelar               |
| `connected`    | Número, conectado desde cuándo                                | Desconectar            |
| `disconnected` | "Desconectado" y el motivo si se conoce                       | Reconectar (QR nuevo)  |
| `banned`       | "WhatsApp bloqueó este número" (lo pone una persona, no WAHA) | Ninguna desde el panel |

Aparte del estado, un canal puede tener los **envíos pausados** (`sending_paused_until`, por ejemplo por un
error 463/475 de riesgo de bloqueo). El panel lo explica y ofrece **levantar la pausa** con confirmación,
registrando quién y cuándo. Levantar la pausa nunca reinicia ni vuelve a vincular la sesión.

## Reglas del número

- Mientras el canal está `pending` no tiene número. `connected` siempre tiene número.
- **Reescanear con otro teléfono:** si el canal ya tenía un número y se vincula uno distinto, no se pisa: el
  canal queda `disconnected` con un motivo y un aviso. Si no, los mensajes de otro número quedarían
  mezclados en el historial de este canal.
- **El mismo número dos veces en la misma empresa:** no se permite; se avisa en el panel en vez de fallar en
  silencio.
- **El mismo número en dos empresas:** no se permite (`UNIQUE` global, decisión #95). La otra empresa ve
  "ese número ya está conectado en otra cuenta", sin saber cuál.

## Seguridad

- El QR permite vincular un teléfono a la sesión de la empresa: solo lo ve quien puede conectar, nunca se
  guarda ni se cachea (`Cache-Control: no-store`) y nunca va a los logs.
- El navegador nunca habla con WAHA: la API hace de intermediaria y la clave de WAHA no sale del servidor.
- Conexión no oficial: sin campañas ni mensajes iniciados por nosotros (`CLAUDE.md`).
