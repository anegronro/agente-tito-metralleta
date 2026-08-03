import { describe, expect, it } from "vitest";
import { probAbove } from "./expectedMove";
import {
  MAX_ZERO_DTE_SPREAD_PCT,
  ZERO_DTE_TOP_N,
  topByVolume,
  MIN_ZERO_DTE_VOLUME,
  fractionalDte,
  hoursToClose,
  marketHour,
  zeroDteLiquidityBlock,
  zeroDteWindow,
} from "./zeroDte";

/** Una hora concreta de Nueva York, sin pelearse con el horario de verano. */
function et(hhmm: string, fecha = "2026-07-29"): Date {
  // Julio → EDT (UTC−4).
  return new Date(`${fecha}T${hhmm}:00-04:00`);
}

describe("marketHour", () => {
  it("lee la hora en Nueva York, no en UTC", () => {
    expect(marketHour(et("09:30"))).toBeCloseTo(9.5, 5);
    expect(marketHour(et("16:00"))).toBeCloseTo(16, 5);
    expect(marketHour(et("13:45"))).toBeCloseTo(13.75, 5);
  });

  it("no se rompe a medianoche", () => {
    expect(marketHour(et("00:00"))).toBeGreaterThanOrEqual(0);
    expect(marketHour(et("00:00"))).toBeLessThan(24);
  });
});

describe("hoursToClose", () => {
  it("da la sesión entera antes de abrir", () => {
    expect(hoursToClose(et("08:00"))).toBeCloseTo(6.5, 5);
  });

  it("descuenta según avanza el día", () => {
    expect(hoursToClose(et("10:00"))).toBeCloseTo(6, 5);
    expect(hoursToClose(et("14:00"))).toBeCloseTo(2, 5);
    expect(hoursToClose(et("15:30"))).toBeCloseTo(0.5, 5);
  });

  it("es cero con el mercado cerrado", () => {
    expect(hoursToClose(et("16:00"))).toBe(0);
    expect(hoursToClose(et("20:00"))).toBe(0);
  });
});

describe("fractionalDte — LA razón de ser del archivo", () => {
  it("no toca los vencimientos de más de un día", () => {
    expect(fractionalDte(40, et("11:00"))).toBe(40);
    expect(fractionalDte(1, et("11:00"))).toBe(1);
  });

  it("mide el 0DTE en horas de sesión", () => {
    // A las 13:00 quedan 3h de 24 → 0,125 días.
    expect(fractionalDte(0, et("13:00"))).toBeCloseTo(3 / 24, 6);
  });

  it("NUNCA devuelve cero: es lo que rompía probAbove", () => {
    // Con T = 0, σ = IV·√T = 0 y la probabilidad colapsa a 1 o 0. El suelo de
    // 15 minutos evita que un screener anuncie "100% de acierto".
    for (const h of ["15:59", "16:00", "20:00"]) {
      expect(fractionalDte(0, et(h))).toBeGreaterThan(0);
    }
  });

  it("arregla de verdad la probabilidad degenerada", () => {
    const spot = 100, strike = 98, iv = 0.4;
    // Con el dte entero de 0 la respuesta es un absoluto sin sentido…
    const roto = probAbove(spot, strike, iv, 0);
    expect(roto === 0 || roto === 1).toBe(true);
    // …y con el fraccionado sale una probabilidad real, alta pero no absoluta.
    const bueno = probAbove(spot, strike, iv, fractionalDte(0, et("13:00")));
    expect(bueno).toBeGreaterThan(0.5);
    expect(bueno).toBeLessThan(1);
  });

  it("cuanto menos tiempo queda, más se acerca la probabilidad al extremo", () => {
    const p = (h: string) => probAbove(100, 98, 0.4, fractionalDte(0, et(h)));
    expect(p("15:30")).toBeGreaterThan(p("10:00"));
  });
});

describe("zeroDteWindow", () => {
  it("cerrado antes de abrir", () => {
    expect(zeroDteWindow(et("08:00")).open).toBe(false);
  });

  it("abierto a media sesión", () => {
    const w = zeroDteWindow(et("11:00"));
    expect(w.open).toBe(true);
    expect(w.hoursLeft).toBeCloseTo(5, 5);
  });

  it("se cierra solo cerca de la campana", () => {
    // Menos de 1h: la gamma se dispara y las horquillas se abren.
    expect(zeroDteWindow(et("15:30")).open).toBe(false);
    expect(zeroDteWindow(et("14:50")).open).toBe(true);
  });

  it("cerrado después del cierre", () => {
    const w = zeroDteWindow(et("16:30"));
    expect(w.open).toBe(false);
    expect(w.why).toMatch(/cerr/i);
  });

  it("siempre explica por qué", () => {
    for (const h of ["08:00", "11:00", "15:30", "18:00"]) {
      expect(zeroDteWindow(et(h)).why.length).toBeGreaterThan(0);
    }
  });
});

