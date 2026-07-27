// GET /api/validation?ticker=XXX — Sub-agente 6: ¿el precio valida o absorbe el flujo?
// Corre el backtest sobre los flows YA GUARDADOS en data/trades/ contra las barras
// diarias del subyacente.

import { loadTrades } from "@/lib/store";
import { fetchDaily } from "@/lib/marketData";
import { validationScore, type FlowLite } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!ticker) return Response.json({ error: "Falta el ticker." }, { status: 400 });

  try {
    const [stored, bars] = await Promise.all([
      loadTrades(ticker),
      fetchDaily(ticker, 200).catch(() => []),
    ]);

    const flows: FlowLite[] = (stored?.trades ?? [])
      .filter((t) => t.assetPrice > 0 && t.timestamp)
      .map((t) => ({
        id: t.id,
        timestamp: t.timestamp,
        type: t.type,
        strike: t.strike,
        expiration: t.expiration,
        assetPrice: t.assetPrice,
        premium: t.premium,
        aggression: t.aggression,
      }));

    const report = validationScore({ flows, bars, now: new Date() });
    // La tabla del panel solo necesita una muestra; el score usa todo.
    return Response.json({ ...report, outcomes: report.outcomes.slice(0, 40) });
  } catch {
    return Response.json({ error: "No se pudo correr el backtest." }, { status: 502 });
  }
}
