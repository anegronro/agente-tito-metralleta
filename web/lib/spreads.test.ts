import { describe, expect, it } from "vitest";
import {
  SPREAD_PRESETS,
  WEIGHTS,
  alignmentPart,
  atmIvByExpiry,
  buildSpreads,
  condorMetrics,
  familyOf,
  fillPrice,
  legBlock,
  netPrice,
  scoreSpread,
  toLeg,
  topPerKind,
  verticalMetrics,
  type Leg,
  type SpreadQuote,
} from "./spreads";
import type { DirectionalContext } from "./directional";

/** Fila de cadena con valores sanos por defecto; se sobreescribe lo que interese. */
function quote(over: Partial<SpreadQuote> & Pick<SpreadQuote, "type" | "strike">): SpreadQuote {
  return {
    expiration: "2026-09-18",
    dte: 40,
    bid: 1,
    ask: 1.1,
    openInterest: 1000,
    volume: 1000,
    delta: 0.2,
    iv: 0.35,
    ...over,
  };
}

function leg(action: Leg["action"], type: Leg["type"], strike: number, price: number): Leg {
  return { action, type, strike, price, delta: -0.2, openInterest: 1000, volume: 1000, spreadPct: 5 };
}

describe("presets", () => {
  it("van de menos a más delta en la pata vendida", () => {
    expect(SPREAD_PRESETS.conservador.shortDeltaMax).toBeLessThanOrEqual(SPREAD_PRESETS.balanceado.shortDeltaMin);
    expect(SPREAD_PRESETS.balanceado.shortDeltaMax).toBeLessThanOrEqual(SPREAD_PRESETS.agresivo.shortDeltaMin);
  });

  it("el ancho máximo crece con la agresividad", () => {
    expect(SPREAD_PRESETS.conservador.maxWidth).toBeLessThan(SPREAD_PRESETS.balanceado.maxWidth);
    expect(SPREAD_PRESETS.balanceado.maxWidth).toBeLessThan(SPREAD_PRESETS.agresivo.maxWidth);
  });

  it("el 0DTE queda FUERA de la escala: es otro instrumento, no 'más agresivo'", () => {
    const z = SPREAD_PRESETS["0dte"];
    expect(z.zeroDte).toBe(true);
    expect(z.dteMin).toBe(0);
    expect(z.dteMax).toBe(0);
    // Vende MÁS LEJOS del dinero que el conservador: en las últimas horas el
    // delta deja de ser una probabilidad estable.
    expect(z.shortDeltaMax).toBeLessThan(SPREAD_PRESETS.conservador.shortDeltaMax);
    // Y trae aviso obligatorio.
    expect(z.warning).toBeTruthy();
  });

  it("solo el 0DTE apaga el anualizado", () => {
    for (const p of Object.values(SPREAD_PRESETS)) {
      if (p.id !== "0dte") expect(p.zeroDte).toBeUndefined();
    }
  });

  it("la pata COMPRADA va al revés: baja de delta al subir la agresividad", () => {
    expect(SPREAD_PRESETS.agresivo.longDeltaMax).toBeLessThanOrEqual(SPREAD_PRESETS.balanceado.longDeltaMin);
    expect(SPREAD_PRESETS.balanceado.longDeltaMax).toBeLessThanOrEqual(SPREAD_PRESETS.conservador.longDeltaMin);
  });
});

describe("familyOf", () => {
  it("separa crédito de débito", () => {
    expect(familyOf("put_credit")).toBe("credito");
    expect(familyOf("call_credit")).toBe("credito");
    expect(familyOf("iron_condor")).toBe("credito");
    expect(familyOf("put_debit")).toBe("debito");
    expect(familyOf("call_debit")).toBe("debito");
  });
});

