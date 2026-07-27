// Memoria del agente — diario de predicciones para auto-evaluación.
//
// El agente guarda UNA foto por día de mercado con sus 3 targets (bajista/base/alcista).
// Días después, `reviewPredictions` compara esos targets contra el precio real que hizo
// la acción dentro del horizonte: qué tan lejos quedó, si tocó el target, y si acertó la
// dirección. Con eso mide su propio error y su sesgo (si sistemáticamente sobre/subestima),
// que es la materia prima para ir mejorando los targets. Solo servidor (fs), pero la
// lógica de revisión es PURA (tests en predictionStore.test.ts).

import { promises as fs } from "fs";
import path from "path";
import { marketDateStr } from "./occ";

const DATA_DIR = path.join(process.cwd(), "data", "predictions");
/** Cuántas fotos guardar por ticker. */
export const JOURNAL_DAYS = 120;

/**
 * Marca de régimen del motor. Se estampa en cada foto y CORTA la calibración:
 * las estadísticas agregadas solo miran fotos de la versión vigente.
 *
 * Por qué existe: hasta el 2026-07-27 la gamma del GEX se estimaba con
 * Black-Scholes usando UNA sola IV para toda la cadena, lo que empujaba el nodo
 * imán —y por tanto el target base— a quedar pegado al precio de contado por
 * pura mecánica del modelo. Con la gamma real de Schwab el imán se mueve a donde
 * está el posicionamiento de verdad (en NVDA, de $197.5 a $220).
 *
 * Mezclar los dos regímenes en el mismo promedio de sesgo daría una corrección
 * que no describe a ninguno de los dos. Al subir esta constante, el historial se
 * conserva y se sigue enseñando, pero deja de contar para el sesgo.
 */
export const ENGINE_VERSION = "gamma-real-2026-07-27";

export interface PredictionSnapshot {
  date: string;        // fecha de mercado (ET), YYYY-MM-DD
  savedAt: string;
  spot: number;
  horizonDays: number;
  bear: number;
  base: number;
  bull: number;
  direction: "up" | "down" | "flat";
  confidence: number;
  /** Régimen del motor que la produjo. Ausente = anterior al corte (gamma estimada). */
  engine?: string;
}

export interface PredictionJournal {
  ticker: string;
  updatedAt: string;
  snapshots: PredictionSnapshot[]; // más reciente primero
}

export interface EvalBar { time: string; high: number; low: number; close: number; }

export interface PredictionEval {
  date: string;
  horizonDays: number;
  sessions: number;        // sesiones de mercado transcurridas dentro de la ventana
  matured: boolean;        // el horizonte ya venció
  spot: number;
  bear: number;
  base: number;
  bull: number;
  direction: string;
  actualClose: number | null;   // cierre al final de la ventana (o el último disponible)
  actualHigh: number | null;
  actualLow: number | null;
  baseErrorPct: number | null;  // firmado: (real − base) / spot × 100
  baseAbsErrorPct: number | null;
  baseTouched: boolean;
  bullTouched: boolean;
  bearTouched: boolean;
  directionHit: boolean | null;
  best: "bear" | "base" | "bull" | null; // el target más cercano al cierre real
  /** Régimen que la produjo. Ausente = anterior al corte. */
  engine?: string;
  /** true si NO cuenta para las estadísticas por ser de un régimen anterior. */
  legacy: boolean;
}

export interface PredictionReview {
  evals: PredictionEval[];          // más reciente primero (incluye las legacy)
  /** Madurados del régimen VIGENTE. Es la base de todas las métricas de abajo. */
  maturedCount: number;
  /** Madurados descartados por ser de un régimen anterior. Solo informativo. */
  legacyMaturedCount: number;
  /** Régimen sobre el que se calcularon las métricas. */
  engine: string;
  meanAbsErrorPct: number | null;   // error medio del target base (madurados)
  biasPct: number | null;           // error medio FIRMADO (>0 = subestima, precio quedó arriba)
  baseTouchRate: number | null;     // % de veces que el precio tocó el target base
  directionHitRate: number | null;  // % de acierto de dirección (0-100)
  bestCounts: { bear: number; base: number; bull: number };
}

function fileFor(ticker: string): string {
  const safe = ticker.trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  return path.join(DATA_DIR, `${safe}.json`);
}

function addCalendarDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function loadJournal(ticker: string): Promise<PredictionJournal | null> {
  try {
    const raw = await fs.readFile(fileFor(ticker), "utf8");
    const parsed = JSON.parse(raw) as PredictionJournal;
    return Array.isArray(parsed.snapshots) ? parsed : null;
  } catch {
    return null;
  }
}

