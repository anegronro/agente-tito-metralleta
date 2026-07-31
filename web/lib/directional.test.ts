import { describe, expect, it } from "vitest";
import {
  NEUTRAL,
  SOURCE_WEIGHT,
  STRONG_LEVEL,
  aggressiveBullishPctByTicker,
  callPremiumPctByTicker,
  checkLevel,
  checkPath,
  combineBias,
  flowVote,
  gexVote,
  newsVote,
  zeroDteFlowVote,
} from "./directional";
import type { Level } from "./levels";
import type { NewsBias } from "./news";

function level(price: number, kind: Level["kind"], strength: number): Level {
  return {
    price, kind, strength, distancePct: 0,
    sources: { touches: 0, oi: 0, flowPremium: 0, gex: 0, confluence: false } as never,
    flipped: false, why: "",
  };
}

describe("gexVote", () => {
  it("un imán por encima del precio vota alcista", () => {
    const v = gexVote(103, 100)!;
    expect(v.value).toBeGreaterThan(0);
    expect(v.source).toBe("gex");
  });

  it("un imán por debajo vota bajista", () => {
    expect(gexVote(97, 100)!.value).toBeLessThan(0);
  });

  it("satura en ±1: un imán al 3% ya es voto pleno", () => {
    expect(gexVote(103, 100)!.value).toBeCloseTo(1, 6);
    expect(gexVote(130, 100)!.value).toBe(1);
    expect(gexVote(70, 100)!.value).toBe(-1);
  });

  it("sin imán no hay voto", () => {
    expect(gexVote(null, 100)).toBeNull();
    expect(gexVote(103, 0)).toBeNull();
  });
});

describe("flowVote", () => {
  it("50% de calls es empate", () => {
    expect(flowVote(50)!.value).toBe(0);
  });

  it("70/30 es voto pleno en cada sentido", () => {
    expect(flowVote(70)!.value).toBeCloseTo(1, 6);
    expect(flowVote(30)!.value).toBeCloseTo(-1, 6);
    expect(flowVote(95)!.value).toBe(1);
  });

  it("sin dato no hay voto", () => {
    expect(flowVote(null)).toBeNull();
    expect(flowVote(NaN)).toBeNull();
  });
});

describe("newsVote", () => {
  const bias = (score: number, b: NewsBias["bias"]): NewsBias =>
    ({ bias: b, score, positive: 1, negative: 0, neutral: 0 });

  it("traslada el score de las noticias", () => {
    expect(newsVote(bias(0.8, "bullish"))!.value).toBeCloseTo(0.8, 6);
    expect(newsVote(bias(-0.5, "bearish"))!.value).toBeCloseTo(-0.5, 6);
  });

  it("un tono neutral no vota", () => {
    expect(newsVote(bias(0.1, "neutral"))).toBeNull();
    expect(newsVote(null)).toBeNull();
  });
});

describe("combineBias", () => {
  it("sin votos devuelve neutral", () => {
    expect(combineBias([])).toEqual({ ...NEUTRAL, magnet: null });
    expect(combineBias([null, null]).bias).toBe("neutral");
  });

  it("NORMALIZA sobre las fuentes presentes, no sobre el total", () => {
    // Solo GEX, a tope. Si dividiera entre la suma de los tres pesos daría 45;
    // dividiendo entre los presentes da 100 — que es la convicción real.
    const solo = combineBias([gexVote(110, 100)]);
    expect(solo.score).toBeCloseTo(100, 6);
    expect(solo.bias).toBe("bullish");
  });

  it("el GEX pesa más que el flujo y este más que las noticias", () => {
    expect(SOURCE_WEIGHT.gex).toBeGreaterThan(SOURCE_WEIGHT.flujo);
    expect(SOURCE_WEIGHT.flujo).toBeGreaterThan(SOURCE_WEIGHT.noticias);
  });

  it("dos fuentes que se contradicen se anulan", () => {
    const c = combineBias([gexVote(110, 100), flowVote(30)]);
    expect(Math.abs(c.score)).toBeLessThan(50);
  });

  it("marca 'mixed' cuando las fuentes tiran a lados opuestos sin ganador", () => {
    // GEX alcista pleno (peso .45) contra flujo bajista pleno (peso .35):
    // el neto queda dentro de la banda muerta pero hay conflicto real.
    const c = combineBias([gexVote(103, 100), flowVote(32)]);
    expect(["mixed", "neutral"]).toContain(c.bias);
    expect(c.votes).toHaveLength(2);
  });

  it("un sesgo tibio NO se convierte en dirección", () => {
    // Umbral alto a propósito: un sesgo débil aplicado a un ranking hace más
    // daño que no tener sesgo.
    const c = combineBias([flowVote(53)]);
    expect(c.bias).toBe("neutral");
    expect(Math.abs(c.score)).toBeLessThan(20);
  });

  it("conserva el imán para poder enseñarlo", () => {
    expect(combineBias([gexVote(110, 100)], 110).magnet).toBe(110);
  });
});

