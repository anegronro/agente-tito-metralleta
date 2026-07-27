import { describe, it, expect } from "vitest";
import {
  ENGINE_VERSION,
  reviewPredictions,
  type PredictionSnapshot,
  type EvalBar,
} from "./predictionStore";

/**
 * Foto del régimen VIGENTE. Lleva `engine` a propósito: sin él contaría como
 * legacy y quedaría fuera de las métricas, que es justo lo que comprueban los
 * tests del corte más abajo.
 */
function snap(over: Partial<PredictionSnapshot> = {}): PredictionSnapshot {
  return {
    date: "2026-01-05", savedAt: "2026-01-05T21:00:00Z",
    spot: 100, horizonDays: 20, bear: 92, base: 105, bull: 112,
    direction: "up", confidence: 60, engine: ENGINE_VERSION, ...over,
  };
}

function bar(time: string, close: number, high = close + 1, low = close - 1): EvalBar {
  return { time, high, low, close };
}

describe("reviewPredictions", () => {
  it("no evalúa dentro de la ventana si no hay barras posteriores", () => {
    const r = reviewPredictions([snap()], [bar("2026-01-05", 100)], new Date("2026-01-06T12:00:00Z"));
    expect(r.evals[0].sessions).toBe(0);
    expect(r.evals[0].actualClose).toBeNull();
    expect(r.maturedCount).toBe(0);
  });

  it("marca 'matured' cuando el horizonte ya venció y calcula el error del base", () => {
    const bars = [
      bar("2026-01-06", 101),
      bar("2026-01-15", 104),
      bar("2026-01-23", 106), // cierre dentro de la ventana (fin = 2026-01-25)
      bar("2026-02-10", 120), // fuera de la ventana, se ignora
    ];
    const r = reviewPredictions([snap()], bars, new Date("2026-02-01T12:00:00Z"));
    const e = r.evals[0];
    expect(e.matured).toBe(true);
    expect(e.actualClose).toBe(106);
    // base=105, spot=100 → error = (106-105)/100*100 = +1%
    expect(e.baseErrorPct).toBeCloseTo(1, 5);
    expect(e.baseAbsErrorPct).toBeCloseTo(1, 5);
    expect(e.best).toBe("base"); // 106 más cerca de 105 que de 92/112
  });

  it("detecta que tocó el target base (máximo cruzó el nivel arriba)", () => {
    const bars = [bar("2026-01-10", 103, /*high*/ 106, /*low*/ 101)];
    const r = reviewPredictions([snap()], bars, new Date("2026-02-01T12:00:00Z"));
    expect(r.evals[0].baseTouched).toBe(true); // high 106 ≥ base 105
    expect(r.evals[0].bullTouched).toBe(false); // high 106 < bull 112
  });

  it("acierta la dirección 'up' si el cierre quedó por encima del spot", () => {
    const up = reviewPredictions([snap({ direction: "up" })], [bar("2026-01-20", 108)], new Date("2026-02-01T12:00:00Z"));
    expect(up.evals[0].directionHit).toBe(true);
    const down = reviewPredictions([snap({ direction: "up" })], [bar("2026-01-20", 95)], new Date("2026-02-01T12:00:00Z"));
    expect(down.evals[0].directionHit).toBe(false);
  });

  it("agrega error medio, sesgo y tasa de acierto sobre las madurados", () => {
    const s1 = snap({ date: "2026-01-05", base: 105 });
    const s2 = snap({ date: "2026-01-06", base: 110 });
    // Ambas barras caen dentro de ambas ventanas → el último cierre (108) aplica a las dos.
    const bars = [bar("2026-01-20", 107), bar("2026-01-21", 108)];
    const r = reviewPredictions([s1, s2], bars, new Date("2026-03-01T12:00:00Z"));
    expect(r.maturedCount).toBe(2);
    // s1: (108-105)/100 = +3 · s2: (108-110)/100 = -2 → |media| = 2.5, sesgo = +0.5
    expect(r.meanAbsErrorPct).toBeCloseTo(2.5, 5);
    expect(r.biasPct).toBeCloseTo(0.5, 5);
    expect(r.directionHitRate).toBe(100); // ambos 'up' y ambos cerraron > spot 100
  });
});

// ── El corte de régimen (gamma estimada → gamma real de Schwab) ──────────────

describe("reviewPredictions — corte por régimen del motor", () => {
  const bars = [bar("2026-01-06", 101), bar("2026-01-23", 106)];
  const AHORA = new Date("2026-02-01T12:00:00Z");

  it("no cuenta las fotos sin engine (anteriores al corte)", () => {
    const vieja = { ...snap(), engine: undefined };
    const r = reviewPredictions([vieja], bars, AHORA);
    expect(r.maturedCount).toBe(0);
    expect(r.legacyMaturedCount).toBe(1);
    expect(r.biasPct).toBeNull();
    expect(r.meanAbsErrorPct).toBeNull();
  });

  it("las sigue enseñando en el historial, marcadas", () => {
    // El historial es del usuario: se excluyen de las métricas, no de la vista.
    const r = reviewPredictions([{ ...snap(), engine: undefined }], bars, AHORA);
    expect(r.evals).toHaveLength(1);
    expect(r.evals[0].legacy).toBe(true);
    expect(r.evals[0].actualClose).toBe(106); // se evaluó igual
  });

  it("tampoco cuenta las de un régimen distinto al vigente", () => {
    const r = reviewPredictions([{ ...snap(), engine: "otro-motor-v1" }], bars, AHORA);
    expect(r.maturedCount).toBe(0);
    expect(r.legacyMaturedCount).toBe(1);
  });

  it("el sesgo se calcula SOLO sobre el régimen vigente", () => {
    // La vieja tiene un error enorme; si contara, arrastraría el sesgo.
    const vigente = snap({ base: 105 });                       // error (106-105)/100 = +1
    const vieja = { ...snap({ base: 40 }), engine: undefined }; // error sería +66
    const r = reviewPredictions([vigente, vieja], bars, AHORA);
    expect(r.maturedCount).toBe(1);
    expect(r.legacyMaturedCount).toBe(1);
    expect(r.biasPct).toBeCloseTo(1, 5); // ni rastro del +66
  });

  it("informa del régimen sobre el que calculó", () => {
    const r = reviewPredictions([snap()], bars, AHORA);
    expect(r.engine).toBe(ENGINE_VERSION);
    expect(r.evals[0].legacy).toBe(false);
  });
});
