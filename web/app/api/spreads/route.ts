// GET /api/spreads?preset=balanceado — Screener de verticales e iron condors por SSE.
//
// Orquesta I/O y NADA de criterio: todo lo que decide vive en lib/spreads.ts.
// El saldo NO llega aquí: la ruta devuelve estructuras con su pérdida máxima y
// la asequibilidad se calcula en el cliente con tito.risk.* de localStorage.
// Misma frontera que /api/wheel, y por la misma razón.

import { fetchSpreads } from "@/lib/marketData";
import { cachedDailyBars } from "@/lib/barsStore";
import { realizedVolSeries, rankWithin } from "@/lib/ivcontext";
import { earningsForTicker } from "@/lib/earnings";
import {
  SPREAD_PRESETS, buildSpreads,
  type SpreadPresetId, type SpreadCandidate,
} from "@/lib/spreads";
import { WHEEL_UNIVERSE } from "@/lib/wheelUniverse";
import type { SpreadSseEvent } from "@/app/spreads/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Más bajo que el 6 de la Wheel: aquí cada ticket pide la cadena ENTERA
// (calls y puts), así que las respuestas son del orden del doble de grandes.
const CONCURRENCY = 4;

function sse(event: SpreadSseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function isPreset(v: string | null): v is SpreadPresetId {
  return v === "conservador" || v === "balanceado" || v === "agresivo";
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function run(): Promise<void> {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const presetParam = url.searchParams.get("preset");
  const preset = SPREAD_PRESETS[isPreset(presetParam) ? presetParam : "balanceado"];
  const now = new Date();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: SpreadSseEvent) => controller.enqueue(encoder.encode(sse(e)));
      let failed = 0;
      const all: SpreadCandidate[] = [];

      try {
        send({ type: "step", label: `Escaneando ${WHEEL_UNIVERSE.length} tickers · preset ${preset.label}` });

        await mapLimit(WHEEL_UNIVERSE, CONCURRENCY, async (sym) => {
          try {
            const chain = await fetchSpreads(sym.ticker, {
              dteMin: preset.dteMin, dteMax: preset.dteMax, now,
            });
            if (chain.spot == null || chain.quotes.length === 0) {
              failed++;
              send({ type: "step", label: `${sym.ticker}: sin cadena` });
              return;
            }

            // IV Rank propio por volatilidad realizada, igual que la Wheel:
            // no hay serie histórica de IV implícita.
            const bars = await cachedDailyBars(sym.ticker, 365, now);
            const rvSeries = realizedVolSeries(bars.map((b) => b.close), 30);
            const currentRv = rvSeries.length > 0 ? rvSeries[rvSeries.length - 1] : null;
            const ivRank = currentRv != null ? rankWithin(rvSeries, currentRv) : null;

            const nearExp = chain.quotes.reduce((a, b) => (b.dte < a.dte ? b : a)).expiration;
            const earnings = await earningsForTicker({
              ticker: sym.ticker, expiration: nearExp, frontSkew: null, now,
            });

            const cands = buildSpreads({
              ticker: sym.ticker,
              spot: chain.spot,
              quotes: chain.quotes,
              preset,
              ivRank,
              earnings,
              fallbackIv: currentRv != null ? currentRv / 100 : 0.4,
            });
            all.push(...cands);
            send({
              type: "step",
              label: `${sym.ticker}: ${cands.filter((c) => !c.blocked).length} estructuras`,
            });
          } catch {
            failed++;
            send({ type: "step", label: `${sym.ticker}: error` });
          }
        });

        all.sort((a, b) => {
          if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
          return (b.score?.total ?? 0) - (a.score?.total ?? 0);
        });

        const withCandidates = new Set(all.filter((c) => !c.blocked).map((c) => c.ticker)).size;
        send({
          type: "done",
          candidates: all,
          meta: {
            preset: preset.label,
            scanned: WHEEL_UNIVERSE.length,
            failed,
            withCandidates,
            degraded: failed > WHEEL_UNIVERSE.length / 2,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Error inesperado en el escaneo.";
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
