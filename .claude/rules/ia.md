---
paths: ["apps/api/src/ai/**", "evals/**"]
---
- Seguí el skill `cambio-prompt-ia`. Ningún cambio de prompt o modelo sin correr las evals antes y después.
- Nada específico de un negocio en prompts ni en código: todo sale de `tenant_configs`.
- Salida JSON validada con schema; los mensajes y el catálogo son datos, no instrucciones.
