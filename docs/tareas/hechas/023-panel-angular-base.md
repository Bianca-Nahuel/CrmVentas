# Tarea 023: base del panel en Angular (login, empresa activa y estructura)

## Contexto

El backend ya tiene autenticación con Better Auth (sesiones en base, cookie `HttpOnly`), empresas con roles
(`owner`, `admin`, `seller`, `viewer`), RLS por empresa, mensajería, el agente y el catálogo. Todavía no hay
interfaz: todo se maneja por scripts.

Esta tarea crea `apps/web` con la estructura sobre la que se van a montar las pantallas siguientes:

- conexión por QR (tarea 011);
- bandeja y grilla de leads (tarea 014);
- configuración del agente y del catálogo (tarea 012);
- embudo (tarea 013).

En esta tarea no hay pantallas de negocio, solo la base: login, elegir empresa, layout y permisos.

Referencias: `CLAUDE.md`, `.claude/rules/frontend.md`, `docs/specs/autenticacion.md` (sesiones, cookie,
mismo origen, empresa activa) y `libs/shared/src/auth/permissions.ts`.

## Objetivo

- Proyecto Angular en `apps/web` dentro del monorepo, con el mismo estándar de calidad que la API.
- Login y logout con Better Auth, empresa activa y cambio de empresa.
- Layout con navegación según el rol.
- Base de seguridad del frontend.

## Antes de empezar

1. Leé `CLAUDE.md`, `.claude/rules/frontend.md`, `docs/specs/autenticacion.md` y el skill `ejecutar-tarea`.
2. **Consultá la documentación actual** de:
   - Angular: última versión estable, cómo se crea un proyecto hoy (standalone, signals, si zoneless es el
     valor por defecto, test runner por defecto, builder);
   - el cliente de Better Auth para navegador (`createAuthClient` y el plugin de organizaciones del lado
     cliente), con la versión exacta que ya usa la API.
     No inventes opciones: si algo no coincide con la tarea, avisame antes de seguir.
3. **Librería de componentes:** proponé dos opciones (por ejemplo Angular Material, PrimeNG, o Tailwind con
   componentes propios sobre Angular CDK), comparando:
   - tablas con orden, filtros y paginación (las vamos a necesitar para la grilla de leads);
   - formularios grandes (para la configuración del agente);
   - uso en celular (los vendedores van a mirar el panel desde el teléfono);
   - tamaño, licencia y mantenimiento.
     Recomendá una. **No instales nada sin mi OK.**

## Pasos / requisitos

### 1. Proyecto

- `apps/web` como workspace de npm, TypeScript estricto, ESLint y Prettier compartidos con el repo.
- Componentes standalone, signals para el estado y `OnPush` o zoneless según lo que recomiende la
  versión actual.
- Locale `es-AR` para fechas, números y moneda.
- Comandos en `CLAUDE.md`: `npm run dev:web`, y `build`, `test` y `lint` del front.

### 2. Mismo origen

- En desarrollo: proxy de Angular `/api` → `http://localhost:3000`. El navegador solo habla con `localhost:4200`.
- Agregá `http://localhost:4200` a `TRUSTED_ORIGINS` en `.env.example` y decime la línea para mi `.env`.
- Verificá que la cookie de sesión funcione a través del proxy con `SameSite=Lax`, y que Better Auth
  rechace pedidos de un origen no confiable.
- En producción, front y API van en el mismo dominio detrás de Caddy (no se configura en esta tarea, pero
  dejalo documentado en `docs/entorno-dev.md`).

### 3. Autenticación

- `AuthService` sobre el cliente de Better Auth, con la sesión en signals: usuario, empresa activa y rol.
  Al arrancar la app llama a `GET /api/me/context`.
- **Pantallas:**
  - **Login** con email y contraseña: errores genéricos ("email o contraseña incorrectos"), sin revelar si
    el email existe; botón deshabilitado mientras envía.
  - **Elegir empresa:** si el usuario pertenece a varias y no hay una activa.
  - **Sin acceso:** para un 403, por ejemplo una membresía desactivada.
- **No hay registro público.** Las cuentas y empresas se crean por seed o por invitación (tarea posterior),
  como definió la 002.
- **Cambio de empresa** desde el menú del usuario: llama al endpoint de Better Auth, recarga el contexto y
  limpia cualquier estado de la empresa anterior.
