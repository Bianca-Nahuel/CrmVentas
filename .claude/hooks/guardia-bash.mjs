// PreToolUse (Bash): bloquea comandos que leen secretos o destruyen datos.
// Salida con código 2 = el comando NO se ejecuta y el mensaje de stderr le llega al agente.
import { readFileSync } from 'node:fs';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0); // sin input legible: no bloquear
}

const cmd = String(input?.tool_input?.command ?? '');
// Versión sin comillas, barras ni "+" para ver nombres partidos (.e""nv, ".e"+"nv).
// Es una red de seguridad: la barrera principal es permissions.deny en settings.json.
const plano = cmd.replace(/\\+/g, '/').replace(/["'`+]/g, '');

const reglas = [
  {
    // .env pero no .env.example; el delimitador previo es cualquier cosa que no sea parte de un nombre
    patron: /(^|[^\w.-])\.env(?![.\w-]*example)/i,
    motivo: 'El comando toca el archivo .env (secretos). Usá .env.example o pedile el valor al usuario.',
    sobre: plano,
  },
  {
    // comodines que alcanzan .env (.e*, .en?, .?nv, .*)
    patron: /(^|[^\w.-])\.(e[?*[]|en[?*[]|[?*]nv|\*)/i,
    motivo: 'Comodín que podría alcanzar el archivo .env (secretos).',
    sobre: plano,
  },
  {
    // vuelca las variables de .env ya resueltas
    patron: /docker\s+compose\b[^\n]*\bconfig\b/i,
    motivo: 'docker compose config muestra los valores de .env (secretos). Pedile al usuario que lo ejecute él.',
  },
  {
    patron: /\b(drop\s+(table|database|schema|role|owned)|truncate\b|dropdb\b)/i,
    motivo: 'SQL destructivo (DROP/TRUNCATE). Si es intencional, pedí confirmación explícita al usuario y que lo ejecute él.',
  },
  {
    // DELETE sin WHERE, con nombre calificado o entre comillas
    patron: /\bdelete\s+from\s+(only\s+)?["\w.]+(\s+(as\s+)?\w+)?\s*(;|$)/i,
    motivo: 'DELETE sin WHERE. Agregá una condición o pedí confirmación al usuario.',
  },
  {
    patron: /docker\s+compose\b[^\n]*\bdown\b[^\n]*(\s-v\b|--volumes)|docker\s+volume\s+(rm|prune)|docker\s+system\s+prune\b[^\n]*--volumes/i,
    motivo: 'Esto borra los volúmenes (base de datos y sesiones de WAHA). Pedile al usuario que lo ejecute él si realmente quiere resetear.',
  },
  {
    patron: /\bgit\s+(push\b[^\n]*(\s-f\b|--force|\s\+\S)|reset\s+--hard|clean\b[^\n]*\s(-\w*f\w*|--force)\b|checkout\s+(--\s+)?\.\s*$|restore\s+\.\s*$)/i,
    motivo: 'Operación de git destructiva. Pedí confirmación al usuario.',
  },
  {
    patron: /\brm\s+(-\w*[rR]\w*|--recursive)\b|\bRemove-Item\b[^\n]*-Recurse|\b(rmdir|rd)\s+\/s\b|\bdel\s+(\/\w+\s+)*\/s\b/i,
    motivo: 'Borrado recursivo. Pedile al usuario que lo ejecute él o confirmá el alcance.',
  },
];

for (const { patron, motivo, sobre } of reglas) {
  if (patron.test(sobre ?? cmd)) {
    process.stderr.write(`Bloqueado por guardia-bash: ${motivo}\n`);
    process.exit(2);
  }
}

process.exit(0);