/** Guarda la foto del día (una por fecha de mercado; se reemplaza si ya existe). */
export async function savePrediction(
  ticker: string,
  snap: Omit<PredictionSnapshot, "date" | "savedAt">,
  now: Date = new Date(),
): Promise<PredictionJournal> {
  const clean = ticker.trim().toUpperCase();
  const date = marketDateStr(now);
  // El régimen se estampa aquí y no lo pasa el llamador: es una propiedad del
  // motor, no de la petición, y así ninguna ruta puede olvidarse de ponerlo.
  const snapshot: PredictionSnapshot = {
    ...snap,
    date,
    savedAt: now.toISOString(),
    engine: ENGINE_VERSION,
  };

  const existing = await loadJournal(clean);
  const byDate = new Map<string, PredictionSnapshot>();
  for (const s of existing?.snapshots ?? []) byDate.set(s.date, s);
  byDate.set(date, snapshot);

  const snapshots = [...byDate.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, JOURNAL_DAYS);

  const payload: PredictionJournal = { ticker: clean, updatedAt: now.toISOString(), snapshots };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(fileFor(clean), JSON.stringify(payload), "utf8");
  return payload;
}

/** ¿El precio alcanzó el target? Arriba del spot se mira el máximo; abajo, el mínimo. */
function touched(target: number, spot: number, high: number, low: number): boolean {
  return target >= spot ? high >= target : low <= target;
}

/**
 * Revisa cada predicción guardada contra las barras reales posteriores. PURA.
 * Una predicción "madura" cuando su horizonte ya venció (hoy ≥ fecha + horizonte).
 */
export function reviewPredictions(
  snapshots: PredictionSnapshot[],
  bars: EvalBar[],
  now: Date = new Date(),
): PredictionReview {
  const today = marketDateStr(now);
  const evals: PredictionEval[] = [];

  for (const s of snapshots) {
    const end = addCalendarDays(s.date, s.horizonDays);
    const matured = today >= end;
    // Ventana: barras después de la foto y hasta el vencimiento (o lo disponible).
    const window = bars.filter((b) => b.time > s.date && b.time <= end);
    if (window.length === 0) {
      evals.push({
        date: s.date, horizonDays: s.horizonDays, sessions: 0, matured,
        spot: s.spot, bear: s.bear, base: s.base, bull: s.bull, direction: s.direction,
        actualClose: null, actualHigh: null, actualLow: null,
        baseErrorPct: null, baseAbsErrorPct: null,
        baseTouched: false, bullTouched: false, bearTouched: false,
        directionHit: null, best: null,
        engine: s.engine, legacy: s.engine !== ENGINE_VERSION,
      });
      continue;
    }

    const actualClose = window[window.length - 1].close;
    const actualHigh = Math.max(...window.map((b) => b.high));
    const actualLow = Math.min(...window.map((b) => b.low));
    const baseErrorPct = s.spot > 0 ? ((actualClose - s.base) / s.spot) * 100 : null;
    const targets: [PredictionEval["best"], number][] = [
      ["bear", s.bear], ["base", s.base], ["bull", s.bull],
    ];
    const best = targets
      .slice()
      .sort((a, b) => Math.abs(a[1] - actualClose) - Math.abs(b[1] - actualClose))[0][0];

    const moved = actualClose - s.spot;
    const flatBand = s.spot * 0.01;
    const directionHit = !matured ? null
      : s.direction === "up" ? moved > 0
      : s.direction === "down" ? moved < 0
      : Math.abs(moved) <= flatBand;

    evals.push({
      date: s.date, horizonDays: s.horizonDays, sessions: window.length, matured,
      spot: s.spot, bear: s.bear, base: s.base, bull: s.bull, direction: s.direction,
      actualClose, actualHigh, actualLow,
      baseErrorPct, baseAbsErrorPct: baseErrorPct == null ? null : Math.abs(baseErrorPct),
      baseTouched: touched(s.base, s.spot, actualHigh, actualLow),
      bullTouched: touched(s.bull, s.spot, actualHigh, actualLow),
      bearTouched: touched(s.bear, s.spot, actualHigh, actualLow),
      directionHit, best,
      engine: s.engine, legacy: s.engine !== ENGINE_VERSION,
    });
  }

  evals.sort((a, b) => b.date.localeCompare(a.date));

  // El corte: las fotos de un régimen anterior SE SIGUEN ENSEÑANDO en `evals`
  // (el historial es del usuario), pero no entran en ninguna métrica. El sesgo
  // alimenta la auto-corrección de predictPro, y promediar dos regímenes daría
  // una corrección que no describe a ninguno.
  const maduros = evals.filter((e) => e.matured && e.actualClose != null);
  const mat = maduros.filter((e) => !e.legacy);
  const legacyMaturedCount = maduros.length - mat.length;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const bestCounts = { bear: 0, base: 0, bull: 0 };
  for (const e of mat) if (e.best) bestCounts[e.best] += 1;

  return {
    evals,
    maturedCount: mat.length,
    legacyMaturedCount,
    engine: ENGINE_VERSION,
    meanAbsErrorPct: mean(mat.map((e) => e.baseAbsErrorPct!).filter((x) => x != null)),
    biasPct: mean(mat.map((e) => e.baseErrorPct!).filter((x) => x != null)),
    baseTouchRate: mat.length ? (mat.filter((e) => e.baseTouched).length / mat.length) * 100 : null,
    directionHitRate: mat.length
      ? (mat.filter((e) => e.directionHit).length / mat.length) * 100 : null,
    bestCounts,
  };
}
