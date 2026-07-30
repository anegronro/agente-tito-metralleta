// GET /api/spreads?preset=balanceado — Screener de verticales e iron condors por SSE.
//
// Orquesta I/O y NADA de criterio: todo lo que decide vive en lib/spreads.ts y
// lib/directional.ts. El saldo NO llega aquí: la ruta devuelve estructuras con
// su pérdida máxima y la asequibilidad se calcula en el cliente con
// tito.risk.* de localStorage. Misma frontera que /api/wheel.
//
// EL PRESUPUESTO DE LLAMADAS ES EL DISEÑO DE ESTE ARCHIVO. Conectar las tres
// señales direccionales de forma ingenua serían 40 llamadas de flujo + 40 de
// noticias por escaneo, y Massive corta a 5 peticiones/minuto. En su lugar:
//   · GEX      → 0 llamadas. Sale de la MISMA cadena de Schwab que ya se pide,
//                usando la gamma real que venía en la respuesta y se tiraba.
//   · Flujo    → 1 llamada. Un escaneo de mercado entero de MarketSnack, igual
//                que /ideas, y se reparte por ticker.
//   · Noticias → como mucho NEWS_BUDGET, y solo para los tickers donde el
//                sesgo ya es fuerte: es ahí donde confirmar o contradecir
//                cambia una decisión.

import { fetchSpreads } from "@/lib/marketData";
import { cachedDailyBars } from "@/lib/barsStore";
import { findLevels, type LvlBar } from "@/lib/levels";
import { realizedVolSeries, rankWithin } from "@/lib/ivcontext";
import { earningsForTicker } from "@/lib/earnings";
import { fetchMarketFlow } from "@/lib/marketsnack";
import { classifyFlow } from "@/lib/flow";
import { fetchTickerNews, newsBias } from "@/lib/news";
import { gexAnalysis } from "@/lib/gex";
import {
  callPremiumPctByTicker, combineBias, flowVote, gexVote, newsVote,
  type DirectionalContext,
} from "@/lib/directional";
import {
  SPREAD_PRESETS, buildSpreads, scoreSpread,
  type SpreadPresetId, type SpreadCandidate, type EarningsFlag,
} from "@/lib/spreads";
import { zeroDteWindow } from "@/lib/zeroDte";
import { WHEEL_UNIVERSE } from "@/lib/wheelUniverse";
import type { Level } from "@/lib/levels";
import type { Row } from "@/lib/types";
import type { SpreadSseEvent } from "@/app/spreads/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Más bajo que el 6 de la Wheel: aquí cada ticker pide la cadena ENTERA
// (calls y puts), así que las respuestas son del orden del doble de grandes.
const CONCURRENCY = 4;

/** Tope de tickers a los que se les piden noticias. Ver la nota de arriba. */
const NEWS_BUDGET = 10;

/** Convicción mínima (de GEX+flujo) para que valga la pena gastar una noticia. */
const NEWS_MIN_STRENGTH = 15;

