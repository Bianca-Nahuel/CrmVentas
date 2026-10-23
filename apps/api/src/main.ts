import { loadLocalEnv } from './config/load-env.js';

// Las variables tienen que estar cargadas antes de importar los módulos de la app.
loadLocalEnv();

const { parseEnv } = await import('./config/env.js');
const { createApp } = await import('./bootstrap.js');

const env = parseEnv();
const app = await createApp();
await app.listen(env.PORT);