- **Logout:** borra la sesión y vuelve al login.

### 4. Rutas y guards

- `authGuard`: sin sesión → login, guardando la ruta a la que iba. Solo rutas internas, nunca una URL externa
  (para evitar _open redirects_).
- `tenantGuard`: sin empresa activa → elegir empresa.
- `permissionGuard`: usa los permisos de `libs/shared` (el mismo `createAccessControl` de la API).
- Interceptor HTTP: 401 → login; 403 → pantalla sin acceso; error de red → aviso no intrusivo.
- **El front solo oculta lo que no corresponde; quien decide es el backend.** Que quede escrito en
  `.claude/rules/frontend.md`.

### 5. Layout

- Barra lateral, que en el celular se colapsa en un menú, con estas secciones (por ahora, páginas
  "próximamente"):
  - **Conversaciones** y **Leads**: todos los roles;
  - **Canales**: `owner` y `admin`;
  - **Catálogo** y **Configuración del agente**: `owner` y `admin`;
  - **Consumo**: `owner`;
  - **Métricas**: todos los roles, incluido `viewer`.
- Encabezado con el nombre de la empresa activa, el selector de empresa (si tiene más de una) y el menú
  del usuario.
- Accesible: foco visible, navegación con teclado y contraste suficiente.

### 6. Seguridad del frontend

- Nada de tokens en `localStorage` ni `sessionStorage`: la sesión es solo la cookie `HttpOnly`.
- **Prohibido** `bypassSecurityTrust*` e `innerHTML` con datos del servidor. Los mensajes de WhatsApp se
  van a mostrar en la 014 y son contenido no confiable. Agregá una regla de ESLint que lo impida.
- Política de seguridad de contenido (CSP) propuesta para producción, documentada en `docs/entorno-dev.md`
  para aplicarla cuando configuremos Caddy.
- Sin datos personales en la consola ni en los errores que se muestran.

### 7. Backend (solo lo que haga falta)

Si el front necesita algo que no existe (por ejemplo, la lista de empresas del usuario con su rol), agregalo
en la API con los mismos guards y tests, o usá el endpoint de Better Auth si ya lo resuelve. Justificalo en el plan.

## Criterios de aceptación

- [ ] Login, logout, elegir empresa y cambiar de empresa funcionan contra la API real a través del proxy.
- [ ] Cada rol ve solo sus secciones, y una ruta prohibida escrita a mano termina en "sin acceso".
- [ ] La sesión vive solo en la cookie `HttpOnly`.
- [ ] Se ve bien en un celular (ancho de 375 px) y en escritorio.
- [ ] `npm run test`, `npm run lint`, `npm run typecheck` y el build del front pasan.

## Verificación (obligatoria)

1. Con el seed: login del `owner` de cerámicos → entra al layout con el nombre de la empresa.
2. Usuario de las dos empresas → elige una, cambia a la otra, y el encabezado y `/api/me/context` reflejan el cambio.
3. Contraseña incorrecta → mensaje genérico; email inexistente → el mismo mensaje.
4. Logout → volver atrás con el navegador no muestra contenido protegido, y el siguiente pedido da 401.
5. Membresía desactivada → pantalla sin acceso.
6. Roles: con un `seller`, Canales, Catálogo, Configuración y Consumo no aparecen, y entrar a la URL a mano → sin acceso.
7. `authGuard` con `?redirect=https://otro-sitio.com` → no redirige afuera.
8. En las herramientas del navegador: la cookie es `HttpOnly` y no hay nada de la sesión en el almacenamiento local.
9. Un pedido a la API desde otro origen (por ejemplo con `curl` y un `Origin` falso) → rechazado por Better Auth.
10. Tests unitarios de `AuthService`, guards e interceptor. Tests de punta a punta del flujo de login, si
    proponés una herramienta (por ejemplo Playwright) y la apruebo.
11. Capturas de pantalla en escritorio y en celular: login, elegir empresa y layout.
12. `git status`: sin `.env`.

## Fuera de alcance

- Pantallas de negocio (canales, conversaciones, leads, configuración, catálogo, consumo).
- Registro de cuentas, invitaciones, recuperación de contraseña y login con Google.
- Configurar Caddy y el despliegue.
- Internacionalización: la interfaz va solo en español.

## Entregable