describe("zeroDteLiquidityBlock — manda el VOLUMEN, no el open interest", () => {
  it("aprueba una pata con volumen y horquilla estrecha", () => {
    expect(zeroDteLiquidityBlock({ bid: 1.0, ask: 1.05, volume: 5000 })).toBeNull();
  });

  it("bloquea por volumen aunque el OI de ayer fuera enorme", () => {
    // Es justo el caso que el filtro de OI dejaría pasar: contrato muy
    // negociado ayer y hoy abandonado.
    expect(zeroDteLiquidityBlock({ bid: 1.0, ask: 1.05, volume: 3 })).toBe("volumen_bajo");
  });

  it("exige una horquilla más estrecha que el resto del agente", () => {
    // 25% pasaría en la Wheel; aquí no, porque no hay un mañana en el que la
    // horquilla se cierre.
    expect(MAX_ZERO_DTE_SPREAD_PCT).toBeLessThan(25);
    expect(zeroDteLiquidityBlock({ bid: 1.0, ask: 1.25, volume: 5000 })).toBe("spread_ancho");
  });

  it("sin bid no hay nada que vender", () => {
    expect(zeroDteLiquidityBlock({ bid: null, ask: 1.05, volume: 5000 })).toBe("sin_bid");
    expect(zeroDteLiquidityBlock({ bid: 0, ask: 1.05, volume: 5000 })).toBe("sin_bid");
  });

  it("el umbral de volumen es exigente a propósito", () => {
    expect(MIN_ZERO_DTE_VOLUME).toBeGreaterThanOrEqual(100);
    expect(zeroDteLiquidityBlock({ bid: 1, ask: 1.05, volume: MIN_ZERO_DTE_VOLUME })).toBeNull();
    expect(zeroDteLiquidityBlock({ bid: 1, ask: 1.05, volume: MIN_ZERO_DTE_VOLUME - 1 })).toBe("volumen_bajo");
  });
});

describe("topByVolume — la cadena que alimenta el GEX del 0DTE", () => {
  const q = (type: "put" | "call", strike: number, volume: number) => ({ type, strike, volume });

  /** 30 calls y 30 puts con volumen decreciente según el strike. */
  const cadena = [
    ...Array.from({ length: 30 }, (_, i) => q("call", 100 + i, 3000 - i * 100)),
    ...Array.from({ length: 30 }, (_, i) => q("put", 100 - i, 2500 - i * 80)),
  ];

  it("devuelve n de cada lado, no n en total", () => {
    const out = topByVolume(cadena, 10);
    expect(out.filter((x) => x.type === "call")).toHaveLength(10);
    expect(out.filter((x) => x.type === "put")).toHaveLength(10);
    expect(out).toHaveLength(20);
  });

  it("son los MÁS negociados de cada lado", () => {
    const out = topByVolume(cadena, 10);
    const calls = out.filter((x) => x.type === "call").map((x) => x.volume);
    const puts = out.filter((x) => x.type === "put").map((x) => x.volume);
    expect(Math.min(...calls)).toBeGreaterThanOrEqual(
      Math.max(...cadena.filter((x) => x.type === "call" && !calls.includes(x.volume)).map((x) => x.volume)),
    );
    expect(Math.min(...puts)).toBeGreaterThan(0);
  });

  it("descarta los contratos que hoy no han operado", () => {
    // Un strike con volumen 0 no dice nada de la gamma de HOY.
    const conCeros = [...cadena, q("call", 999, 0), q("put", 1, 0)];
    const out = topByVolume(conCeros, 50);
    expect(out.some((x) => x.volume === 0)).toBe(false);
  });

  it("no se rompe con menos contratos de los pedidos", () => {
    const corta = [q("call", 100, 500), q("put", 90, 400)];
    expect(topByVolume(corta, 10)).toHaveLength(2);
  });

  it("con la cadena vacía devuelve vacío", () => {
    expect(topByVolume([], 10)).toHaveLength(0);
  });

  it("aguanta un lado ausente", () => {
    const soloCalls = cadena.filter((x) => x.type === "call");
    const out = topByVolume(soloCalls, 10);
    expect(out).toHaveLength(10);
    expect(out.every((x) => x.type === "call")).toBe(true);
  });

  it("el tope por defecto son 10 por lado", () => {
    expect(ZERO_DTE_TOP_N).toBe(10);
    expect(topByVolume(cadena)).toHaveLength(20);
  });
});
