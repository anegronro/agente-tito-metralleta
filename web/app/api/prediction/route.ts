// Memoria del agente.
//   POST /api/prediction   { ticker, snapshot }  → guarda la foto del día (dedupe por fecha ET)
//   GET  /api/prediction?ticker=XXX              → revisa las predicciones guardadas contra
//                                                   el precio real posterior (auto-evaluación)

import { fetchDaily } from "@/lib/marketData";
import {
  loadJournal, savePrediction, reviewPredictions,
  type PredictionSnapshot,
} from "@/lib/predictionStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!ticker) return Response.json({ error: "Falta el ticker." }, { status: 400 });

  try {
    const [journal, bars] = await Promise.all([
      loadJournal(ticker),
      fetchDaily(ticker, 200).catch(() => []),
    ]);
    const snapshots = journal?.snapshots ?? [];
    const review = reviewPredictions(
      snapshots,
      bars.map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close })),
      new Date(),
    );
    // El panel solo muestra las evaluaciones con al menos una sesión transcurrida.
    return Response.json({
      ...review,
      evals: review.evals.filter((e) => e.sessions > 0).slice(0, 30),
      total: snapshots.length,
    });
  } catch {
    return Response.json({ error: "No se pudo leer la memoria." }, { status: 502 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      ticker?: string;
      snapshot?: Omit<PredictionSnapshot, "date" | "savedAt">;
    };
    const ticker = (body.ticker ?? "").trim().toUpperCase();
    const s = body.snapshot;
    if (!ticker || !s || !(s.spot > 0)) {
      return Response.json({ error: "Datos inválidos." }, { status: 400 });
    }
    await savePrediction(ticker, {
      spot: s.spot,
      horizonDays: s.horizonDays,
      bear: s.bear,
      base: s.base,
      bull: s.bull,
      direction: s.direction,
      confidence: s.confidence,
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "No se pudo guardar." }, { status: 502 });
  }
}