describe("relleno pesimista", () => {
  it("vender toma el bid y comprar el ask", () => {
    const q = quote({ type: "put", strike: 100, bid: 2, ask: 2.4 });
    expect(fillPrice(q, "vender")).toBe(2);
    expect(fillPrice(q, "comprar")).toBe(2.4);
  });

  it("sin bid no se puede vender", () => {
    expect(fillPrice(quote({ type: "put", strike: 100, bid: null }), "vender")).toBeNull();
    expect(toLeg(quote({ type: "put", strike: 100, bid: 0 }), "vender")).toBeNull();
  });

  it("el neto cruza las dos horquillas: nunca sale mejor que con el mid", () => {
    const legs = [leg("vender", "put", 100, 2.0), leg("comprar", "put", 95, 0.8)];
    // Con mid (2.2 y 1.0) el crédito parecería 1.20; el real es 1.20 con bid/ask
    // pesimista solo si se toman los peores lados — aquí 2.0 − 0.8 = 1.20.
    expect(netPrice(legs)).toBeCloseTo(1.2, 10);
    // Positivo = cobras.
    expect(netPrice(legs)).toBeGreaterThan(0);
  });

  it("el débito sale negativo", () => {
    const legs = [leg("comprar", "call", 100, 5), leg("vender", "call", 105, 2)];
    expect(netPrice(legs)).toBeCloseTo(-3, 10);
  });
});

describe("legBlock — manda la peor pata", () => {
  it("una pata ilíquida bloquea el spread entero", () => {
    const buena = quote({ type: "put", strike: 100, openInterest: 5000 });
    const mala = quote({ type: "put", strike: 95, openInterest: 3 });
    expect(legBlock([buena])).toBeNull();
    expect(legBlock([buena, mala])).toBe("oi_bajo");
  });

  it("detecta la horquilla ancha", () => {
    const ancha = quote({ type: "put", strike: 95, bid: 0.5, ask: 2 });
    expect(legBlock([ancha])).toBe("spread_ancho");
  });

  it("sin bid no hay spread", () => {
    expect(legBlock([quote({ type: "put", strike: 95, bid: null })])).toBe("sin_bid");
  });
});

describe("verticalMetrics — put credit spread", () => {
  // Vendes el 100, compras el 95, cobras $1.20. Ancho $5.
  const legs = [leg("vender", "put", 100, 2.0), leg("comprar", "put", 95, 0.8)];
  const m = verticalMetrics({ kind: "put_credit", legs, spot: 110, dte: 40, iv: 0.35 })!;

  it("la pérdida máxima es el ancho menos el crédito", () => {
    expect(m.width).toBe(5);
    expect(m.credit).toBeCloseTo(120, 6);
    expect(m.maxProfit).toBeCloseTo(120, 6);
    expect(m.maxLoss).toBeCloseTo(380, 6); // (5 − 1.20) × 100
  });

  it("el colateral es MUCHÍSIMO menor que el del put desnudo", () => {
    // Ese es el motivo de todo el archivo: 380 frente a 100 × 100 = 10.000.
    expect(m.maxLoss).toBeLessThan(100 * 100 * 0.05);
  });

  it("el breakeven queda por debajo del strike vendido", () => {
    expect(m.breakevens).toEqual([98.8]);
  });

  it("ganas si el precio NO baja del breakeven", () => {
    // Spot 110 muy por encima de 98.8 → alta probabilidad.
    expect(m.pop).toBeGreaterThan(60);
  });

  it("el retorno sobre riesgo se anualiza", () => {
    expect(m.returnOnRisk).toBeCloseTo((120 / 380) * 100, 6);
    expect(m.annualizedPct).toBeCloseTo(m.returnOnRisk * (365 / 40), 6);
  });
});

describe("verticalMetrics — call credit spread", () => {
  const legs = [leg("vender", "call", 120, 2.0), leg("comprar", "call", 125, 0.8)];
  const m = verticalMetrics({ kind: "call_credit", legs, spot: 110, dte: 40, iv: 0.35 })!;

  it("el breakeven queda por ENCIMA del strike vendido", () => {
    expect(m.breakevens).toEqual([121.2]);
    expect(m.maxLoss).toBeCloseTo(380, 6);
  });

  it("ganas si el precio NO sube del breakeven", () => {
    expect(m.pop).toBeGreaterThan(60);
  });
});

