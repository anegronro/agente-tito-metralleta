// Selector de proveedor de datos de mercado. Una sola verdad para todas las rutas.
//
// Reemplaza a `optionChain.ts`, que solo cubría la cadena. Ahora también decide de
// dónde salen las BARRAS, y ese cambio no es cosmético:
//
// El plan gratuito de Massive corta a las **5 peticiones por minuto** (medido:
// la 5ª devuelve 429). Una carga de ticker hace más de cinco llamadas a Massive
// —dos de `fetchCompany`, las de `/api/bars` de SimpleChart y ProWallsCard,
// noticias, e histórico—, así que el 429 caía casi siempre en el histórico.
// Con Schwab sirviendo la cadena Y las barras, Massive queda solo para empresa
// y noticias, muy por debajo del límite.

import {
  fetchBars,
  fetchDailyBars,
  fetchCompany,
  fetchOptionChain,
  fetchWheelChain,
  type ChainResult,
  type FetchProgress,
  type WheelChainResult,
} from "./massive";
import {
  fetchBarsSchwab,
  fetchDailyBarsSchwab,
  fetchOptionChainSchwab,
  fetchQuoteSchwab,
  fetchWheelChainSchwab,
} from "./schwab";
import type { CompanyInfo, DailyBar, TfBar } from "./types";

export type MarketDataProvider = "schwab" | "massive";

/**
 * Decide el proveedor. El override explícito manda; si no, Schwab cuando esté
 * configurado. Se mira solo la App Key: el guion de auth valida el resto, y si
 * falta la sesión, `schwab.ts` lo dice con el comando exacto para arreglarlo.
 */
export function activeProvider(): MarketDataProvider {
  const forced = process.env.OPTIONS_PROVIDER?.trim().toLowerCase();
  if (forced === "schwab" || forced === "massive") return forced;
  return process.env.SCHWAB_APP_KEY ? "schwab" : "massive";
}

/** Cadena de opciones del proveedor activo. Misma forma sea cual sea. */
export function fetchChain(
  ticker: string,
  progress: FetchProgress = {},
): Promise<ChainResult> {
  return activeProvider() === "schwab"
    ? fetchOptionChainSchwab(ticker, progress)
    : fetchOptionChain(ticker, progress);
}

/**
 * Ficha de empresa COMPUESTA, y por buenas razones:
 *
 * · Los datos de referencia (nombre, logo, empleados, sector) salen de Massive,
 *   que sí los sirve con este plan y es una sola llamada por ticker.
 * · Las estadísticas de PRECIO salen de Schwab, porque el snapshot de Massive
 *   (`/v2/snapshot/.../stocks/`) devuelve NOT_AUTHORIZED — verificado. Por eso
 *   `company.price` venía `null` y el spot caía al de la cadena.
 *
 * Si Schwab falla, se conservan los datos de Massive y viceversa: una ficha
 * incompleta es mejor que una pantalla en blanco.
 */
export async function fetchCompanyInfo(ticker: string): Promise<CompanyInfo> {
  const base = await fetchCompany(ticker);
  if (activeProvider() !== "schwab") return base;

  const q = await fetchQuoteSchwab(ticker).catch(() => null);
  if (!q) return base;

  return {
    ...base,
    name: base.name ?? q.description,
    exchange: base.exchange ?? q.exchangeName,
    price: q.price ?? base.price,
    change: q.change ?? base.change,
    changePercent: q.changePercent ?? base.changePercent,
    dayOpen: q.dayOpen ?? base.dayOpen,
    dayHigh: q.dayHigh ?? base.dayHigh,
    dayLow: q.dayLow ?? base.dayLow,
    dayVolume: q.dayVolume ?? base.dayVolume,
    prevClose: q.prevClose ?? base.prevClose,
  };
}

/** Cadena de puts para la Wheel, del proveedor activo. */
export function fetchWheel(
  ticker: string,
  opts: { dteMin: number; dteMax: number; now?: Date },
): Promise<WheelChainResult> {
  return activeProvider() === "schwab"
    ? fetchWheelChainSchwab(ticker, opts)
    : fetchWheelChain(ticker, opts);
}

/** Barras diarias ("YYYY-MM-DD") del proveedor activo. */
export function fetchDaily(ticker: string, days = 365): Promise<DailyBar[]> {
  return activeProvider() === "schwab"
    ? fetchDailyBarsSchwab(ticker, days)
    : fetchDailyBars(ticker, days);
}

/** Barras con tiempo UNIX en segundos (diario o intradía) del proveedor activo. */
export function fetchTfBars(
  ticker: string,
  multiplier: number,
  timespan: "day" | "minute",
  days: number,
): Promise<TfBar[]> {
  return activeProvider() === "schwab"
    ? fetchBarsSchwab(ticker, multiplier, timespan, days)
    : fetchBars(ticker, multiplier, timespan, days);
}
