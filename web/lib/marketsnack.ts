// Cliente del API interno de MarketSnack (app.marketsnack.com). Solo servidor.
// Auth por cookie de sesión (MARKETSNACK_COOKIE en .env.local). Ver SCOREDCARD/Scoredcard.md.

import type { RawTrade } from "./flow";
import { loadSession, parseSetCookie, saveSession, withLiveSession } from "./msSession";

const BASE_URL = "https://app.marketsnack.com";

export class MarketSnackError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "MarketSnackError";
    this.status = status;
  }
}

function cookie(): string {
  const c = process.env.MARKETSNACK_COOKIE;
  if (!c || !c.trim()) {
    throw new MarketSnackError(
      "Falta MARKETSNACK_COOKIE en .env.local. Copia tu cookie de sesión de app.marketsnack.com.",
    );
  }
  return c.trim();
}

export interface FetchFlowOptions {
  /**
   * Preset del propio MarketSnack (`0dte-momentum-spike`, `cheap-lotto-bets`…).
   * Son umbrales suyos sobre campos crudos —premium, tamaño, DTE, delta—, no
   * hay nada agregado por strike detrás: comprobado que la respuesta no trae
   * ningún campo de GEX.
   */
  preset?: string;
  period?: string; // "1d" | "5d" | "1m"
  maxPages?: number;
  minPremium?: number; // filtro server-side: solo trades con premium ≥ este valor ($)
  targetDays?: number; // detener la paginación al cubrir N días hacia atrás
  onPage?: (page: number, accumulated: number) => void | Promise<void>;
}

export interface FlowResult {
  trades: RawTrade[];
  pages: number;
  truncated: boolean;
}

/**
 * Descarga el flujo (Time & Sales) de un ticker desde MarketSnack, paginando por
 * `next_page_token`. Endpoint: /api/flow_feed?filter[scope]=all&filter[symbol][]=TICKER&period=…
 */
export async function fetchFlow(
  ticker: string,
  opts: FetchFlowOptions = {},
): Promise<FlowResult> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new MarketSnackError("Ticker vacío.");
  return paginate(clean, opts);
}

/**
 * Igual que `fetchFlow` pero SIN filtro de símbolo: devuelve el flujo de todo el
 * mercado. Es lo que alimenta el screener de /ideas — el piso de premium
 * (`minPremium`) filtra server-side, así que el payload se mantiene chico.
 */
export async function fetchMarketFlow(opts: FetchFlowOptions = {}): Promise<FlowResult> {
  return paginate(null, opts);
}

/**
 * Flujo de un preset de MarketSnack, de todo el mercado.
 *
 * OJO: `filter[scope]` es OBLIGATORIO aunque mandes preset. Sin él la API
 * responde **422** con `{"error":{"filter":{"scope":["is missing"]}}}` y el
 * mensaje no menciona el preset, así que parece que el slug está mal cuando
 * el problema es otro. Me costó una ronda.
 */
export async function fetchPresetFlow(
  preset: string,
  opts: FetchFlowOptions = {},
): Promise<FlowResult> {
  return paginate(null, { ...opts, preset });
}

/** Cuerpo de paginación compartido. `symbol === null` → escaneo de todo el mercado. */
async function paginate(
  symbol: string | null,
  opts: FetchFlowOptions = {},
): Promise<FlowResult> {
  const clean = symbol;
  const period = opts.period ?? "5d";
  const maxPages = opts.maxPages ?? 10;
  // La sesión VIVA manda sobre la de .env.local: MarketSnack emite una cookie
  // nueva en cada respuesta y reenviar siempre la fija hacía que el reloj de
  // caducidad no se reiniciara nunca. Ver msSession.ts.
  let cookieHeader = withLiveSession(cookie(), await loadSession());

  const trades: RawTrade[] = [];
  let token: string | null = null;
  let page = 0;
  let truncated = false;
  // La paginación del feed camina hacia atrás en el tiempo; con targetDays paramos
  // al cubrir la ventana pedida.
  const cutoffMs = opts.targetDays ? Date.now() - opts.targetDays * 86_400_000 : null;

  do {
    page += 1;
    const params = new URLSearchParams();
    params.set("filter[scope]", "all");
    if (opts.preset) params.set("filter[preset]", opts.preset);
    if (clean) params.append("filter[symbol][]", clean);
    params.set("period", period);
    if (opts.minPremium && opts.minPremium > 0) {
      params.set("filter[premium][gte]", String(Math.floor(opts.minPremium)));
    }
    if (token) params.set("next_page_token", token);
    const url = `${BASE_URL}/api/flow_feed?${params.toString()}`;

    const res = await fetch(url, {
      headers: { Accept: "application/json", Cookie: cookieHeader },
      cache: "no-store",
      redirect: "manual",
    });

    // Rails rota la sesión en CADA respuesta: se guarda y se usa ya en la
    // página siguiente de este mismo escaneo.
    const rotada = parseSetCookie(res.headers.get("set-cookie"));
    if (rotada) {
      await saveSession(rotada);
      cookieHeader = withLiveSession(cookieHeader, rotada);
    }

    // Sesión inválida/expirada → MarketSnack redirige a /login o responde 401.
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
      throw new MarketSnackError(
        "Sesión de MarketSnack inválida o expirada. Actualiza MARKETSNACK_COOKIE en .env.local.",
        res.status,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new MarketSnackError(
        `MarketSnack respondió ${res.status}. ${body.slice(0, 200)}`.trim(),
        res.status,
      );
    }

    const json: { list?: RawTrade[]; meta?: { next_page_token?: string } } =
      await res.json();
    const list = json.list ?? [];
    trades.push(...list);
    await opts.onPage?.(page, trades.length);

    token = json.meta?.next_page_token ?? null;
    if (list.length === 0) break;
    if (cutoffMs != null) {
      const oldest = list[list.length - 1]?.timestamp;
      if (oldest && Date.parse(oldest) < cutoffMs) break; // ventana cubierta
    }
    if (page >= maxPages) {
      truncated = Boolean(token);
      break;
    }
  } while (token);

  return { trades, pages: page, truncated };
}
