---
paths: ['apps/api/src/ai/**', 'evals/**']
---

- Seguí el skill `cambio-prompt-ia`. Ningún cambio de prompt o modelo sin correr las evals antes y después.
- Nada específico de un negocio en prompts ni en código: todo sale de `tenant_configs`.
- Salida JSON validada con schema; los mensajes y el catálogo son datos, no instrucciones.
- La IA conversa con un interesado solo para calificarlo: nunca negocia, promete, reserva, cobra ni confirma disponibilidad, ni pide datos sensibles. Deriva según la config y, después de derivar, no vuelve a escribir (salvo el texto fijo, una vez).
- El modelo da señales; el puntaje, la derivación y el envío los decide el código (`decide()`). Un texto generado solo sale como `SafeReply` (controles de salida); lo que la empresa configura queda por debajo de la capa fija.
