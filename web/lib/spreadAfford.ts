// Cuántos spreads caben en tu cuenta.
//
// PURO y pensado para correr en el CLIENTE: recibe el saldo, que vive en
// localStorage (`tito.risk.*`) y nunca llega al servidor. Aislado de la ruta a
// propósito, igual que `wheelAfford.ts`.
//
// LO QUE HACE SIMPLE ESTE ARCHIVO —y es la razón de ser de todo el screener—:
// en una estructura de riesgo definido **colateral, desembolso y pérdida máxima
// son el MISMO número**. El bróker retiene la pérdida máxima en un crédito, y
// en un débito pagas justo lo que puedes perder. No hay que reconciliar dos
// cifras como en un put desnudo, donde el colateral (strike × 100) no tiene
// nada que ver con lo que esperas perder.

import type { SpreadCandidate } from "./spreads";
import type { RiskProfile } from "./risk";

/** Cuál de las dos restricciones produjo el techo. */
export type SpreadBinding = "tolerancia" | "saldo";

export interface SpreadAfford {
  /** Techo de contratos. 0 = no cabe. */
  maxContracts: number;
  binding: SpreadBinding | null;
  /** Pérdida máxima de UN spread, en $. Es también lo que inmoviliza. */
  riskPerContract: number;
  /** Riesgo total si abres el máximo, en $. */
  totalRisk: number;
  /** Crédito (o desembolso) total al abrir el máximo, en $. */
  totalNet: number;
  /** Lo que te falta para que quepa UNO, en $. 0 si ya cabe. */
  shortfall: number;
  /** Ancho de ala que sí te cabría, en $. null si ya cabe o no se puede saber. */
  suggestedWidth: number | null;
  blocked: boolean;
}

const VACIO: SpreadAfford = {
  maxContracts: 0, binding: null, riskPerContract: 0,
  totalRisk: 0, totalNet: 0, shortfall: 0, suggestedWidth: null, blocked: true,
};

function safe(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function affordSpread(candidate: SpreadCandidate, profile: RiskProfile): SpreadAfford {
  if (candidate.blocked || !candidate.metrics) return VACIO;

  const account = safe(profile?.accountSize);
  const tolerance = safe(profile?.tolerancePct);
  const riskPerContract = safe(candidate.metrics.maxLoss);
  if (account === 0 || riskPerContract === 0) return { ...VACIO, riskPerContract };

  // Dos topes distintos y ambos reales: la tolerancia es cuánto ACEPTAS perder
  // en una operación; el saldo es cuánto PUEDES inmovilizar. En una cuenta
  // pequeña casi siempre manda la tolerancia, y conviene decirlo.
  const riskBudget = (account * tolerance) / 100;
  const byTolerance = Math.floor(riskBudget / riskPerContract);
  const byCash = Math.floor(account / riskPerContract);
  const maxContracts = Math.max(0, Math.min(byTolerance, byCash));

  const binding: SpreadBinding | null =
    maxContracts === 0 ? null : byTolerance <= byCash ? "tolerancia" : "saldo";

  // Si no cabe ni uno, el ala más estrecha que sí entraría. El ancho y la
  // pérdida máxima son proporcionales, así que la regla de tres es exacta
  // salvo por el crédito — se redondea hacia abajo a $0,50, que es el paso
  // habitual de strikes.
  let suggestedWidth: number | null = null;
  if (maxContracts === 0) {
    const cabe = Math.min(riskBudget, account);
    const ratio = cabe / riskPerContract;
    const ancho = Math.floor(candidate.metrics.width * ratio * 2) / 2;
    suggestedWidth = ancho >= 0.5 ? ancho : null;
  }

  return {
    maxContracts,
    binding,
    riskPerContract,
    totalRisk: maxContracts * riskPerContract,
    totalNet: maxContracts * Math.abs(candidate.metrics.net) * 100,
    shortfall: maxContracts > 0 ? 0 : Math.max(0, riskPerContract - Math.min(riskBudget, account)),
    suggestedWidth,
    blocked: false,
  };
}

export type AffordableSpread = SpreadCandidate & { afford: SpreadAfford };

/** Lo que cabe primero, y dentro de eso el mejor score. */
export function sortByAffordThenScore(
  candidates: SpreadCandidate[],
  profile: RiskProfile,
): AffordableSpread[] {
  return candidates
    .map((c) => ({ ...c, afford: affordSpread(c, profile) }))
    .sort((a, b) => {
      if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
      const cabeA = a.afford.maxContracts > 0;
      const cabeB = b.afford.maxContracts > 0;
      if (cabeA !== cabeB) return cabeA ? -1 : 1;
      return (b.score?.total ?? 0) - (a.score?.total ?? 0);
    });
}
