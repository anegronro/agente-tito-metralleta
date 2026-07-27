// Cliente de Charles Schwab (Trader API — Market Data). Solo se usa en el servidor.
//
// Existe porque el plan de Massive devuelve NOT_AUTHORIZED en el option chain
// (`/v3/snapshot/options/`). Schwab sirve la cadena completa Y ADEMÁS los griegos
// e IV por contrato, que Massive no da en ningún caso — hoy se estiman con
// Black-Scholes en `blackScholes.ts` y se anclan a MarketSnack en `gex.ts`.
//
// Diseñado como ADAPTADOR: `fetchOptionChainSchwab` devuelve el mismo `ChainResult`
// que `massive.fetchOptionChain`, así que nada aguas abajo cambia. Los griegos
// viajan como campos opcionales de `RawContract` — quien no los mire, no se entera.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DailyBar, RawContract, TfBar } from "./types";
import type {
  ChainResult,
  FetchProgress,
  WheelChainQuote,
  WheelChainResult,
} from "./massive";
import { marketDateStr } from "./occ";

const BASE_URL = "https://api.schwabapi.com";
const TOKEN_FILE = join(process.cwd(), "data", "schwab-tokens.json");

/** Margen de seguridad: se renueva antes de que caduque de verdad. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Escalera de reintentos para cadenas que no caben en la pasarela de Schwab.
 *
 * SPY y SPX tienen vencimientos DIARIOS y miles de strikes; pedir la cadena
 * entera devuelve 502 "Body buffer overflow" (TooBigBody) — un límite de la
 * pasarela, no un fallo nuestro. `strikeCount` por sí solo NO basta: recorta
 * strikes pero no vencimientos, y el 502 persiste.
 *
 * Los valores están MEDIDOS contra la API (2026-07-27), no estimados:
 *   SPY  sin límite → 502 · strikeCount=200 → 502 · +120d → OK (7066 contratos)
 *   $SPX sin límite → 502 · strikeCount=200 → 502 · 200+120d → 502
 *                   · 100+120d → OK (7480 contratos)
 * Se toma el primer escalón que responda, así un subyacente normal no pierde
 * nada y uno gigante degrada en vez de fallar.
 */
const CHAIN_FALLBACKS: { strikeCount: number; days: number }[] = [
  { strikeCount: 200, days: 120 },
  { strikeCount: 100, days: 120 },
  { strikeCount: 60, days: 90 },
];

/**
 * Índices: Schwab los nombra con `$` delante ($SPX, $NDX…), pero la app y el
 * usuario escriben "SPX". Sin esta traducción, un índice devuelve vacío sin
 * explicar por qué — el mismo tipo de fallo mudo que el strike sin 4 decimales.
 */
const INDICES: Record<string, string> = {
  SPX: "$SPX",
  NDX: "$NDX",
  RUT: "$RUT",
  VIX: "$VIX",
  DJI: "$DJI",
};

/** Normaliza el símbolo al dialecto de Schwab. */
export function schwabSymbol(ticker: string): string {
  const clean = ticker.trim().toUpperCase();
  return INDICES[clean] ?? clean;
}

export class SchwabError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "SchwabError";
    this.status = status;
  }
}

interface StoredTokens {
  /** Opcional: en el VPS (modo seguidor) el archivo llega SIN refresh token,
   *  a propósito — esa máquina no debe poder renovar nada por su cuenta. */
  refresh_token?: string;
  access_token?: string | null;
  obtained_at?: string;
  expires_in?: number | null;
}

// Caché en memoria del access token. El refresh vive en disco; el access no
// merece escribirse en cada renovación (dura ~30 min y el proceso lo reusa).
let cachedAccess: { token: string; expiresAt: number } | null = null;

/** `requireRefresh: false` para el modo seguidor, que solo necesita el access. */
function readTokens({ requireRefresh = true } = {}): StoredTokens {
  let raw: string;
  try {
    raw = readFileSync(TOKEN_FILE, "utf8");
  } catch {
    throw new SchwabError(
      "No hay sesión de Schwab. Corre: node scripts/schwab-auth.mjs",
    );
  }
  const t = JSON.parse(raw) as StoredTokens;
  if (requireRefresh && !t.refresh_token) {
    throw new SchwabError(
      "El archivo de tokens de Schwab no tiene refresh_token. Corre: node scripts/schwab-auth.mjs",
    );
  }
  return t;
}

