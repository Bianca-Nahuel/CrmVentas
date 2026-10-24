import 'reflect-metadata';
import { loadLocalEnv } from '../src/config/load-env.js';

loadLocalEnv();

// WAHA en los tests: valores propios (nunca la clave real) y una API inalcanzable, así ningún test
// habla con el WAHA de desarrollo ni depende de cómo esté el .env.
process.env.WAHA_WEBHOOK_HMAC_KEY = 'test-only-waha-hmac-key-0123456789abcdef';
process.env.WAHA_BASE_URL = 'http://127.0.0.1:9';
process.env.WAHA_API_KEY = 'test-only-waha-api-key';
process.env.WAHA_WEBHOOK_URL = 'http://host.docker.internal:3000/api/webhooks/waha';
