// Sincronización del perfil de riesgo entre dispositivos.
//
// PURO — no toca red ni disco. La ruta y el store hacen el I/O.
//
// LA TENSIÓN QUE RESUELVE: el saldo vive en localStorage a propósito, para que
// nunca llegue al servidor. Sincronizarlo entre el móvil y el portátil obliga a
// que salga. La salida NO es un archivo único en el servidor — eso ya se probó
// con el watchlist y en un despliegue compartido toda la clase acabó viendo el
// mismo. Aquí cada perfil se guarda bajo la huella de un **código de
// sincronización** que elige el usuario, así que dos personas en el mismo
// servidor nunca se pisan.
//
// Qué viaja: el tamaño de cuenta y la tolerancia. Nada más. Ni posiciones, ni
// watchlist, ni nada que identifique a nadie.

import type { RiskProfile } from "./risk";

/**
 * Mínimo del código. Con menos de 6 caracteres cualquiera en la red podría
 * acertarlo probando, y aunque un saldo no es una contraseña, sigue siendo tuyo.
 */
export const MIN_CODE_LENGTH = 6;
export const MAX_CODE_LENGTH = 64;

export interface SyncedProfile {
  accountSize: number;
  tolerancePct: number;
  /** ISO. Resuelve los conflictos: gana la escritura más reciente. */
  updatedAt: string;
  /** Etiqueta del último dispositivo que escribió, para poder mostrarlo. */
  device?: string;
}

/**
 * Normaliza el código antes de usarlo como clave.
 *
 * Sin esto "MiCuenta" y "micuenta " serían dos perfiles distintos y el usuario
 * juraría que la sincronización no funciona. Se baja a minúsculas y se recortan
 * los espacios de los extremos — los de en medio se respetan, por si alguien
 * usa una frase.
 */
export function normalizeCode(raw: string): string {
  return raw.trim().toLowerCase();
}

export interface CodeCheck {
  ok: boolean;
  reason?: string;
}

export function validateCode(raw: string): CodeCheck {
  const code = normalizeCode(raw);
  if (code.length === 0) return { ok: false, reason: "Escribe un código de sincronización." };
  if (code.length < MIN_CODE_LENGTH) {
    return { ok: false, reason: `El código necesita al menos ${MIN_CODE_LENGTH} caracteres.` };
  }
  if (code.length > MAX_CODE_LENGTH) {
    return { ok: false, reason: `El código no puede pasar de ${MAX_CODE_LENGTH} caracteres.` };
  }
  return { ok: true };
}

/** Número finito y positivo, o 0. Blinda contra lo que llegue por la red. */
function safe(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Sanea lo que venga del cliente. La ruta NO confía en el cuerpo del POST:
 * un saldo negativo o un `Infinity` colado aquí saldría luego como un número de
 * contratos absurdo en el otro dispositivo.
 */
export function sanitize(input: unknown, now: Date): SyncedProfile | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  const accountSize = safe(o.accountSize);
  const tolerancePct = safe(o.tolerancePct);
  if (accountSize === 0 || tolerancePct === 0) return null;

  const device = typeof o.device === "string" ? o.device.slice(0, 40) : undefined;
  return {
    accountSize,
    // La tolerancia es un % y el slider va de 1 a 10: más de 100 no significa nada.
    tolerancePct: Math.min(tolerancePct, 100),
    updatedAt: now.toISOString(),
    ...(device ? { device } : {}),
  };
}

/**
 * Decide qué gana entre lo local y lo remoto: la escritura más reciente.
 *
 * Es "last write wins" a conciencia. Para una persona con dos dispositivos es
 * exactamente lo que se espera —lo último que tocaste es lo que vale— y montar
 * un merge de verdad para dos números sería complejidad sin comprador. Con
 * fechas iguales gana lo REMOTO, para que dos dispositivos converjan al mismo
 * valor en vez de quedarse cada uno con el suyo y no acabar nunca.
 */
export function pickNewer(
  local: SyncedProfile | null,
  remote: SyncedProfile | null,
): SyncedProfile | null {
  if (!local) return remote;
  if (!remote) return local;
  const l = Date.parse(local.updatedAt);
  const r = Date.parse(remote.updatedAt);
  if (!Number.isFinite(l)) return remote;
  if (!Number.isFinite(r)) return local;
  return l > r ? local : remote;
}

/** Lo que consume la UI. */
export function toProfile(s: SyncedProfile): RiskProfile {
  return { accountSize: s.accountSize, tolerancePct: s.tolerancePct };
}

/** Nombre corto del dispositivo, para poder decir "lo cambiaste en el iPhone". */
export function deviceLabel(userAgent: string): string {
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/Android/i.test(userAgent)) return "Android";
  if (/Macintosh|Mac OS/i.test(userAgent)) return "Mac";
  if (/Windows/i.test(userAgent)) return "Windows";
  return "otro dispositivo";
}
