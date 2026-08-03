// GET /api/spx — Alertas de SPX sobre la gamma del vencimiento de HOY.
//
// Orquesta I/O y nada de criterio: los avisos los decide lib/spxAlerts.ts.
//
// Una sola llamada a Schwab por consulta, y con caché de 60s: esto está pensado
// para tenerlo abierto y refrescando, no para un escaneo puntual.

import { fetchSpreads } from "@/lib/marketData";
import { cachedDailyBars } from "@/lib/barsStore";
import { gexAnalysis } from "@/lib/gex";
import { spxAlerts, type SpxAlert } from "@/lib/spxAlerts";
import { topByVolume, ZERO_DTE_TOP_N, zeroDteWindow } from "@/lib/zeroDte";
import type { Row } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TICKER = "SPX";
const CACHE_MS = 60_000;

export interface SpxReport {
  spot: number;
  magnet: number | null;
  flip: number | null;
  regime: "positive" | "negative";
  hoursLeft: number;
  contracts: number;
  alerts: SpxAlert[];
  nodes: { strike: number; netGex: number; concentration: number }[];
  checkedAt: string;
}

let cache: { report: SpxReport; at: number } | null = null;

export async function GET() {
  const now = new Date();
  const ventana = zeroDteWindow(now);
  if (!ventana.open) {
    return Response.json(
      { error: `${ventana.why} Las alertas de SPX son del vencimiento de hoy.` },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return Response.json(cache.report, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const chain = await fetchSpreads(TICKER, { dteMin: 0, dteMax: 0, now });
    if (chain.spot == null || chain.quotes.length === 0) {
      return Response.json(
        { error: "Schwab no devolvió cadena 0DTE de SPX." },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    // Misma regla que el screener: solo los más negociados de hoy, y el volumen
    // hace de tamaño de posición porque el open interest es de anoche.
    const top = topByVolume(chain.quotes, ZERO_DTE_TOP_N);
    const rows: Row[] = top.map((q) => ({
      optionTicker: `${q.type}-${q.strike}`,
      contractType: q.type,
      expiration: q.expiration,
      strike: q.strike,
      openInterest: q.volume,
      volume: q.volume,
      price: q.last,
      priceSource: "last_trade" as const,
      openPremium: q.last != null ? q.last * q.volume : null,
      notionalValue: q.strike * 100 * q.volume,
      gamma: q.gamma ?? undefined,
      iv: q.iv ?? undefined,
    }));

    const bars = await cachedDailyBars(TICKER, 365, now).catch(() => []);
    const gex = gexAnalysis({
      rows, closes: bars.map((b) => b.close), spot: chain.spot, now, allowZeroDte: true,
    });

    const nodes = gex.nodes.slice(0, 6).map((n) => ({
      strike: n.strike, netGex: n.netGex, concentration: n.concentration,
    }));

    const report: SpxReport = {
      spot: chain.spot,
      magnet: gex.kingStrike,
      flip: gex.flipStrike,
      regime: gex.regime,
      hoursLeft: ventana.hoursLeft,
      contracts: top.length,
      alerts: spxAlerts({
        spot: chain.spot,
        magnet: gex.kingStrike,
        flip: gex.flipStrike,
        regime: gex.regime,
        hoursLeft: ventana.hoursLeft,
        walls: nodes,
      }),
      nodes,
      checkedAt: now.toISOString(),
    };

    cache = { report, at: Date.now() };
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error inesperado.";
    return Response.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
