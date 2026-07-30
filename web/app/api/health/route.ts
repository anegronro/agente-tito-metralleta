// GET /api/health — ¿están vivas las fuentes de datos?
//
// POR QUÉ EXISTE: la cookie de MarketSnack caduca cada pocos días y hasta ahora
// la forma de enterarse era abrir /ideas y encontrársela rota. Esto lo dice en
// la cabecera de cualquier página, antes de que la busques.
//
// Las sondas son BARATAS a propósito: una página de flujo con el premium al
// máximo (devuelve casi nada) y el precio de SPY. Y van con caché de 60s, así
// que abrir cinco pestañas no son cinco llamadas.

import { fetchMarketFlow, MarketSnackError } from "@/lib/marketsnack";
import { sessionAge } from "@/lib/msSession";
import { fetchQuoteSchwab } from "@/lib/schwab";
import { activeProvider } from "@/lib/marketData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type SourceState = "ok" | "caducado" | "error" | "no_aplica";

export interface SourceHealth {
  state: SourceState;
  detail: string;
  /** Qué hacer para arreglarlo. Vacío si no hay nada que hacer. */
  fix?: string;
}

export interface HealthReport {
  marketsnack: SourceHealth;
  schwab: SourceHealth;
  checkedAt: string;
}

const CACHE_MS = 60_000;
let cache: { report: HealthReport; at: number } | null = null;

async function checkMarketSnack(): Promise<SourceHealth> {
  try {
    // Premium altísimo + 1 página: la respuesta es diminuta y solo nos importa
    // que autentique, no lo que traiga.
    await fetchMarketFlow({ period: "1d", maxPages: 1, minPremium: 50_000_000 });
    const { updatedAt } = await sessionAge();
    return {
      state: "ok",
      detail: updatedAt
        ? `Sesión viva, refrescada ${new Date(updatedAt).toLocaleString("es-ES")}.`
        : "Sesión viva.",
    };
  } catch (err) {
    if (err instanceof MarketSnackError) {
      const caducada = err.status === 401 || err.status === 403 ||
        (err.status != null && err.status >= 300 && err.status < 400);
      return {
        state: caducada ? "caducado" : "error",
        detail: caducada
          ? "La sesión de MarketSnack caducó."
          : `MarketSnack respondió con un error. ${err.message}`,
        fix: caducada
          ? "En app.marketsnack.com abre DevTools → Network → filtro flow_feed → entra en Flow Feed → Request Headers → Cookie, y pégala en MARKETSNACK_COOKIE."
          : undefined,
      };
    }
    return { state: "error", detail: "No se pudo contactar con MarketSnack." };
  }
}

async function checkSchwab(): Promise<SourceHealth> {
  if (activeProvider() !== "schwab") {
    return { state: "no_aplica", detail: "El proveedor activo no es Schwab." };
  }
  try {
    await fetchQuoteSchwab("SPY");
    return { state: "ok", detail: "Sesión viva." };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error desconocido.";
    // En el VPS (SCHWAB_ROLE=follower) el access token lo empuja la Mac cada
    // 15 min; si llega caducado es que la Mac está apagada o el job murió.
    const caducado = /token|caduc|expir/i.test(msg);
    return {
      state: caducado ? "caducado" : "error",
      detail: msg,
      fix: caducado
        ? "Si es el VPS: comprueba que la Mac esté encendida y el job com.tito.schwab-push en exit 0. Si es la Mac: node scripts/schwab-auth.mjs."
        : undefined,
    };
  }
}

export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return Response.json(cache.report, { headers: { "Cache-Control": "no-store" } });
  }

  const [marketsnack, schwab] = await Promise.all([checkMarketSnack(), checkSchwab()]);
  const report: HealthReport = { marketsnack, schwab, checkedAt: new Date().toISOString() };
  cache = { report, at: Date.now() };

  return Response.json(report, { headers: { "Cache-Control": "no-store" } });
}
