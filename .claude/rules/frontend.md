---
paths: ['apps/web/**']
---

- Angular con componentes standalone y signals. SPA (sin SSR) detrás del login. Zoneless y `OnPush` en todos los componentes.
- **El front solo oculta lo que no corresponde; quien decide es el backend.** Guards, menú y botones usan los permisos de `libs/shared` para no mostrar lo que el rol no puede hacer, pero cada endpoint valida por su cuenta. Nunca confiar en que algo "no se ve" como control de acceso.
- Hasta que la API exponga OpenAPI (tarea 014), los tipos de las respuestas van en `libs/shared` (`@ventas/shared/auth` y similares) y los servicios HTTP se escriben a mano, chicos y tipados. En la 014 se suma el generador de cliente.
- En el navegador se importa de los subpaths livianos de `libs/shared` (por ejemplo `@ventas/shared/auth`), no del índice: el índice arrastra zod y las configuraciones de la IA.
- Nunca guardar tokens ni datos de la sesión en `localStorage`/`sessionStorage`: la sesión es solo la cookie `HttpOnly`. En `localStorage` solo van preferencias visuales (el tema).
- Prohibido `innerHTML`/`outerHTML` y `bypassSecurityTrust*`: los mensajes de WhatsApp y todo lo que viene del servidor es contenido no confiable y se muestra como texto. Lo controla ESLint (`tools/eslint/security-plugin.mjs`).
- Sin datos personales en la consola ni en los mensajes de error que se muestran.
- Colores, radios, sombras y espaciado solo desde los tokens (`apps/web/src/styles/tokens.css`), nunca un hex suelto. El nombre del producto sale de `apps/web/src/app/brand.ts`.
- El nivel de un lead (hot/warm/cold) siempre con ícono y texto además del color.
- Las reglas del proyecto (seguridad, sin `innerHTML` ni `bypassSecurityTrust*`, permisos desde `libs/shared`) están por encima de la skill `angular-developer`: si se contradicen, mandan las del proyecto.