Resumen: versión de Angular, librería elegida y su porqué, estructura de `apps/web`, endpoints agregados
(si hubo), resultado de cada punto de la verificación con las capturas, veredicto de `revisor-codigo` y
`revisor-seguridad`, decisiones nuevas en `docs/decisiones.md` y mensaje de commit propuesto.

## Resultado

Hecha el 2026-10-30, en la rama `claude/panel-angular-base` (sale de `main`; la skill `angular-developer` va
por cherry-pick). Se numeró 023 porque la 010 ya era la del agente conversacional.

### Decisiones tomadas con el usuario

- **Angular 22.2** (zoneless por defecto, standalone, signals, `OnPush`, Vitest, builder esbuild).
- **Angular CDK + Tailwind v4** con componentes propios. Se descartó PrimeNG.
- **Menú y guards desde los permisos de `libs/shared`:**
  - viewer → solo Métricas;
  - seller → Conversaciones y Leads;
  - recurso nuevo `billing: ['read']`, solo para el owner (Consumo).
- **Playwright** para los e2e y las capturas.
- **OpenAPI:** hasta la 014, los tipos van en `libs/shared` (cambio de regla aprobado).
- **Identidad propia:**
  - primario verde petróleo;
  - niveles de lead brasa/ámbar/azul, siempre con ícono y texto;
  - Plus Jakarta Sans servida desde el build;
  - tokens CSS y modo claro/oscuro;
  - "Panel" como marcador en `apps/web/src/app/brand.ts`.
- **Ajustes pedidos al aprobar el plan:**
  - las tareas 003 a 007 están en `main` (verificado);
  - `disableSignUp`, con el seed y los tests creando usuarios con `createUser` del plugin admin;
  - middleware global de origen;
  - rate limit de Better Auth revisado y anotado como deuda.

### Archivos

- **API:**
  - `src/auth/auth.ts` (`disableSignUp`);
  - `src/http/origin-guard.ts` (nuevo) y su registro en `src/bootstrap.ts`;
  - `src/me/me.controller.ts` (`GET /api/me/tenants`);
  - `scripts/seed.ts` (`createUser` y `baja@example.test` con la membresía desactivada);
  - `test/helpers.ts`, `test/auth-flow.test.ts` y `test/panel-api.test.ts` (nuevo).
- **`libs/shared`:**
  - `src/auth/me.ts` (tipos de `/api/me/*`);
  - `src/auth/index.ts` (subpath `@ventas/shared/auth`, sin zod);
  - `billing` en `permissions.ts`.
- **`apps/web` (nuevo):**
  - configuración (`angular.json`, `tsconfig*`, `proxy.conf.json`, `playwright.config.ts`);
  - `src/styles/tokens.css` y `src/styles.css`;
  - `src/app/ui/`: ícono, botón, campo, etiqueta, puntaje, tabla, aviso, tema y marca;
  - `src/app/core/`: auth, guards, `safeRedirect`, interceptor, nav, roles y títulos;
  - `src/app/pages/`: login, elegir empresa, sin acceso, próximamente y layout;
  - `src/app/dev/`: `/dev/diseno`, fuera del build de producción;
  - tests unitarios y `e2e/`.
- **ESLint:**
  - `eslint.config.mjs` (angular-eslint);
  - `tools/eslint/security-plugin.mjs`, que prohíbe `innerHTML`, `bypassSecurityTrust*` y similares;
  - `tools/eslint/check-security-rules.mjs`, el autochequeo que corre en `npm run lint`.
