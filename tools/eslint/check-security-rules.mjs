// Comprueba que las reglas de seguridad del panel siguen activas: lintea ejemplos prohibidos con la
// configuración real del repo y falla si alguno pasa. Corre con `npm run lint`.
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const eslint = new ESLint({ cwd: fileURLToPath(new URL('../..', import.meta.url)) });
const file = 'apps/web/src/app/__lint-check__.ts';

const forbidden = {
  'binding [innerHTML]': `
    import { Component } from '@angular/core';
    @Component({ selector: 'app-x', template: '<p [innerHTML]="html"></p>' })
    export class X { html = ''; }`,
  'binding [attr.outerHTML]': `
    import { Component } from '@angular/core';
    @Component({ selector: 'app-x', template: '<p [attr.outerHTML]="html"></p>' })
    export class X { html = ''; }`,
  bypassSecurityTrustHtml: `
    import { DomSanitizer } from '@angular/platform-browser';
    export function f(s: DomSanitizer, v: string) { return s.bypassSecurityTrustHtml(v); }`,
  'asignar innerHTML': `export function f(el: HTMLElement, v: string) { el.innerHTML = v; }`,
  insertAdjacentHTML: `export function f(el: HTMLElement, v: string) { el.insertAdjacentHTML('beforeend', v); }`,
  'innerHTML con corchetes': `export function f(el: HTMLElement, v: string) { el['innerHTML'] = v; }`,
  'bypassSecurityTrust con corchetes': `
    import { DomSanitizer } from '@angular/platform-browser';
    export function f(s: DomSanitizer, v: string) { return s['bypassSecurityTrustHtml'](v); }`,
  'Object.assign con innerHTML': `export function f(el: HTMLElement, innerHTML: string) { Object.assign(el, { innerHTML }); }`,
  'host [innerHTML]': `
    import { Component } from '@angular/core';
    @Component({ selector: 'app-x', template: '', host: { '[innerHTML]': 'html' } })
    export class X { html = ''; }`,
  'HostBinding innerHTML': `
    import { Directive, HostBinding } from '@angular/core';
    @Directive({ selector: '[appX]' })
    export class X { @HostBinding('innerHTML') html = ''; }`,
  createContextualFragment: `export function f(r: Range, v: string) { return r.createContextualFragment(v); }`,
};

const allowed = `
  import { Component } from '@angular/core';
  @Component({ selector: 'app-x', template: '<p>{{ text }}</p>' })
  export class X { text = ''; }`;

let failed = false;
for (const [name, code] of Object.entries(forbidden)) {
  const [result] = await eslint.lintText(code, { filePath: file });
  const security = result.messages.filter(
    (m) => m.ruleId === 'no-restricted-syntax' || m.ruleId === 'security/no-inner-html-binding',
  );
  if (security.length === 0) {
    failed = true;
    console.error(`✗ La regla de seguridad no detectó: ${name}`);
  } else {
    console.log(`✓ Detectado: ${name}`);
  }
}
const [ok] = await eslint.lintText(allowed, { filePath: file });
if (ok.messages.some((m) => m.ruleId?.startsWith('security/') || m.ruleId === 'no-restricted-syntax')) {
  failed = true;
  console.error('✗ La regla de seguridad marcó una interpolación de texto (falso positivo)');
}
process.exit(failed ? 1 : 0);