describe("callPremiumPctByTicker", () => {
  it("pondera por DINERO, no por número de operaciones", () => {
    const rows = [
      { underlying: "AAA", type: "put" as const, premium: 1_000 },
      { underlying: "AAA", type: "put" as const, premium: 1_000 },
      { underlying: "AAA", type: "put" as const, premium: 1_000 },
      { underlying: "AAA", type: "call" as const, premium: 900_000 },
    ];
    // 3 puts contra 1 call, pero el dinero está casi todo en la call.
    expect(callPremiumPctByTicker(rows, 1000)!.get("AAA")!).toBeGreaterThan(99);
  });

  it("descarta los tickers con poco dinero total", () => {
    const rows = [{ underlying: "BBB", type: "call" as const, premium: 100 }];
    expect(callPremiumPctByTicker(rows, 250_000).has("BBB")).toBe(false);
  });

  it("ignora los contratos sin tipo reconocido", () => {
    const rows = [
      { underlying: "CCC", type: "unknown" as const, premium: 10_000_000 },
      { underlying: "CCC", type: "call" as const, premium: 500_000 },
    ];
    expect(callPremiumPctByTicker(rows, 1000).get("CCC")).toBe(100);
  });

  it("separa por ticker", () => {
    const rows = [
      { underlying: "AAA", type: "call" as const, premium: 500_000 },
      { underlying: "BBB", type: "put" as const, premium: 500_000 },
    ];
    const m = callPremiumPctByTicker(rows, 1000);
    expect(m.get("AAA")).toBe(100);
    expect(m.get("BBB")).toBe(0);
  });
});

describe("aggressiveBullishPctByTicker — EL LADO CAMBIA EL SIGNO", () => {
  const t = (type: "call" | "put", aggression: "ask" | "bid" | "mid", premium = 200_000) =>
    ({ underlying: "AAA", type, premium, aggression } as const);

  it("comprar calls es alcista y venderlas es bajista", () => {
    // Es la diferencia con `callPremiumPctByTicker`, que contaría las dos
    // como alcistas por ser calls.
    expect(aggressiveBullishPctByTicker([t("call", "ask")], 1000).get("AAA")).toBe(100);
    expect(aggressiveBullishPctByTicker([t("call", "bid")], 1000).get("AAA")).toBe(0);
  });

  it("los puts son el espejo: comprarlos es bajista y venderlos alcista", () => {
    expect(aggressiveBullishPctByTicker([t("put", "ask")], 1000).get("AAA")).toBe(0);
    expect(aggressiveBullishPctByTicker([t("put", "bid")], 1000).get("AAA")).toBe(100);
  });

  it("difiere de verdad del conteo por tipo", () => {
    // Todo son calls, así que `callPremiumPctByTicker` diría 100% alcista;
    // pero están VENDIDAS, o sea resistencia.
    const filas = [t("call", "bid"), t("call", "bid")];
    expect(callPremiumPctByTicker(filas, 1000).get("AAA")).toBe(100);
    expect(aggressiveBullishPctByTicker(filas, 1000).get("AAA")).toBe(0);
  });

  it("las ejecuciones al medio NO votan: no se sabe quién fue el agresor", () => {
    const m = aggressiveBullishPctByTicker([t("call", "mid"), t("put", "mid")], 1000);
    expect(m.has("AAA")).toBe(false);
  });

  it("pondera por dinero, no por número de operaciones", () => {
    const filas = [
      t("call", "bid", 10_000), t("call", "bid", 10_000), t("call", "bid", 10_000),
      t("call", "ask", 900_000),
    ];
    expect(aggressiveBullishPctByTicker(filas, 1000).get("AAA")!).toBeGreaterThan(95);
  });

  it("descarta tickers con poco dinero direccional", () => {
    expect(aggressiveBullishPctByTicker([t("call", "ask", 100)], 100_000).has("AAA")).toBe(false);
  });
});