- **Docs:**
  - `.claude/rules/frontend.md`;
  - `CLAUDE.md` (comandos);
  - `docs/entorno-dev.md` (sección 8: proxy, Caddy y CSP);
  - `docs/decisiones.md` (#68 a #75 y deuda del rate limit).

### Verificación

1. **Owner de cerámicos** → layout con "Cerámicos Demo" y las 7 secciones. ✔ (e2e)
2. **`multi@`** elige Cerámicos, cambia a Inmobiliaria, y el encabezado y `/api/me/context` reflejan el
   cambio (como viewer, entra a Métricas). ✔ (e2e) Los e2e encontraron acá un bug que ya está corregido: la
   ruta vacía usaba `redirectTo` con el rol, pero los redirects se evalúan antes que los guards. Ahora es
   `homeGuard`.
3. **Contraseña incorrecta y email inexistente** → el mismo mensaje. ✔ (e2e)
4. **Logout:** volver atrás no muestra el panel, y la cookie vieja da 401. ✔ (e2e)
5. **Membresía desactivada (`baja@`)** → sin acceso. ✔ (e2e) Si el usuario tiene otras empresas activas,
   `/sin-acceso` ofrece elegir otra.
6. **Seller:**
   - no ve Canales, Catálogo, Agente ni Consumo;
   - esas URLs escritas a mano llevan a sin acceso;
   - el viewer ve solo Métricas.

   ✔ (e2e)

7. **`?redirect=` externo** (`https://`, `//` y `/\`) → queda en el panel; una ruta interna sí se respeta. ✔
   (e2e + unitarios, incluido `/.//host`)
8. **Cookie de sesión:**
   - es `HttpOnly` y `SameSite=Lax`, y JS no la ve;
   - en `localStorage` solo queda `panel.theme`;
   - `sessionStorage` está vacío.

   ✔ (e2e)

9. **`Origin` falso o ausente** → 403 `ORIGIN_NOT_ALLOWED`; `sign-up` por HTTP → 400; `admin/create-user` sin
   sesión → 401 y con un owner → 403. ✔ (e2e del panel + tests de la API)
10. **Tests:**
    - 59 unitarios del panel (`AuthService`, guards, interceptor, `safeRedirect`, nav por rol, puntaje);
    - 11 e2e de Playwright;
    - API completa: 589/589.

    ✔

11. **Capturas:** 32 (login, error de login, elegir empresa, sin acceso, layout del owner, menús, selector
    del seller y `/dev/diseno`), en claro y oscuro, a 375 y 1280 px. Están en `apps/web/test-results/capturas/`
    (fuera de git). Las aprobó el usuario. ✔
12. **Chequeos generales:**
    - `npm run lint`, `typecheck`, `build` y `test` pasan;
    - el bundle inicial pesa 480 kB (124 kB comprimido);
    - el build no contiene "diseno";
    - `git status` no muestra ningún `.env`.

    ✔

### Revisores

- **`revisor-seguridad`:** APROBADO, sin hallazgos críticos ni altos.
  - **Corregido:**
    - **(MEDIO) Deuda del rate limit mal descripta.** Better Auth ya lee `X-Forwarded-For`. El riesgo real es
      un XFF falsificado si la API queda expuesta, porque hoy escucha en todas las interfaces.
    - **(BAJO) Excepción del webhook:** pasó de prefijo a ruta exacta.
    - **(BAJO) ESLint:** ahora detecta los accesos con corchetes y `createContextualFragment`.
  - **Quedan como deuda:**
    - el bloque `db` de diagnóstico en `/api/me/context` (de la 002, lo usan sus tests);
    - `tools/panel-pruebas/empresas.local.json` sin ignorar en esta rama (en la de la 010 sí está ignorado).
- **`revisor-codigo`:** primera ronda, CAMBIOS REQUERIDOS.
  - El bloqueante (no se habían corrido los e2e ni las capturas) quedó resuelto.
  - **(IMPORTANTE) `safeRedirect` con `/.//host`:** corregido.
  - **Menores corregidos:**
    - el callejón sin salida en `/sin-acceso`;
    - el estado `forbidden` que no se volvía a consultar;
    - ESLint en el `host` y en `@HostBinding`.
  - **Menores que quedan:**
    - con la API caída, el usuario con sesión ve el login (sería mejor una pantalla de reintento);
    - un 403 por origen termina en "sin acceso", que es lo que pide la tarea.
  - **Segunda ronda: APROBADO**, sin bloqueantes ni importantes y sin regresiones.
  - Menores que quedan:
    - `no-access-page` no tiene test unitario propio (lo cubre el e2e);
    - el diff de `docs/decisiones.md` tiene ruido de formato por Prettier (re-padding de la tabla).

### Pendiente para tareas siguientes

- **Rate limit en producción** (deuda en `docs/decisiones.md`):
  - escuchar en `127.0.0.1`;
  - guardar los contadores en la base;
  - limitar por email.
- **CSP:** validar el nonce de estilos con Caddy al desplegar. Si se cambia el script del tema en
  `index.html`, recalcular su hash.
- **Tarea 014:**
  - generador de cliente desde OpenAPI;
  - la grilla de leads con `app-score`, `app-tag-list`, `cdk-table` y el paginador de `/dev/diseno`, paginada
    en el servidor.
