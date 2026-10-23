// PostToolUse (Edit|Write): formatea con Prettier el archivo que el agente acaba de tocar.
// Nunca bloquea: si Prettier no está instalado todavía (proyecto recién creado), no hace nada.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, extname } from 'node:path';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const file = input?.tool_input?.file_path;
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const extensiones = new Set(['.ts', '.js', '.mjs', '.json', '.html', '.scss', '.css', '.md', '.yml', '.yaml']);

if (!file || !extensiones.has(extname(file).toLowerCase())) process.exit(0);
if (/(^|[\\/])\.env/.test(file)) process.exit(0);

const prettierBin = join(projectDir, 'node_modules', '.bin', process.platform === 'win32' ? 'prettier.cmd' : 'prettier');
if (!existsSync(prettierBin)) process.exit(0);

spawnSync(prettierBin, ['--write', '--log-level', 'warn', file], {
  cwd: projectDir,
  stdio: 'ignore',
  shell: process.platform === 'win32',
});

process.exit(0);
