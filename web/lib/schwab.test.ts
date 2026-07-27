import { describe, it, expect } from "vitest";
import { toRawContract } from "./schwab";
import { toRow } from "./compute";

// Contrato real devuelto por Schwab para NVDA el 2026-07-27. Se guarda tal cual
// (con el relleno de espacios del símbolo y la IV en porcentaje) porque el valor
// de este fixture está justamente en NO limpiarlo a mano.
const CONTRATO_REAL = {
  putCall: "CALL",
  symbol: "NVDA  260727C00197500",
  bid: 0.45,
  ask: 0.47,
  last: 0.46,
  mark: 0.46,
  closePrice: 0.44,
  totalVolume: 266911,
  openInterest: 2656,
  volatility: 50.301,
  delta: 0.559,
  gamma: 0.396,
  theta: -0.344,
  vega: 0.008,
  rho: 0,
  strikePrice: 197.5,
  expirationDate: "2026-07-27T20:00:00.000+00:00",
  multiplier: 100,
};

describe("toRawContract — traducción Schwab → motor", () => {
  it("convierte la IV de porcentaje a decimal", () => {
    // La trampa: ivcontext.ts multiplica por 100 lo que recibe. Entregar 50.301
    // en crudo daría 5030%. Debe llegar como 0.503.
    const raw = toRawContract(CONTRATO_REAL, "NVDA", 197.61);
    expect(raw.implied_volatility).toBeCloseTo(0.50301, 5);
  });

  it("recorta el datetime de vencimiento a fecha suelta", () => {
    const raw = toRawContract(CONTRATO_REAL, "NVDA", 197.61);
    expect(raw.details?.expiration_date).toBe("2026-07-27");
  });

  it("normaliza el tipo a minúsculas, como espera normalizeType", () => {
    const raw = toRawContract(CONTRATO_REAL, "NVDA", 197.61);
    expect(raw.details?.contract_type).toBe("call");
  });

  it("colapsa el relleno de espacios del símbolo OCC", () => {
    const raw = toRawContract(CONTRATO_REAL, "NVDA", 197.61);
    expect(raw.details?.ticker).toBe("NVDA 260727C00197500");
  });

  it("traslada los griegos que Massive nunca da", () => {
    const raw = toRawContract(CONTRATO_REAL, "NVDA", 197.61);
    expect(raw.greeks?.gamma).toBe(0.396);
    expect(raw.greeks?.delta).toBe(0.559);
    expect(raw.greeks?.theta).toBe(-0.344);
  });

  it("sobrevive a un contrato sin griegos ni IV (forma de Massive)", () => {
    const raw = toRawContract(
      { putCall: "PUT", strikePrice: 100, expirationDate: "2026-08-21T20:00:00.000+00:00" },
      "AAPL",
      200,
    );
    expect(raw.implied_volatility).toBeUndefined();
    expect(raw.greeks?.gamma).toBeUndefined();
    expect(raw.details?.contract_type).toBe("put");
    expect(raw.details?.shares_per_contract).toBe(100); // cae al default
  });

  it("produce una Row válida al pasar por toRow, igual que un contrato de Massive", () => {
    // La prueba que importa: que el motor existente lo digiera sin cambios.
    const row = toRow(toRawContract(CONTRATO_REAL, "NVDA", 197.61));
    expect(row.strike).toBe(197.5);
    expect(row.openInterest).toBe(2656);
    expect(row.volume).toBe(266911);
    expect(row.contractType).toBe("call");
    expect(row.expiration).toBe("2026-07-27");
    // Notional = OI × 100 × strike
    expect(row.notionalValue).toBeCloseTo(2656 * 100 * 197.5, 2);
  });
});
