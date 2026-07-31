// Cruce entre NUESTRO score de inusualidad y el que calcula MarketSnack.
//
// PURO — no toca red ni disco.
//
// ─────────────────────────────────────────────────────────────────────────
// EL 0 DE MARKETSNACK NO ES UN CERO, ES "SIN CALCULAR". Es lo más importante
// de este archivo y lo que invierte la señal si se ignora.
//
// Medido contra su API (jul 2026):
//   · En `unusual-flow-spike` el **76%** de las filas traen score 0… y esos
//     ceros tienen una prima MEDIANA de $353.000. Si el 0 midiera calidad, las
//     operaciones más grandes del feed no estarían todas ahí.
//   · Los valores no-cero nunca caen entre 1 y 33: hay un hueco. Un score real
//     de 0-100 poblaría ese rango.
// Tratar ese 0 como "puntuación baja" daba correlación **negativa** (r = −0,54)
// con el nuestro. Excluyéndolos, el acuerdo aparece:
//   · mercado general    r = 0,62   ρ = 0,53
//   · unusual-flow-spike r = 0,78   ρ = 0,85
//   · 0dte-momentum      r = −0,01  ρ = 0,02   ← SIN relación
//
// POR QUÉ EN 0DTE NO SE PARECEN, y no es un fallo de ninguno: nuestro
// `unusualTradeScore` incluye `expiryScore` y `thetaScore`, que castigan el
// vencimiento corto y la quema alta. El suyo premia exactamente eso. Miden
// cosas distintas justo en ese régimen, así que ahí el cruce NO se aplica.
// ─────────────────────────────────────────────────────────────────────────

/** Nuestro score va 0-10; el de MarketSnack, 0-100. */
const MI_MAX = 10;
const MS_MAX = 100;

/**
 * Cuánto se deja mover nuestro score por el suyo.
 *
 * Amortiguado y acotado como la calibración de `prediction.ts`, y por la misma
 * razón: el nuestro es el que lleva la semántica de seguridad (theta, expiry),
 * así que el ajeno **matiza, no decide**. Con ganancia 0,35 y tope 1 punto, una
 * discrepancia máxima mueve el score un 10% de la escala.
 */
export const CONSENSUS = { gain: 0.35, capPoints: 1 } as const;

/** Diferencia (en puntos de nuestra escala) a partir de la cual hay discrepancia. */
const DISCREPA_DESDE = 1.5;

/**
 * Score de MarketSnack utilizable, o `null`.
 *
 * **Es la única puerta de entrada de ese campo al motor.** El 0 se convierte en
 * `null` a propósito: significa "no calculado", y dejarlo pasar como 0 hunde el
 * consenso de las operaciones más grandes.
 */
export function msScore(raw: number | null | undefined): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw <= 0) return null;
  return Math.min(raw, MS_MAX);
}

export type Agreement = "confirma" | "discrepa" | "solo_nuestro";

export interface Consensus {
  /** Nuestro score, 0-10. */
  mine: number;
  /** El suyo ya normalizado a 0-10, o null si no lo calculó. */
  ms: number | null;
  agreement: Agreement;
  /** El score que usa el ranking. Igual a `mine` cuando no hay segunda opinión. */
  combined: number;
  why: string;
}

export interface ConsensusInput {
  mine: number;
  msRaw: number | null | undefined;
  /**
   * true cuando la operación vence hoy. **Desactiva el cruce**: está medido que
   * en ese régimen los dos scores no guardan relación (ρ = 0,02), así que
   * mezclarlos solo añadiría ruido con aspecto de señal.
   */
  zeroDte?: boolean;
}

export function consensus(input: ConsensusInput): Consensus {
  const mine = Number.isFinite(input.mine) ? input.mine : 0;
  const bruto = msScore(input.msRaw);

  if (bruto == null) {
    return {
      mine, ms: null, agreement: "solo_nuestro", combined: mine,
      why: "MarketSnack no calculó score para esta operación.",
    };
  }

  const ms = (bruto / MS_MAX) * MI_MAX;

  if (input.zeroDte) {
    return {
      mine, ms, agreement: "solo_nuestro", combined: mine,
      why: "En 0DTE los dos scores miden cosas distintas: no se cruzan.",
    };
  }

  const delta = ms - mine;
  const ajuste = Math.max(
    -CONSENSUS.capPoints,
    Math.min(CONSENSUS.capPoints, delta * CONSENSUS.gain),
  );
  const combined = Math.round(Math.max(0, Math.min(MI_MAX, mine + ajuste)) * 10) / 10;

  const agreement: Agreement = Math.abs(delta) < DISCREPA_DESDE ? "confirma" : "discrepa";
  const why = agreement === "confirma"
    ? `MarketSnack lo puntúa ${bruto}/100, en línea con nuestro ${mine}/10.`
    : delta > 0
      ? `MarketSnack lo valora bastante más alto (${bruto}/100 frente a nuestro ${mine}/10).`
      : `MarketSnack lo valora bastante más bajo (${bruto}/100 frente a nuestro ${mine}/10).`;

  return { mine, ms, agreement, combined, why };
}
