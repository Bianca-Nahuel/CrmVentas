// Vinculación por QR con WAHA (2026.8.x): lectura de las respuestas de la API de sesiones. Funciones puras;
// las usa WahaProvider.
// Documentación: https://waha.devlike.pro/docs/how-to/sessions/ — el primer QR vence a los 60 s y cada
// uno de los siguientes a los 20 s; después de 6, la sesión pasa a FAILED y hay que reiniciarla.
import type { ConnectionResult, PairingQr, SessionState } from '../../provider.js';
import type { WahaCallOutcome } from './waha-client.js';
import { toE164 } from './waha-normalize.js';

// Un PNG de QR de WAHA pesa unos pocos kB: más que esto no es un QR y no se le pasa al panel.
const MAX_QR_BASE64 = 100_000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

function outcomeCode(outcome: WahaCallOutcome): string {
  return outcome.kind === 'response' ? `http_${outcome.status}` : outcome.code;
}

export function isOk(outcome: WahaCallOutcome): boolean {
  return outcome.kind === 'response' && outcome.status >= 200 && outcome.status < 300;
}

export function isNotFound(outcome: WahaCallOutcome): boolean {
  return outcome.kind === 'response' && outcome.status === 404;
}

export function isUnprocessable(outcome: WahaCallOutcome): boolean {
  return outcome.kind === 'response' && outcome.status === 422;
}

export function toConnectionResult(outcome: WahaCallOutcome): ConnectionResult {
  return isOk(outcome) ? { ok: true } : { ok: false, code: outcomeCode(outcome) };
}

/**
 * `GET /api/sessions/{session}` → estado de la vinculación. `SCAN_QR_CODE` → hay que pedir el QR
 * (devuelve null). 404 (la sesión no existe), STOPPED o FAILED → expired.
 */
export function pairingFromSession(outcome: WahaCallOutcome): PairingQr | null {
  if (isNotFound(outcome)) return { state: 'expired' };
  if (!isOk(outcome) || outcome.kind !== 'response')
    return { state: 'unavailable', code: outcomeCode(outcome) };
  switch (field(parseJson(outcome.text), 'status')) {
    case 'SCAN_QR_CODE':
      return null;
    case 'WORKING':
      return { state: 'connected' };
    // Passkey (GOWS): no se ofrece desde el panel; mientras tanto, se espera.
    case 'STARTING':
    case 'PASSKEY_REQUIRED':
    case 'PASSKEY_CONFIRMATION_REQUIRED':
      return { state: 'starting' };
    case 'STOPPED':
    case 'FAILED':
      return { state: 'expired' };
    default:
      return { state: 'unavailable', code: 'estado_desconocido' };
  }
}

/**
 * `GET /api/{session}/auth/qr` con `Accept: application/json` → `{ mimetype: 'image/png', data: <base64> }`.
 * Se valida antes de pasarlo al panel: solo un PNG en base64, de tamaño razonable.
 * 422: la sesión ya no está esperando el escaneo (se conectó o venció en el medio) → starting, y el panel
 * vuelve a preguntar.
 */
export function pairingFromQr(outcome: WahaCallOutcome): PairingQr {
  if (isUnprocessable(outcome)) return { state: 'starting' };
  if (isNotFound(outcome)) return { state: 'expired' };
  if (!isOk(outcome) || outcome.kind !== 'response')
    return { state: 'unavailable', code: outcomeCode(outcome) };
  const body = parseJson(outcome.text);
  const data = field(body, 'data');
  if (field(body, 'mimetype') !== 'image/png' || typeof data !== 'string') {
    return { state: 'unavailable', code: 'qr_ilegible' };
  }
  if (data.length === 0 || data.length > MAX_QR_BASE64 || !BASE64.test(data)) {
    return { state: 'unavailable', code: 'qr_ilegible' };
  }
  return { state: 'qr', image: `data:image/png;base64,${data}` };
}

/**
 * `GET /api/sessions/{session}` → estado para el vigía de reconexión. WORKING trae el número vinculado en
 * `me.id`. STOPPED y FAILED conservan la vinculación (se reinicia sin QR); SCAN_QR_CODE o 404 quieren
 * decir que el teléfono ya no está vinculado.
 */
export function sessionStateFrom(outcome: WahaCallOutcome): SessionState {
  if (isNotFound(outcome)) return { state: 'needs_scan' };
  if (!isOk(outcome) || outcome.kind !== 'response')
    return { state: 'unavailable', code: outcomeCode(outcome) };
  const body = parseJson(outcome.text);
  switch (field(body, 'status')) {
    case 'WORKING': {
      const me = field(field(body, 'me'), 'id');
      return { state: 'connected', phoneNumber: typeof me === 'string' ? toE164(me) : null };
    }
    case 'STARTING':
    case 'PASSKEY_REQUIRED':
    case 'PASSKEY_CONFIRMATION_REQUIRED':
      return { state: 'starting' };
    case 'STOPPED':
    case 'FAILED':
      return { state: 'stopped' };
    case 'SCAN_QR_CODE':
      return { state: 'needs_scan' };
    default:
      return { state: 'unavailable', code: 'estado_desconocido' };
  }
}
