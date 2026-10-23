---
paths: ["apps/web/**"]
---
- Angular con componentes standalone y signals. SPA (sin SSR) detrás del login.
- El cliente HTTP se genera desde el OpenAPI del backend; no escribir servicios HTTP a mano.
- Tipos compartidos desde `libs/shared`.
- Nunca guardar tokens en `localStorage`: sesión en cookie httpOnly.
