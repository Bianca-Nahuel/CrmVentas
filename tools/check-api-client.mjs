// Chequeo de `npm run lint`: el documento OpenAPI (apps/api/openapi.json) y el cliente generado del panel
// (apps/web/src/app/api/generated) tienen que estar al día con los contratos zod de la API. Si alguien
// cambia un contrato y no corre `npm run api:generate`, esto falla.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const web = join(root, 'apps/web');
const committed = join(web, 'src/app/api/generated');
const run = (args, cwd) => execFileSync(process.execPath, args, { cwd, stdio: 'inherit' });

// 1. openapi.json al día (el script compara y sale con error si no).
run([join(root, 'node_modules/tsx/dist/cli.mjs'), 'scripts/openapi.ts', '--check'], join(root, 'apps/api'));

// 2. El cliente generado desde ese documento es igual al commiteado.
const temp = mkdtempSync(join(tmpdir(), 'api-client-'));
try {
  run(
    [
      join(root, 'node_modules/ng-openapi-gen/lib/index.js'),
      '-c',
      'ng-openapi-gen.json',
      '-o',
      temp,
      '--silent',
      'true',
    ],
    web,
  );
  const list = (dir) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
      .sort();
  const normalize = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const expected = list(temp);
  const actual = list(committed);
  const stale =
    expected.join('\n') !== actual.join('\n') ||
    expected.some((file) => normalize(join(temp, file)) !== normalize(join(committed, file)));
  if (stale) {
    console.error(
      'El cliente del panel (apps/web/src/app/api/generated) no está al día: correr npm run api:generate',
    );
    process.exit(1);
  }
  console.log('Cliente de la API al día.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
