import { describe, expect, it } from "vitest";
import { CONSENSUS, consensus, msScore } from "./consensus";

describe("msScore — LA puerta del campo de MarketSnack", () => {
  it("EL 0 ES null, no un cero", () => {
    // Es el hallazgo que da sentido al archivo: en su feed el 76% de las filas
    // de `unusual-flow-spike` traen 0 y son las de MAYOR prima. Dejarlo pasar
    // como puntuación baja daba correlación negativa con la nuestra.
    expect(msScore(0)).toBeNull();
    expect(msScore(-5)).toBeNull();
  });

  it("deja pasar los valores reales", () => {
    expect(msScore(62)).toBe(62);
    expect(msScore(85)).toBe(85);
  });

  it("aguanta basura sin devolver NaN", () => {
    for (const v of [null, undefined, NaN, Infinity]) expect(msScore(v as never)).toBeNull();
  });

  it("topa en 100", () => {
    expect(msScore(500)).toBe(100);
  });
});

describe("consensus", () => {
  it("sin segunda opinión, el score no se toca", () => {
    const c = consensus({ mine: 6, msRaw: 0 });
    expect(c.agreement).toBe("solo_nuestro");
    expect(c.combined).toBe(6);
    expect(c.ms).toBeNull();
  });

  it("una segunda opinión más alta sube el score, pero poco", () => {
    // MS 90/100 = 9 en nuestra escala, frente a un 5 nuestro: delta 4, y aun
    // así el ajuste se topa en 1 punto.
    const c = consensus({ mine: 5, msRaw: 90 });
    expect(c.combined).toBeGreaterThan(5);
    expect(c.combined).toBeLessThanOrEqual(5 + CONSENSUS.capPoints);
  });

  it("una segunda opinión más baja lo baja, igual de poco", () => {
    const c = consensus({ mine: 8, msRaw: 35 });
    expect(c.combined).toBeLessThan(8);
    expect(c.combined).toBeGreaterThanOrEqual(8 - CONSENSUS.capPoints);
  });

  it("NUNCA mueve el score más de un punto", () => {
    for (const mine of [0, 2.5, 5, 7.3, 10]) {
      for (const ms of [1, 20, 50, 80, 100]) {
        const c = consensus({ mine, msRaw: ms });
        expect(Math.abs(c.combined - mine)).toBeLessThanOrEqual(CONSENSUS.capPoints + 1e-9);
      }
    }
  });

  it("el resultado se queda dentro de 0-10", () => {
    expect(consensus({ mine: 10, msRaw: 100 }).combined).toBeLessThanOrEqual(10);
    expect(consensus({ mine: 0, msRaw: 1 }).combined).toBeGreaterThanOrEqual(0);
  });

  it("distingue confirmar de discrepar", () => {
    expect(consensus({ mine: 6, msRaw: 62 }).agreement).toBe("confirma");
    expect(consensus({ mine: 3, msRaw: 90 }).agreement).toBe("discrepa");
    expect(consensus({ mine: 9, msRaw: 35 }).agreement).toBe("discrepa");
  });

  it("EN 0DTE NO SE CRUZAN: está medido que no guardan relación", () => {
    const c = consensus({ mine: 6.7, msRaw: 76, zeroDte: true });
    expect(c.combined).toBe(6.7);
    expect(c.agreement).toBe("solo_nuestro");
    // Se conserva el valor para poder enseñarlo, pero no puntúa.
    expect(c.ms).toBeCloseTo(7.6, 6);
    expect(c.why).toMatch(/0DTE/);
  });

  it("siempre explica el porqué en llano", () => {
    for (const caso of [
      { mine: 6, msRaw: 62 },
      { mine: 3, msRaw: 90 },
      { mine: 9, msRaw: 35 },
      { mine: 5, msRaw: 0 },
    ]) {
      expect(consensus(caso).why.length).toBeGreaterThan(10);
    }
  });

  it("caso real medido: IWM put 0DTE con MS en 0", () => {
    // MS 0/100 frente a nuestro 6,7/10 — con el 0 tratado como cero, este
    // trade se hundiría en el ranking siendo de los mejores del feed.
    const c = consensus({ mine: 6.7, msRaw: 0, zeroDte: true });
    expect(c.combined).toBe(6.7);
  });
});