describe("verticalMetrics — débito", () => {
  // Compras el 110 y vendes el 115 pagando $2. Ancho $5.
  const legs = [leg("comprar", "call", 110, 5.0), leg("vender", "call", 115, 3.0)];
  const m = verticalMetrics({ kind: "call_debit", legs, spot: 110, dte: 40, iv: 0.35 })!;

  it("la pérdida máxima es lo que pagas, y ni un dólar más", () => {
    expect(m.debit).toBeCloseTo(200, 6);
    expect(m.maxLoss).toBeCloseTo(200, 6);
    expect(m.credit).toBe(0);
  });

  it("la ganancia máxima es el ancho menos lo pagado", () => {
    expect(m.maxProfit).toBeCloseTo(300, 6);
  });

  it("el breakeven está por encima del strike comprado", () => {
    expect(m.breakevens).toEqual([112]);
  });

  it("un débito bajista invierte el breakeven", () => {
    const bajista = [leg("comprar", "put", 110, 5.0), leg("vender", "put", 105, 3.0)];
    const p = verticalMetrics({ kind: "put_debit", legs: bajista, spot: 110, dte: 40, iv: 0.35 })!;
    expect(p.breakevens).toEqual([108]);
    expect(p.maxLoss).toBeCloseTo(200, 6);
  });
});

describe("verticalMetrics — datos imposibles", () => {
  it("rechaza un crédito que iguala o supera el ancho", () => {
    const legs = [leg("vender", "put", 100, 6), leg("comprar", "put", 95, 0.5)];
    expect(verticalMetrics({ kind: "put_credit", legs, spot: 110, dte: 40, iv: 0.35 })).toBeNull();
  });

  it("rechaza un débito que supera el ancho: no podría ganar ni acertando", () => {
    const legs = [leg("comprar", "call", 110, 9), leg("vender", "call", 115, 1)];
    expect(verticalMetrics({ kind: "call_debit", legs, spot: 110, dte: 40, iv: 0.35 })).toBeNull();
  });

  it("rechaza un 'crédito' que en realidad se paga", () => {
    const legs = [leg("vender", "put", 100, 0.5), leg("comprar", "put", 95, 0.9)];
    expect(verticalMetrics({ kind: "put_credit", legs, spot: 110, dte: 40, iv: 0.35 })).toBeNull();
  });

  it("rechaza un ancho de cero", () => {
    const legs = [leg("vender", "put", 100, 2), leg("comprar", "put", 100, 1)];
    expect(verticalMetrics({ kind: "put_credit", legs, spot: 110, dte: 40, iv: 0.35 })).toBeNull();
  });
});

describe("condorMetrics", () => {
  const putLegs = [leg("vender", "put", 100, 2.0), leg("comprar", "put", 95, 0.8)];
  const callLegs = [leg("vender", "call", 120, 1.8), leg("comprar", "call", 125, 0.6)];
  const m = condorMetrics({ putLegs, callLegs, spot: 110, dte: 40, iv: 0.35 })!;

  it("cobra las dos alas", () => {
    expect(m.credit).toBeCloseTo(240, 6); // (1.20 + 1.20) × 100
  });

  it("EL COLATERAL ES UN ALA, NO LAS DOS", () => {
    // Al vencimiento el precio no puede estar a la vez sobre 120 y bajo 100.
    expect(m.width).toBe(5);
    expect(m.maxLoss).toBeCloseTo(260, 6); // (5 − 2.40) × 100
    // Si se sumaran las dos alas saldría ~760: casi el triple de lo real.
    expect(m.maxLoss).toBeLessThan(500);
  });

  it("tiene dos breakevens y ganas entre ellos", () => {
    expect(m.breakevens).toEqual([97.6, 122.4]);
    expect(m.pop).toBeGreaterThan(0);
    expect(m.pop).toBeLessThan(100);
  });

  it("un condor cobra más que cualquiera de sus alas sueltas", () => {
    const ala = verticalMetrics({ kind: "put_credit", legs: putLegs, spot: 110, dte: 40, iv: 0.35 })!;
    expect(m.credit).toBeGreaterThan(ala.credit);
  });

  it("rechaza cuando el crédito supera el ancho", () => {
    const gordas = [leg("vender", "put", 100, 4), leg("comprar", "put", 95, 0.1)];
    const gordas2 = [leg("vender", "call", 120, 4), leg("comprar", "call", 125, 0.1)];
    expect(condorMetrics({ putLegs: gordas, callLegs: gordas2, spot: 110, dte: 40, iv: 0.35 })).toBeNull();
  });
});