function credentials(): { key: string; secret: string } {
  const key = process.env.SCHWAB_APP_KEY;
  const secret = process.env.SCHWAB_APP_SECRET;
  if (!key || !secret) {
    throw new SchwabError(
      "Faltan SCHWAB_APP_KEY / SCHWAB_APP_SECRET en el entorno (.env.local).",
    );
  }
  return { key, secret };
}

/**
 * Devuelve un access token vivo, renovándolo con el refresh si hace falta.
 *
 * El refresh de Schwab caduca (días, no meses) y no se puede renovar solo: cuando
 * muere, hay que rehacer el login del navegador. Por eso el error lo dice con el
 * comando exacto en vez de un 401 pelado.
 */
async function accessToken(): Promise<string> {
  if (cachedAccess && Date.now() < cachedAccess.expiresAt - EXPIRY_MARGIN_MS) {
    return cachedAccess.token;
  }

  // ── Modo SEGUIDOR (el VPS) ────────────────────────────────────────────────
  // El refresh token de Schwab ROTA al usarse: si el Mac y el VPS renovaran
  // cada uno por su cuenta, el segundo invalidaría el token del primero y la
  // sesión moriría en un sitio u otro sin explicación.
  //
  // Por eso hay un solo DUEÑO (el Mac), que renueva y empuja el access token
  // por Tailscale. Aquí solo se lee. Nunca se renueva, y el refresh token ni
  // siquiera hace falta que exista en esta máquina.
  if (process.env.SCHWAB_ROLE === "follower") {
    const t = readTokens({ requireRefresh: false });
    const nacido = t.obtained_at ? Date.parse(t.obtained_at) : 0;
    const caduca = nacido + (t.expires_in ?? 1800) * 1000;
    if (!t.access_token || Date.now() >= caduca - EXPIRY_MARGIN_MS) {
      throw new SchwabError(
        "El access token de Schwab llegó caducado. Lo empuja el Mac: revisa que " +
          "com.tito.schwab-push esté vivo (launchctl list | grep schwab-push).",
      );
    }
    cachedAccess = { token: t.access_token, expiresAt: caduca };
    return cachedAccess.token;
  }

  const { key, secret } = credentials();
  const stored = readTokens();
  // readTokens() ya lo exige en modo dueño; esto solo estrecha el tipo.
  const refresh = stored.refresh_token as string;

  const res = await fetch(`${BASE_URL}/v1/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new SchwabError(
      "La sesión de Schwab expiró o fue revocada. Vuelve a autorizar con: " +
        "node scripts/schwab-auth.mjs",
      res.status,
    );
  }

  const tok = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };
  if (!tok.access_token) {
    throw new SchwabError("Schwab no devolvió access_token al renovar.");
  }

  // Schwab puede ROTAR el refresh al renovar. Si llega uno nuevo y no se guarda,
  // la sesión muere en cuanto caduque el viejo.
  if (tok.refresh_token && tok.refresh_token !== refresh) {
    try {
      writeFileSync(
        TOKEN_FILE,
        JSON.stringify(
          { ...stored, refresh_token: tok.refresh_token, obtained_at: new Date().toISOString() },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    } catch {
      /* si no se puede escribir, seguimos: el token en memoria vale para esta sesión */
    }
  }

  cachedAccess = {
    token: tok.access_token,
    expiresAt: Date.now() + (tok.expires_in ?? 1800) * 1000,
  };
  return cachedAccess.token;
}

// ---------------------------------------------------------------------------
// Forma real de la respuesta, verificada contra la API el 2026-07-27 con NVDA.
// ---------------------------------------------------------------------------

interface SchwabContract {
  putCall?: string;
  symbol?: string;
  bid?: number;
  ask?: number;
  last?: number;
  mark?: number;
  closePrice?: number;
  totalVolume?: number;
  openInterest?: number;
  /** OJO: viene en PORCENTAJE (50.301 = 50.3%), no en decimal. */
  volatility?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
  strikePrice?: number;
  /** Datetime ISO completo, no una fecha suelta: "2026-07-27T20:00:00.000+00:00". */
  expirationDate?: string;
  /** Días al vencimiento ya calculados por Schwab. */
  daysToExpiration?: number;
  multiplier?: number;
}

interface ChainsResponse {
  status?: string;
  symbol?: string;
  underlyingPrice?: number;
  numberOfContracts?: number;
  isChainTruncated?: boolean;
  callExpDateMap?: Record<string, Record<string, SchwabContract[]>>;
  putExpDateMap?: Record<string, Record<string, SchwabContract[]>>;
}

/** "2026-07-27T20:00:00.000+00:00" → "2026-07-27". El motor espera fecha suelta. */
function toDateOnly(iso: string | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1] : "";
}

/**
 * Traduce un contrato de Schwab al `RawContract` que consume todo el motor.
 *
 * `day.close` recibe `closePrice` y `last_trade.price` recibe `last ?? mark`,
 * respetando la cascada que ya usa `contractPrice()` en compute.ts.
 */
export function toRawContract(
  c: SchwabContract,
  underlyingTicker: string,
  underlyingPrice: number | null,
): RawContract {
  return {
    day: {
      volume: c.totalVolume,
      close: c.closePrice,
    },
    details: {
      contract_type: c.putCall?.toLowerCase(),
      expiration_date: toDateOnly(c.expirationDate),
      strike_price: c.strikePrice,
      shares_per_contract: c.multiplier ?? 100,
      // El símbolo de Schwab trae relleno de espacios ("NVDA  260727C00197500").
      // Solo se usa como clave de React y en la leyenda del gráfico — nadie lo
      // parsea— pero se normaliza para que no chirríe en la UI.
      ticker: c.symbol?.replace(/\s+/g, " ").trim(),
    },
    last_trade: { price: c.last ?? c.mark },
    open_interest: c.openInterest,
    underlying_asset: {
      price: underlyingPrice ?? undefined,
      ticker: underlyingTicker,
    },
    // Extras de Schwab que Massive nunca da. Opcionales a propósito: quien no
    // los mire sigue funcionando igual.
    greeks: {
      delta: c.delta,
      gamma: c.gamma,
      theta: c.theta,
      vega: c.vega,
      rho: c.rho,
    },
    // Normalizada a DECIMAL para igualar el criterio del resto del motor.
    // Schwab la manda en porcentaje; ivcontext.ts multiplica por 100 lo que
    // recibe, así que entregarla en porcentaje daría 5030%.
    implied_volatility:
      typeof c.volatility === "number" ? c.volatility / 100 : undefined,
    bid: c.bid,
    ask: c.ask,
  };
}

/** Aplana los mapas anidados expiración → strike → contratos[]. */
function flatten(
  map: Record<string, Record<string, SchwabContract[]>> | undefined,
  ticker: string,
  underlyingPrice: number | null,
  out: RawContract[],
): void {
  if (!map) return;
  for (const porStrike of Object.values(map)) {
    for (const contratos of Object.values(porStrike)) {
      for (const c of contratos) out.push(toRawContract(c, ticker, underlyingPrice));
    }
  }
}

/**
 * Descarga la option chain completa de un ticker desde Schwab.
 *
 * A diferencia de Massive no hay paginación por `next_url`: Schwab devuelve la
 * cadena entera en una respuesta, y avisa con `isChainTruncated` si la recortó.
 * Por eso `pages` es siempre 1 — se mantiene en el resultado solo para que la
 * forma sea idéntica a la de Massive y las rutas no tengan que distinguir.
 */
export async function fetchOptionChainSchwab(
  ticker: string,
  progress: FetchProgress = {},
): Promise<ChainResult> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new SchwabError("Ticker vacío.");

  const token = await accessToken();
  const base =
    `${BASE_URL}/marketdata/v1/chains?symbol=${encodeURIComponent(schwabSymbol(clean))}` +
    `&contractType=ALL`;

  const pedir = (extra = "") =>
    fetch(base + extra, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });

  const esDemasiadoGrande = async (r: Response) => {
    if (r.status !== 502) return false;
    return /TooBigBody|buffer overflow/i.test(await r.clone().text().catch(() => ""));
  };

  let res = await pedir();
  let recortada = false;

  if (await esDemasiadoGrande(res)) {
    const hoy = Date.now();
    const fecha = (d: number) => new Date(hoy + d * 864e5).toISOString().slice(0, 10);
    for (const paso of CHAIN_FALLBACKS) {
      res = await pedir(
        `&strikeCount=${paso.strikeCount}&fromDate=${fecha(0)}&toDate=${fecha(paso.days)}`,
      );
      if (!(await esDemasiadoGrande(res))) {
        recortada = true;
        break;
      }
    }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SchwabError(describeStatus(res.status, clean, body), res.status);
  }

  const json = (await res.json()) as ChainsResponse;

  // Schwab responde 200 con status:"FAILED" para símbolos que no existen o no
  // son optionables. Un 200 NO es prueba de éxito — hay que mirar el campo.
  if (json.status && json.status !== "SUCCESS") {
    throw new SchwabError(
      `Schwab no devolvió cadena para ${clean} (status: ${json.status}). ` +
        "¿Es un símbolo optionable?",
    );
  }

  const underlyingPrice =
    typeof json.underlyingPrice === "number" ? json.underlyingPrice : null;

  const contracts: RawContract[] = [];
  flatten(json.callExpDateMap, clean, underlyingPrice, contracts);
  flatten(json.putExpDateMap, clean, underlyingPrice, contracts);

  await progress.onPage?.(1, contracts.length);

  return {
    contracts,
    underlyingPrice,
    pages: 1,
    // `recortada` marca que NOSOTROS acotamos la petición para que cupiera;
    // `isChainTruncated` es Schwab diciendo que recortó por su cuenta.
    truncated: recortada || Boolean(json.isChainTruncated),
  };
}

/**
 * Cadena para la Wheel: solo puts, acotada por ventana de vencimiento y ya
 * filtrada a OTM. Misma forma que `massive.fetchWheelChain`.
 *
 * Schwab acepta `fromDate`/`toDate`, así que el recorte lo hace el servidor en
 * vez de traerse la cadena entera. Y trae `daysToExpiration` calculado, que
 * evita repetir aquí el anclaje al día de mercado ET.
 */
export async function fetchWheelChainSchwab(
  ticker: string,
  opts: { dteMin: number; dteMax: number; now?: Date },
): Promise<WheelChainResult> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new SchwabError("Ticker vacío.");
  const now = opts.now ?? new Date();
  const day = 24 * 60 * 60 * 1000;
  // Se ancla en el día de MERCADO (ET), no en UTC: pasadas las ~8 PM ET el día
  // UTC ya saltó y la ventana de vencimientos saldría corrida (ver marketDateStr).
  const todayETMs = Date.parse(`${marketDateStr(now)}T00:00:00Z`);
  const fecha = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  const token = await accessToken();
  const qs = new URLSearchParams({
    symbol: schwabSymbol(clean),
    contractType: "PUT",
    fromDate: fecha(todayETMs + opts.dteMin * day),
    toDate: fecha(todayETMs + opts.dteMax * day),
  });

  const res = await fetch(`${BASE_URL}/marketdata/v1/chains?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SchwabError(describeStatus(res.status, clean, body), res.status);
  }

  const json = (await res.json()) as ChainsResponse;
  if (json.status && json.status !== "SUCCESS") {
    throw new SchwabError(
      `Schwab no devolvió cadena para ${clean} (status: ${json.status}).`,
    );
  }

  const spot = typeof json.underlyingPrice === "number" ? json.underlyingPrice : null;
  const quotes: WheelChainQuote[] = [];

  for (const porStrike of Object.values(json.putExpDateMap ?? {})) {
    for (const contratos of Object.values(porStrike)) {
      for (const c of contratos) {
        const strike = c.strikePrice;
        const expiration = toDateOnly(c.expirationDate);
        if (!(strike != null && strike > 0) || !expiration) continue;
        quotes.push({
          strike,
          expiration,
          dte:
            typeof c.daysToExpiration === "number"
              ? c.daysToExpiration
              : Math.round((Date.parse(`${expiration}T00:00:00Z`) - todayETMs) / day),
          bid: c.bid ?? null,
          ask: c.ask ?? null,
          lastTrade: c.last ?? null,
          openInterest: c.openInterest ?? 0,
        });
      }
    }
  }

  // Solo puts OTM: un put ITM no es un cash-secured put de Wheel, es otra cosa.
  const otm = spot != null ? quotes.filter((q) => q.strike <= spot) : quotes;
  return { spot, quotes: otm };
}

