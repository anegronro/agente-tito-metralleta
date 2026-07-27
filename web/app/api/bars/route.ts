// GET /api/bars?ticker=XXX&tf=1y|15m10d|5m5d — barras del subyacente para la gráfica de flujo.

import { MassiveError } from "@/lib/massive";
import { fetchTfBars } from "@/lib/marketData";
import { SchwabError } from "@/lib/schwab";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TF: Record<string, { m: number; span: "day" | "minute"; days: number }> = {
  "1y": { m: 1, span: "day", days: 365 },
  "15m10d": { m: 15, span: "minute", days: 10 },
  "5m5d": { m: 5, span: "minute", days: 5 },
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();
  const tf = searchParams.get("tf") ?? "5m5d";
  const cfg = TF[tf] ?? TF["5m5d"];
  if (!ticker) return Response.json({ error: "ticker requerido" }, { status: 400 });
  try {
    const bars = await fetchTfBars(ticker, cfg.m, cfg.span, cfg.days);
    return Response.json({ ticker, tf, bars });
  } catch (err) {
    const message =
      err instanceof MassiveError || err instanceof SchwabError
        ? err.message
        : "Error al cargar barras.";
    return Response.json({ error: message }, { status: 502 });
  }
}