describe("scoreSpread", () => {
  const legs = [leg("vender", "put", 100, 2.0), leg("comprar", "put", 95, 0.8)];
  const m = verticalMetrics({ kind: "put_credit", legs, spot: 110, dte: 40, iv: 0.35 })!;

  it("suma como mucho 100 y el total es la suma de sus partes", () => {
    const s = scoreSpread({ kind: "put_credit", metrics: m, legs, ivRank: 80, earnings: "fuera" });
    expect(s.total).toBeLessThanOrEqual(100);
    expect(s.total).toBe(
      s.reward.points + s.pop.points + s.liquidity.points +
      s.ivFit.points + s.earnings.points + s.alignment.points,
    );
  });

  it("los pesos declarados suman exactamente 100", () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("ningún componente puede pasarse de su peso", () => {
    // El rescalado proyecta cada banda a su peso: si una `*Part` devolviera más
    // puntos que su propio `max`, el total se saldría de 100 sin avisar.
    for (const ivRank of [null, 10, 55, 90]) {
      for (const earnings of ["fuera", "dentro", "dentro_confirmado", "no_aplica"] as const) {
        const s = scoreSpread({ kind: "put_credit", metrics: m, legs, ivRank, earnings });
        expect(s.reward.points).toBeLessThanOrEqual(WEIGHTS.reward);
        expect(s.pop.points).toBeLessThanOrEqual(WEIGHTS.pop);
        expect(s.liquidity.points).toBeLessThanOrEqual(WEIGHTS.liquidity);
        expect(s.ivFit.points).toBeLessThanOrEqual(WEIGHTS.ivFit);
        expect(s.earnings.points).toBeLessThanOrEqual(WEIGHTS.earnings);
        expect(s.alignment.points).toBeLessThanOrEqual(WEIGHTS.alignment);
        expect(s.total).toBeLessThanOrEqual(100);
      }
    }
  });

  it("sin contexto NO se cae: puntúa como neutral", () => {
    const s = scoreSpread({ kind: "call_debit", metrics: m, legs, ivRank: 50, earnings: "fuera" });
    expect(s.alignment.points).toBeGreaterThan(0);
    expect(Number.isFinite(s.total)).toBe(true);
  });
});

describe("alignmentPart — el contexto direccional", () => {
  const legs = [leg("vender", "put", 100, 2.0), leg("comprar", "put", 95, 0.8)];
  const m = verticalMetrics({ kind: "put_credit", legs, spot: 110, dte: 40, iv: 0.35 })!;
  const debLegs = [leg("comprar", "call", 110, 5), leg("vender", "call", 115, 3)];
  const dm = verticalMetrics({ kind: "call_debit", legs: debLegs, spot: 110, dte: 40, iv: 0.35 })!;

  /** Contexto sintético con el sesgo y la fuerza que se pidan. */
  function ctx(bias: "bullish" | "bearish" | "neutral", strength = 60): DirectionalContext {
    return {
      bias, strength,
      score: bias === "bullish" ? strength : bias === "bearish" ? -strength : 0,
      magnet: null, votes: [],
    };
  }

  const base = { spot: 110, supports: [], resistances: [] };

  it("premia al crédito que apuesta CON el contexto", () => {
    const aFavor = alignmentPart({ kind: "put_credit", legs, metrics: m, ctx: ctx("bullish"), ...base });
    const enContra = alignmentPart({ kind: "put_credit", legs, metrics: m, ctx: ctx("bearish"), ...base });
    expect(aFavor.points).toBeGreaterThan(enContra.points);
  });

  it("un DÉBITO contra el contexto se lleva el castigo máximo", () => {
    // Pagar por un movimiento que las tres fuentes dicen que no va a pasar es
    // lo más caro que se puede hacer: peor que un crédito mal orientado.
    //
    // Se compara la CAÍDA respecto a neutral dentro de cada estructura, no el
    // total entre las dos: el crédito se juzga por dónde cae su strike
    // (`checkLevel`) y el débito por si el camino está libre (`checkPath`), así
    // que sus mitades de nivel no son comparables entre sí y taparían el efecto.
    const caida = (kind: "call_debit" | "put_credit", ls: Leg[], mm: typeof m) =>
      alignmentPart({ kind, legs: ls, metrics: mm, ctx: ctx("neutral", 0), ...base }).points -
      alignmentPart({ kind, legs: ls, metrics: mm, ctx: ctx("bearish", 60), ...base }).points;

    expect(caida("call_debit", debLegs, dm)).toBeGreaterThan(caida("put_credit", legs, m));
  });

  it("EL CONDOR SE PUNTÚA AL REVÉS: la convicción es su enemiga", () => {
    const cLegs = [...legs, leg("vender", "call", 120, 1.8), leg("comprar", "call", 125, 0.6)];
    const cm = condorMetrics({
      putLegs: legs, callLegs: [leg("vender", "call", 120, 1.8), leg("comprar", "call", 125, 0.6)],
      spot: 110, dte: 40, iv: 0.35,
    })!;
    const quieto = alignmentPart({ kind: "iron_condor", legs: cLegs, metrics: cm, ctx: ctx("neutral", 5), ...base });
    const movido = alignmentPart({ kind: "iron_condor", legs: cLegs, metrics: cm, ctx: ctx("bullish", 70), ...base });
    expect(quieto.points).toBeGreaterThan(movido.points);
  });

  it("un contexto neutral no castiga a las direccionales, solo deja de premiar", () => {
    const neutral = alignmentPart({ kind: "put_credit", legs, metrics: m, ctx: ctx("neutral", 0), ...base });
    const contra = alignmentPart({ kind: "put_credit", legs, metrics: m, ctx: ctx("bearish", 60), ...base });
    const favor = alignmentPart({ kind: "put_credit", legs, metrics: m, ctx: ctx("bullish", 60), ...base });
    expect(neutral.points).toBeGreaterThan(contra.points);
    expect(neutral.points).toBeLessThan(favor.points);
  });

  it("un soporte fuerte por encima del put vendido suma", () => {
    const soporte = [{ price: 104, kind: "support", strength: 70, distancePct: 5, sources: {} , flipped: false, why: "" }] as never;
    const con = alignmentPart({ kind: "put_credit", legs, metrics: m, ctx: ctx("neutral", 0), spot: 110, supports: soporte, resistances: [] });
    const sin = alignmentPart({ kind: "put_credit", legs, metrics: m, ctx: ctx("neutral", 0), ...base });
    expect(con.points).toBeGreaterThan(sin.points);
  });

  it("LA IV SE PUNTÚA AL REVÉS según vendas o compres prima", () => {
    const caro = { ivRank: 85, earnings: "fuera" as const };
    const barato = { ivRank: 15, earnings: "fuera" as const };
    const credCara = scoreSpread({ kind: "put_credit", metrics: m, legs, ...caro }).ivFit.points;
    const credBarata = scoreSpread({ kind: "put_credit", metrics: m, legs, ...barato }).ivFit.points;
    expect(credCara).toBeGreaterThan(credBarata);

    const debLegs = [leg("comprar", "call", 110, 5), leg("vender", "call", 115, 3)];
    const dm = verticalMetrics({ kind: "call_debit", legs: debLegs, spot: 110, dte: 40, iv: 0.35 })!;
    const debCara = scoreSpread({ kind: "call_debit", metrics: dm, legs: debLegs, ...caro }).ivFit.points;
    const debBarata = scoreSpread({ kind: "call_debit", metrics: dm, legs: debLegs, ...barato }).ivFit.points;
    expect(debBarata).toBeGreaterThan(debCara);
  });

  it("castiga la liquidez por la PEOR pata", () => {
    const cojo: Leg[] = [
      { ...leg("vender", "put", 100, 2), openInterest: 5000, spreadPct: 2 },
      { ...leg("comprar", "put", 95, 0.8), openInterest: 20, spreadPct: 60 },
    ];
    const s = scoreSpread({ kind: "put_credit", metrics: m, legs: cojo, ivRank: 60, earnings: "fuera" });
    expect(s.liquidity.points).toBe(0);
  });

  it("el reporte dentro del vencimiento pesa menos en un débito", () => {
    const debLegs = [leg("comprar", "call", 110, 5), leg("vender", "call", 115, 3)];
    const dm = verticalMetrics({ kind: "call_debit", legs: debLegs, spot: 110, dte: 40, iv: 0.35 })!;
    const cred = scoreSpread({ kind: "put_credit", metrics: m, legs, ivRank: 60, earnings: "dentro" }).earnings.points;
    const deb = scoreSpread({ kind: "call_debit", metrics: dm, legs: debLegs, ivRank: 60, earnings: "dentro" }).earnings.points;
    expect(deb).toBeGreaterThan(cred);
  });
});

describe("atmIvByExpiry", () => {
  it("coge la IV del strike más cercano al spot, no la del ala", () => {
    const quotes = [
      quote({ type: "put", strike: 80, iv: 0.9 }),   // ala lejana, IV inflada por skew
      quote({ type: "put", strike: 110, iv: 0.30 }), // ATM
      quote({ type: "call", strike: 140, iv: 0.5 }),
    ];
    expect(atmIvByExpiry(quotes, 110).get("2026-09-18")).toBe(0.30);
  });

  it("ignora las filas sin IV", () => {
    const quotes = [quote({ type: "put", strike: 110, iv: null }), quote({ type: "put", strike: 90, iv: 0.4 })];
    expect(atmIvByExpiry(quotes, 110).get("2026-09-18")).toBe(0.4);
  });
});

describe("buildSpreads", () => {
  /**
   * Cadena sintética alrededor de $110, strikes de $2,50.
   *
   * OJO CON LOS SIGNOS, que ya me colaron un test verde por el motivo
   * equivocado: el |delta| del PUT baja según el strike baja (más fuera del
   * dinero) y el del CALL baja según el strike sube. Con las pendientes al
   * revés el builder montaba "put credit spreads" con el corto POR ENCIMA del
   * precio, que es una estructura sin sentido, y aun así pasaba.
   *
   * El paso de $2,50 tampoco es cosmético: con strikes de $5 sobre un
   * subyacente de $110 ningún contrato caía dentro de la banda 0,15-0,28 y no
   * se llegaba a montar un solo condor.
   */
  function cadena(): SpreadQuote[] {
    const out: SpreadQuote[] = [];
    const clamp = (d: number) => Math.max(0.02, Math.min(0.95, d));
    for (let k = 85; k <= 135; k += 2.5) {
      const dist = (k - 110) / 110;
      out.push(quote({
        type: "put", strike: k,
        delta: -clamp(0.5 + dist * 4),
        bid: Math.max(0.05, 3 + dist * 20), ask: Math.max(0.1, 3.2 + dist * 20),
      }));
      out.push(quote({
        type: "call", strike: k,
        delta: clamp(0.5 - dist * 4),
        bid: Math.max(0.05, 3 - dist * 20), ask: Math.max(0.1, 3.2 - dist * 20),
      }));
    }
    return out;
  }

  const base = {
    ticker: "TEST", spot: 110, quotes: cadena(),
    preset: SPREAD_PRESETS.balanceado, ivRank: 60,
    earnings: "fuera" as const, fallbackIv: 0.35,
  };

  it("produce candidatos y ninguno pierde más que el ancho", () => {
    const out = buildSpreads(base);
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      if (!c.metrics) continue;
      expect(c.metrics.maxLoss).toBeLessThanOrEqual(c.metrics.width * 100 + 1e-6);
      expect(c.metrics.maxLoss).toBeGreaterThan(0);
    }
  });

  it("las estructuras salen del lado correcto del precio", () => {
    // Lo que el delta invertido escondía: un put credit spread vende POR
    // DEBAJO del precio y un call credit spread POR ENCIMA. Al revés no es un
    // spread caro, es una posición que nace perdiendo.
    for (const c of buildSpreads(base)) {
      const vendido = c.legs.find((l) => l.action === "vender");
      if (!vendido || c.kind === "iron_condor") continue;
      if (c.kind === "put_credit") expect(vendido.strike).toBeLessThan(base.spot);
      if (c.kind === "call_credit") expect(vendido.strike).toBeGreaterThan(base.spot);
    }
  });

  it("en un spread el largo protege: siempre más lejos del dinero que el corto", () => {
    for (const c of buildSpreads(base)) {
      if (c.kind === "iron_condor" || familyOf(c.kind) !== "credito") continue;
      const vendido = c.legs.find((l) => l.action === "vender")!;
      const comprado = c.legs.find((l) => l.action === "comprar")!;
      if (c.legs[0].type === "put") expect(comprado.strike).toBeLessThan(vendido.strike);
      else expect(comprado.strike).toBeGreaterThan(vendido.strike);
    }
  });

  it("respeta el ancho máximo del preset", () => {
    for (const c of buildSpreads(base)) {
      if (c.metrics) expect(c.metrics.width).toBeLessThanOrEqual(SPREAD_PRESETS.balanceado.maxWidth);
    }
  });

  it("respeta la ventana de vencimiento", () => {
    const fuera = buildSpreads({ ...base, quotes: cadena().map((q) => ({ ...q, dte: 200 })) });
    expect(fuera).toHaveLength(0);
  });

  it("cada estructura lleva sus dos patas, y el condor cuatro", () => {
    for (const c of buildSpreads(base)) {
      expect(c.legs).toHaveLength(c.kind === "iron_condor" ? 4 : 2);
    }
  });

  it("el condor vende dentro y compra fuera", () => {
    const condor = buildSpreads(base).find((c) => c.kind === "iron_condor");
    expect(condor).toBeDefined();
    const vendidos = condor!.legs.filter((l) => l.action === "vender").map((l) => l.strike);
    const comprados = condor!.legs.filter((l) => l.action === "comprar").map((l) => l.strike);
    expect(vendidos).toHaveLength(2);
    expect(comprados).toHaveLength(2);
    // El put comprado va por debajo del vendido y el call comprado por encima.
    expect(Math.min(...comprados)).toBeLessThan(Math.min(...vendidos));
    expect(Math.max(...comprados)).toBeGreaterThan(Math.max(...vendidos));
  });

  it("no inventa delta: sin griegos no monta nada", () => {
    const sinDelta = cadena().map((q) => ({ ...q, delta: null }));
    expect(buildSpreads({ ...base, quotes: sinDelta })).toHaveLength(0);
  });

  it("limita cuántos deja por estructura", () => {
    const out = buildSpreads({ ...base, perKind: 1 });
    const porTipo = new Map<string, number>();
    for (const c of out) porTipo.set(c.kind, (porTipo.get(c.kind) ?? 0) + 1);
    for (const n of porTipo.values()) expect(n).toBeLessThanOrEqual(1);
  });

  it("ordena los operables primero", () => {
    const out = buildSpreads(base);
    const primerBloqueado = out.findIndex((c) => c.blocked);
    if (primerBloqueado >= 0) {
      expect(out.slice(primerBloqueado).every((c) => c.blocked)).toBe(true);
    }
  });
});

describe("topPerKind", () => {
  it("los bloqueados van detrás aunque tengan hueco", () => {
    const fake = (kind: "put_credit", total: number, blocked: boolean) => ({
      ticker: "T", kind, label: "", thesis: "", expiration: "2026-09-18", dte: 40,
      spot: 100, legs: [], metrics: null,
      score: blocked ? null : ({ total } as never),
      blocked, blockReason: null, strikesLabel: "",
    });
    const out = topPerKind(
      [fake("put_credit", 0, true), fake("put_credit", 50, false)] as never,
      5,
    );
    expect(out[0].blocked).toBe(false);
  });
});
