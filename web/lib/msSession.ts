// Sesión viva de MarketSnack. web/data/marketsnack-session.json (gitignored).
// Solo servidor.
//
// POR QUÉ EXISTE, y es un hallazgo de verdad: MarketSnack corre sobre Rails y
// **emite una cookie de sesión NUEVA en cada respuesta** (verificado — el valor
// que mandas y el que te devuelve tienen hash distinto, y el devuelto autentica
// por sí solo). La app venía reenviando eternamente la cookie fija de
// `.env.local` y tirando la renovada a la basura.
//
// Si Rails tiene la sesión configurada con `expire_after` —lo habitual—, la
// caducidad va DENTRO de la cookie y se refresca al reemitirla. Reenviar
// siempre la vieja equivale a que el reloj no se reinicie nunca: caduca a las
// ~24h por muchas peticiones que hagas, que es justo lo que se observó.
//
// NO ESTÁ GARANTIZADO que esto la mantenga viva para siempre: si la caducidad
// fuera absoluta y no deslizante, seguirá muriendo igual. Es la única palanca
// que tenemos de este lado y no cuesta nada, pero lo que dirá la verdad es el
// chequeo de salud de los próximos días.

import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "marketsnack-session.json");

/** Nombre de la cookie de sesión de Rails en MarketSnack. */
export const SESSION_COOKIE = "_market_snack_session";

interface Stored {
  cookie: string;
  updatedAt: string;
}

/** Caché en memoria: la sesión se lee en cada petición del escáner. */
let cache: Stored | null = null;
let loaded = false;

/**
 * Escribir en disco en cada petición sería absurdo: un escaneo hace decenas y
 * el valor sirve igual. Se guarda como mucho una vez por minuto.
 */
const SAVE_EVERY_MS = 60_000;
let lastSave = 0;

export async function loadSession(): Promise<string | null> {
  if (loaded) return cache?.cookie ?? null;
  loaded = true;
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as Stored;
    cache = typeof parsed?.cookie === "string" && parsed.cookie ? parsed : null;
  } catch {
    cache = null; // todavía no se ha guardado ninguna
  }
  return cache?.cookie ?? null;
}

/**
 * Extrae `_market_snack_session=…` de una cabecera `set-cookie`.
 *
 * Devuelve el par entero (`nombre=valor`) y no solo el valor, porque es lo que
 * se reenvía tal cual en la cabecera `Cookie`.
 */
export function parseSetCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  // `getSetCookie()` puede unir varias con coma; el valor de Rails es base64 y
  // no lleva comas, así que partir por coma es seguro aquí.
  for (const trozo of setCookie.split(/,(?=\s*[A-Za-z_][A-Za-z0-9_-]*=)/)) {
    const par = trozo.trim().split(";")[0];
    if (par.startsWith(`${SESSION_COOKIE}=`) && par.length > SESSION_COOKIE.length + 1) {
      return par;
    }
  }
  return null;
}

/** Guarda la sesión rotada. Silencioso: nunca debe tumbar un escaneo. */
export async function saveSession(cookiePair: string, now = Date.now()): Promise<void> {
  if (!cookiePair) return;
  if (cache?.cookie === cookiePair) return;
  cache = { cookie: cookiePair, updatedAt: new Date(now).toISOString() };
  loaded = true;
  if (now - lastSave < SAVE_EVERY_MS) return;
  lastSave = now;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(cache, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch {
    // Disco de solo lectura o permisos: la sesión sigue viva en memoria.
  }
}

/** Cuándo se refrescó por última vez. Lo usa el chequeo de salud. */
export async function sessionAge(): Promise<{ updatedAt: string | null }> {
  await loadSession();
  return { updatedAt: cache?.updatedAt ?? null };
}

/**
 * Sustituye el `_market_snack_session` del tarro por el vivo.
 *
 * Se conserva el resto del tarro de `.env.local` porque no cuesta nada, aunque
 * está comprobado que la de sesión basta: las otras 11 son de analítica
 * (Google, Amplitude, Intercom, Facebook) y no autentican nada.
 */
export function withLiveSession(envCookie: string, live: string | null): string {
  if (!live) return envCookie;
  const pares = envCookie.split(";").map((p) => p.trim()).filter(Boolean);
  const otras = pares.filter((p) => !p.startsWith(`${SESSION_COOKIE}=`));
  return [...otras, live].join("; ");
}