function sse(event: SpreadSseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function isPreset(v: string | null): v is SpreadPresetId {
  return v === "conservador" || v === "balanceado" || v === "agresivo" || v === "0dte";
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

/**
 * Flujo de todo el mercado en una llamada → % de premium en calls por ticker.
 *
 * Si MarketSnack falla (la cookie caduca cada pocos días) se devuelve un mapa
 * vacío y el escaneo sigue: `combineBias` renormaliza sobre las fuentes que sí
 * están, así que se pierde precisión pero no la página. Es la misma decisión
 * que hay en el resto del agente — degradar, no caerse.
 */
async function marketFlowBias(now: Date): Promise<Map<string, number>> {
  try {
    const { trades } = await fetchMarketFlow({ period: "1d", maxPages: 8, minPremium: 250_000 });
    const { rows } = classifyFlow(trades, now);
    return callPremiumPctByTicker(rows);
  } catch {
    return new Map();
  }
}

/** Los campos de `Row` que `gexAnalysis` mira; el resto son relleno inocuo. */
function rowsForGex(quotes: Awaited<ReturnType<typeof fetchSpreads>>["quotes"]): Row[] {
  return quotes.map((q) => ({
    optionTicker: `${q.type}-${q.strike}-${q.expiration}`,
    contractType: q.type,
    expiration: q.expiration,
    strike: q.strike,
    openInterest: q.openInterest,
    volume: q.volume,
    price: q.last,
    priceSource: "last_trade" as const,
    openPremium: q.last != null ? q.last * q.openInterest : null,
    notionalValue: q.strike * 100 * q.openInterest,
    gamma: q.gamma ?? undefined,
    iv: q.iv ?? undefined,
  }));
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
      // Lo que hace falta para volver a puntuar sin pedir de nuevo la cadena.
      const contexto = new Map<string, {
        ctx: DirectionalContext; supports: Level[]; resistances: Level[]; spot: number;
        ivRank: number | null; callPct: number | null; earnings: EarningsFlag;
      }>();

      try {
        // PORTERO DEL 0DTE. Fuera de la sesión esto no devuelve "menos
        // resultados", devuelve resultados FALSOS: probado con el mercado
        // cerrado, colaba un SPY 744/745 con 0,3% de probabilidad —un contrato
        // que ya había expirado sin valor— presentado como operable. Un
        // screener que enseña eso es peor que uno que no enseña nada.
        if (preset.zeroDte) {
          const ventana = zeroDteWindow(now);
          if (!ventana.open) {
            send({ type: "error", message: `${ventana.why} Los 0DTE solo se pueden mirar con el mercado abierto.` });
            return;
          }
          send({ type: "step", label: `0DTE · ${ventana.why}` });
        }

        send({ type: "step", label: "Leyendo el flujo de todo el mercado…" });
        const flowPct = await marketFlowBias(now);
        send({
          type: "step",
          label: flowPct.size > 0
            ? `Flujo con dirección en ${flowPct.size} tickers`
            : "Sin flujo disponible (se sigue con GEX y niveles)",
        });

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
            const spot = chain.spot;

            const bars = await cachedDailyBars(sym.ticker, 365, now);
            const closes = bars.map((b) => b.close);

            // ── Señal 1: niveles de precio ──
            const lvlBars: LvlBar[] = bars.map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close }));
            const levels = findLevels({ bars: lvlBars, spot, now });

            // ── Señal 2: imán de gamma, de la cadena que ya tenemos ──
            // OJO: es el GEX de la VENTANA de vencimientos del preset (30-45d),
            // no el de la cadena completa del panel Pro. Es a propósito —para
            // un spread a 40 días manda la gamma de esos vencimientos, no la
            // del viernes que viene— pero no son el mismo número.
            const gex = gexAnalysis({ rows: rowsForGex(chain.quotes), closes, spot, now });

            // ── Señal 3: flujo (del escaneo único de arriba) ──
            const callPct = flowPct.get(sym.ticker) ?? null;

            const ctx = combineBias(
              [gexVote(gex.kingStrike, spot), flowVote(callPct)],
              gex.kingStrike,
            );

            const rvSeries = realizedVolSeries(closes, 30);
            const currentRv = rvSeries.length > 0 ? rvSeries[rvSeries.length - 1] : null;
            const ivRank = currentRv != null ? rankWithin(rvSeries, currentRv) : null;

            const nearExp = chain.quotes.reduce((a, b) => (b.dte < a.dte ? b : a)).expiration;
            const earnings = await earningsForTicker({
              ticker: sym.ticker, expiration: nearExp, frontSkew: null, now,
            });

            const cands = buildSpreads({
              ticker: sym.ticker, spot, quotes: chain.quotes, preset, ivRank, earnings,
              fallbackIv: currentRv != null ? currentRv / 100 : 0.4,
              ctx, supports: levels.supports, resistances: levels.resistances,
              now,
            });
            all.push(...cands);
            contexto.set(sym.ticker, {
              ctx, supports: levels.supports, resistances: levels.resistances,
              spot, ivRank, callPct, earnings,
            });
            send({
              type: "step",
              label: `${sym.ticker}: ${cands.filter((c) => !c.blocked).length} estructuras · ${ctx.bias}`,
            });
          } catch {
            failed++;
            send({ type: "step", label: `${sym.ticker}: error` });
          }
        });

        // ── Tercera señal: noticias, solo donde cambian algo ──
        //
        // Se gastan las peticiones en los tickers con más convicción de GEX y
        // flujo: si el sesgo es tibio, una noticia no lo va a inclinar lo
        // suficiente como para mover el ranking, y Massive tiene un cupo muy
        // corto. Re-puntuar es barato porque `scoreSpread` es puro y no
        // necesita volver a pedir la cadena.
        const objetivos = [...contexto.entries()]
          .filter(([t, c]) => c.ctx.strength >= NEWS_MIN_STRENGTH && all.some((x) => x.ticker === t && !x.blocked))
          .sort((a, b) => b[1].ctx.strength - a[1].ctx.strength)
          .slice(0, NEWS_BUDGET);

        if (objetivos.length > 0) {
          send({ type: "step", label: `Confirmando con noticias en ${objetivos.length} tickers…` });
          for (const [ticker, c] of objetivos) {
            try {
              const items = await fetchTickerNews(ticker, 12);
              const nb = newsBias(items, now);
              const nuevo = combineBias(
                [gexVote(c.ctx.magnet, c.spot), flowVote(c.callPct), newsVote(nb)],
                c.ctx.magnet,
              );
              for (const cand of all) {
                if (cand.ticker !== ticker || cand.blocked || !cand.metrics) continue;
                cand.score = scoreSpread({
                  kind: cand.kind, metrics: cand.metrics, legs: cand.legs,
                  ivRank: c.ivRank, earnings: c.earnings, spot: c.spot,
                  ctx: nuevo, supports: c.supports, resistances: c.resistances,
                });
              }
            } catch {
              // Sin noticias para este ticker: se queda con el sesgo de GEX+flujo.
            }
          }
        }

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