// ---------------------------------------------------------------------------
// Histórico de precios. Verificado contra la API el 2026-07-27 con NVDA:
// { symbol, empty, candles: [{ open, high, low, close, volume, datetime }] },
// donde `datetime` es epoch en MILISEGUNDOS (252 velas para un año).
//
// Existe para sacar a Massive del camino crítico: su plan gratuito corta a las
// 5 peticiones/minuto, y una carga de ticker hace más de cinco. El 429 llegaba
// justo en el histórico y dejaba la app colgada en silencio.
// ---------------------------------------------------------------------------

interface SchwabCandle {
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  /** Epoch en MILISEGUNDOS, no en segundos. */
  datetime?: number;
}

async function pricehistory(
  ticker: string,
  params: Record<string, string>,
): Promise<SchwabCandle[]> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new SchwabError("Ticker vacío.");
  const token = await accessToken();
  const qs = new URLSearchParams({
    symbol: schwabSymbol(clean),
    needExtendedHoursData: "false",
    ...params,
  });
  const res = await fetch(`${BASE_URL}/marketdata/v1/pricehistory?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SchwabError(describeStatus(res.status, clean, body), res.status);
  }
  const json = (await res.json()) as { empty?: boolean; candles?: SchwabCandle[] };
  // `empty: true` es la forma que tiene Schwab de decir "sin datos" con un 200.
  if (json.empty || !Array.isArray(json.candles)) return [];
  return json.candles;
}

/** "YYYY-MM-DD" de un epoch en ms. */
function dayStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Barras diarias del subyacente (fecha como "YYYY-MM-DD"). */
export async function fetchDailyBarsSchwab(ticker: string, days = 365): Promise<DailyBar[]> {
  // Schwab no acepta un rango en días sueltos para el diario: se pide por
  // periodType=year y se recorta después.
  const years = Math.max(1, Math.ceil(days / 365));
  const candles = await pricehistory(ticker, {
    periodType: "year",
    period: String(Math.min(years, 20)),
    frequencyType: "daily",
    frequency: "1",
  });
  const desde = Date.now() - days * 24 * 60 * 60 * 1000;
  return candles
    .filter((c) => typeof c.datetime === "number" && c.datetime >= desde)
    .map((c) => ({
      time: dayStr(c.datetime!),
      open: c.open ?? 0,
      high: c.high ?? 0,
      low: c.low ?? 0,
      close: c.close ?? 0,
    }));
}

/** Barras diarias o intradía con tiempo UNIX en SEGUNDOS (lo que pide TfBar). */
export async function fetchBarsSchwab(
  ticker: string,
  multiplier: number,
  timespan: "day" | "minute",
  days: number,
): Promise<TfBar[]> {
  const params =
    timespan === "day"
      ? {
          periodType: "year",
          period: String(Math.min(Math.max(1, Math.ceil(days / 365)), 20)),
          frequencyType: "daily",
          frequency: String(multiplier),
        }
      : {
          // El intradía de Schwab se pide por días, y solo admite 1/5/10/15/30 min.
          periodType: "day",
          period: String(Math.min(Math.max(1, days), 10)),
          frequencyType: "minute",
          frequency: String([1, 5, 10, 15, 30].includes(multiplier) ? multiplier : 1),
        };
  const candles = await pricehistory(ticker, params);
  const desde = Date.now() - days * 24 * 60 * 60 * 1000;
  return candles
    .filter((c) => typeof c.datetime === "number" && c.datetime >= desde)
    .map((c) => ({
      time: Math.floor(c.datetime! / 1000), // ms → s
      open: c.open ?? 0,
      high: c.high ?? 0,
      low: c.low ?? 0,
      close: c.close ?? 0,
    }));
}

/** Estadísticas de precio del subyacente. Sustituye al snapshot de Massive,
 *  que devuelve NOT_AUTHORIZED con el plan actual (por eso `price` salía null). */
export interface SchwabQuote {
  price: number | null;
  change: number | null;
  changePercent: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  dayVolume: number | null;
  prevClose: number | null;
  description: string | null;
  exchangeName: string | null;
}

export async function fetchQuoteSchwab(ticker: string): Promise<SchwabQuote | null> {
  const sym = schwabSymbol(ticker);
  if (!sym) return null;
  const token = await accessToken();
  const res = await fetch(
    `${BASE_URL}/marketdata/v1/quotes?symbols=${encodeURIComponent(sym)}`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SchwabError(describeStatus(res.status, sym, body), res.status);
  }
  const json = (await res.json()) as Record<
    string,
    {
      quote?: Record<string, number>;
      reference?: { description?: string; exchangeName?: string };
    }
  >;
  const entry = json[sym] ?? Object.values(json)[0];
  if (!entry?.quote) return null;
  const q = entry.quote;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    price: num(q.lastPrice) ?? num(q.mark) ?? num(q.closePrice),
    change: num(q.netChange),
    changePercent: num(q.netPercentChange),
    dayOpen: num(q.openPrice),
    dayHigh: num(q.highPrice),
    dayLow: num(q.lowPrice),
    dayVolume: num(q.totalVolume),
    prevClose: num(q.closePrice),
    description: entry.reference?.description ?? null,
    exchangeName: entry.reference?.exchangeName ?? null,
  };
}

function describeStatus(status: number, ticker: string, body: string): string {
  if (status === 401) {
    return "Schwab rechazó las credenciales. Vuelve a autorizar: node scripts/schwab-auth.mjs";
  }
  if (status === 404) return `Schwab no conoce el símbolo ${ticker}.`;
  if (status === 429) {
    return "Schwab está limitando las peticiones (429). Espera un momento.";
  }
  return `Schwab devolvió HTTP ${status}. ${body.slice(0, 200)}`;
}