describe("zeroDteFlowVote", () => {
  it("50% es empate y 70/30 son votos plenos", () => {
    expect(zeroDteFlowVote(50)!.value).toBe(0);
    expect(zeroDteFlowVote(70)!.value).toBeCloseTo(1, 6);
    expect(zeroDteFlowVote(30)!.value).toBeCloseTo(-1, 6);
  });

  it("pesa lo mismo que el flujo normal pero se explica distinto", () => {
    expect(zeroDteFlowVote(80)!.weight).toBe(flowVote(80)!.weight);
    expect(zeroDteFlowVote(80)!.why).not.toBe(flowVote(80)!.why);
    expect(zeroDteFlowVote(80)!.why).toMatch(/0DTE/);
  });

  it("sin dato no vota", () => {
    expect(zeroDteFlowVote(null)).toBeNull();
    expect(zeroDteFlowVote(NaN)).toBeNull();
  });
});

describe("checkLevel — protección de la pata vendida", () => {
  it("un put vendido bajo un soporte fuerte está protegido", () => {
    const r = checkLevel({
      shortStrike: 100, side: "put",
      supports: [level(105, "soporte", 70)], resistances: [],
    });
    expect(r.fit).toBe("protegido");
    expect(r.level!.price).toBe(105);
  });

  it("un soporte flojo no protege", () => {
    const r = checkLevel({
      shortStrike: 100, side: "put",
      supports: [level(105, "soporte", STRONG_LEVEL - 10)], resistances: [],
    });
    expect(r.fit).toBe("sin_nivel");
  });

  it("un soporte POR DEBAJO del strike no sirve de escudo", () => {
    // El precio llegaría a tu strike antes de tocarlo.
    const r = checkLevel({
      shortStrike: 100, side: "put",
      supports: [level(90, "soporte", 90)], resistances: [],
    });
    expect(r.fit).toBe("expuesto");
  });

  it("el call es el espejo: protege la resistencia POR DEBAJO del strike", () => {
    const protegido = checkLevel({
      shortStrike: 120, side: "call",
      supports: [], resistances: [level(115, "resistencia", 70)],
    });
    expect(protegido.fit).toBe("protegido");

    const expuesto = checkLevel({
      shortStrike: 120, side: "call",
      supports: [], resistances: [level(130, "resistencia", 90)],
    });
    expect(expuesto.fit).toBe("expuesto");
  });

  it("sin niveles, expuesto", () => {
    expect(checkLevel({ shortStrike: 100, side: "put", supports: [], resistances: [] }).fit).toBe("expuesto");
  });
});

describe("checkPath — el nivel que ESTORBA a un débito", () => {
  it("una resistencia fuerte en el camino frena la apuesta alcista", () => {
    const r = checkPath({
      spot: 100, target: 115,
      supports: [], resistances: [level(108, "resistencia", 70)],
    });
    expect(r.fit).toBe("expuesto");
  });

  it("una resistencia MÁS ALLÁ del objetivo no estorba", () => {
    const r = checkPath({
      spot: 100, target: 115,
      supports: [], resistances: [level(130, "resistencia", 90)],
    });
    expect(r.fit).toBe("protegido");
  });

  it("una resistencia por DETRÁS tampoco estorba", () => {
    const r = checkPath({
      spot: 100, target: 115,
      supports: [], resistances: [level(90, "resistencia", 90)],
    });
    expect(r.fit).toBe("protegido");
  });

  it("en un débito bajista lo que estorba son los SOPORTES", () => {
    const r = checkPath({
      spot: 100, target: 85,
      supports: [level(92, "soporte", 70)], resistances: [],
    });
    expect(r.fit).toBe("expuesto");
  });

  it("camino despejado", () => {
    expect(checkPath({ spot: 100, target: 115, supports: [], resistances: [] }).fit).toBe("protegido");
  });
});
