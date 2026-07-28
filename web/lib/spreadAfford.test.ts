import { describe, expect, it } from "vitest";
import { affordSpread, sortByAffordThenScore } from "./spreadAfford";
import type { SpreadCandidate, SpreadMetrics } from "./spreads";

function candidate(maxLoss: number, over: Partial<SpreadCandidate> = {}): SpreadCandidate {
  const metrics: SpreadMetrics = {
    net: 1.2, credit: 120, debit: 0, width: 5,
    maxProfit: 120, maxLoss, breakevens: [98.8],
    returnOnRisk: (120 / maxLoss) * 100, annualizedPct: 30, pop: 75,
  };
  return {
    ticker: "TEST", kind: "put_credit", label: "", thesis: "",
    expiration: "2026-09-18", dte: 40, spot: 110, legs: [],
    metrics, score: { total: 70 } as never,
    blocked: false, blockReason: null, strikesLabel: "100/95",
    ...over,
  };
}

describe("affordSpread", () => {
  it("el techo sale del presupuesto de riesgo, no del saldo entero", () => {
    // $1.000 al 10% = $100 de riesgo. Un spread que arriesga $380 no cabe.
    const a = affordSpread(candidate(380), { accountSize: 1000, tolerancePct: 10 });
    expect(a.maxContracts).toBe(0);
    expect(a.shortfall).toBeCloseTo(280, 6);
  });

  it("cuenta contratos cuando sí cabe, y dice quién manda", () => {
    const a = affordSpread(candidate(380), { accountSize: 10000, tolerancePct: 20 });
    expect(a.maxContracts).toBe(5); // 2.000 / 380 → 5
    expect(a.binding).toBe("tolerancia");
    expect(a.totalRisk).toBeCloseTo(1900, 6);
  });

  it("con tolerancia altísima manda el saldo", () => {
    const a = affordSpread(candidate(380), { accountSize: 1000, tolerancePct: 100 });
    expect(a.binding).toBe("saldo");
    expect(a.maxContracts).toBe(2); // 1.000 / 380
  });

  it("NUNCA arriesga más que el saldo, aunque la tolerancia diga otra cosa", () => {
    const a = affordSpread(candidate(500), { accountSize: 1000, tolerancePct: 400 });
    expect(a.totalRisk).toBeLessThanOrEqual(1000);
  });

  it("un candidato bloqueado no se dimensiona", () => {
    const a = affordSpread(candidate(380, { blocked: true, metrics: null }), {
      accountSize: 100000, tolerancePct: 50,
    });
    expect(a.maxContracts).toBe(0);
    expect(a.blocked).toBe(true);
  });

  it("cuando no cabe, propone el ancho de ala que sí entraría", () => {
    // $100 de presupuesto contra un spread de $5 de ancho que arriesga $380:
    // proporcionalmente cabría alrededor de $1,30 → redondeado a $1,00.
    const a = affordSpread(candidate(380), { accountSize: 1000, tolerancePct: 10 });
    expect(a.suggestedWidth).not.toBeNull();
    expect(a.suggestedWidth!).toBeLessThan(5);
    expect(a.suggestedWidth!).toBeGreaterThan(0);
  });

  it("no propone ancho cuando ya cabe", () => {
    const a = affordSpread(candidate(380), { accountSize: 10000, tolerancePct: 20 });
    expect(a.suggestedWidth).toBeNull();
  });

  it("aguanta entradas basura de la UI sin devolver NaN", () => {
    for (const perfil of [
      { accountSize: 0, tolerancePct: 10 },
      { accountSize: NaN, tolerancePct: 10 },
      { accountSize: 1000, tolerancePct: -5 },
      { accountSize: Infinity, tolerancePct: 10 },
    ]) {
      const a = affordSpread(candidate(380), perfil);
      expect(Number.isFinite(a.maxContracts)).toBe(true);
      expect(a.maxContracts).toBeGreaterThanOrEqual(0);
    }
  });

  it("un spread estrecho cabe donde uno ancho no", () => {
    const perfil = { accountSize: 2000, tolerancePct: 10 }; // $200
    expect(affordSpread(candidate(380), perfil).maxContracts).toBe(0);
    expect(affordSpread(candidate(90), perfil).maxContracts).toBe(2);
  });
});

describe("sortByAffordThenScore", () => {
  it("lo que cabe va primero aunque puntúe menos", () => {
    const caro = candidate(5000, { score: { total: 95 } as never });
    const barato = candidate(100, { score: { total: 40 } as never });
    const out = sortByAffordThenScore([caro, barato], { accountSize: 1000, tolerancePct: 20 });
    expect(out[0].metrics!.maxLoss).toBe(100);
    expect(out[0].afford.maxContracts).toBeGreaterThan(0);
  });

  it("entre los que caben, gana el score", () => {
    const bueno = candidate(100, { score: { total: 90 } as never });
    const malo = candidate(100, { score: { total: 30 } as never });
    const out = sortByAffordThenScore([malo, bueno], { accountSize: 10000, tolerancePct: 20 });
    expect(out[0].score!.total).toBe(90);
  });

  it("los bloqueados siempre al final", () => {
    const out = sortByAffordThenScore(
      [candidate(100, { blocked: true, metrics: null }), candidate(100)],
      { accountSize: 10000, tolerancePct: 20 },
    );
    expect(out[0].blocked).toBe(false);
    expect(out[1].blocked).toBe(true);
  });
});
