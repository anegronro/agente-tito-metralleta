// Criterio de spreads verticales e iron condors: construcción, métricas y score.
//
// PURO — no toca red ni disco. La ruta orquesta I/O; aquí solo se decide.
//
// POR QUÉ EXISTE: un cash-secured put de la Wheel inmoviliza `strike × 100`
// —unos $18.000 en NVDA—. El MISMO trade montado como spread arriesga solo el
// ancho menos el crédito: $500 con alas de $5. Es la misma apuesta direccional
// con el riesgo acotado, y es lo que hace operable una cuenta pequeña.
//
// LA REGLA QUE GOBIERNA TODO ESTE ARCHIVO: **vendes al bid y compras al ask**.
// Un screener que calcula con el mid enseña créditos que no vas a cobrar, y en
// un spread el error se DUPLICA porque cruzas dos horquillas, no una. Todos los
// números de aquí son el peor relleno realista.

import { probAbove, probInBand } from "./expectedMove";
import { liquidityBlock, spreadPctOf, type WheelBlockReason } from "./wheel";

const MULTIPLIER = 100;

// ── Tipos ──────────────────────────────────────────────────────────────

export type OptionKind = "put" | "call";

export type SpreadKind =
  | "put_credit"
  | "call_credit"
  | "put_debit"
  | "call_debit"
  | "iron_condor";

/** Familia: gobierna si la volatilidad cara te conviene o te perjudica. */
export type SpreadFamily = "credito" | "debito";

export function familyOf(kind: SpreadKind): SpreadFamily {
  return kind === "put_debit" || kind === "call_debit" ? "debito" : "credito";
}

export const SPREAD_LABEL: Record<SpreadKind, string> = {
  put_credit: "Put credit spread",
  call_credit: "Call credit spread",
  put_debit: "Put debit spread",
  call_debit: "Call debit spread",
  iron_condor: "Iron condor",
};

/** Qué apuesta hace cada estructura, en llano. Se enseña tal cual en la UI. */
export const SPREAD_THESIS: Record<SpreadKind, string> = {
  put_credit: "Ganas si NO baja de tu strike. Alcista o lateral.",
  call_credit: "Ganas si NO sube de tu strike. Bajista o lateral.",
  put_debit: "Ganas si baja. Apuesta bajista con pérdida limitada a lo que pagas.",
  call_debit: "Ganas si sube. Apuesta alcista con pérdida limitada a lo que pagas.",
  iron_condor: "Ganas si se queda quieto entre las dos alas.",
};

/** Una fila de la cadena ya normalizada. Incluye griegos reales de Schwab. */
export interface SpreadQuote {
  type: OptionKind;
  strike: number;
  expiration: string; // YYYY-MM-DD
  dte: number;
  bid: number | null;
  ask: number | null;
  openInterest: number;
  /** Delta del proveedor. null si no vino. */
  delta: number | null;
  /** IV decimal del proveedor. null si no vino. */
  iv: number | null;
}

export type LegAction = "vender" | "comprar";

export interface Leg {
  action: LegAction;
  type: OptionKind;
  strike: number;
  /** Relleno asumido: bid si vendes, ask si compras. Nunca el mid. */
  price: number;
  delta: number | null;
  openInterest: number;
  spreadPct: number | null;
}

// ── Presets ────────────────────────────────────────────────────────────

export type SpreadPresetId = "conservador" | "balanceado" | "agresivo";

export interface SpreadPreset {
  id: SpreadPresetId;
  label: string;
  /** |delta| del strike VENDIDO en las estructuras de crédito. */
  shortDeltaMin: number;
  shortDeltaMax: number;
  /** |delta| del strike COMPRADO en las de débito: ahí el ancla es el largo. */
  longDeltaMin: number;
  longDeltaMax: number;
  dteMin: number;
  dteMax: number;
  /** Ancho máximo del ala, en $. Es el mando que fija el colateral. */
  maxWidth: number;
  takeProfitPct: number;
  explain: string;
}

export const SPREAD_PRESETS: Record<SpreadPresetId, SpreadPreset> = {
  conservador: {
    id: "conservador", label: "Conservador",
    shortDeltaMin: 0.08, shortDeltaMax: 0.18,
    longDeltaMin: 0.55, longDeltaMax: 0.75,
    dteMin: 30, dteMax: 45, maxWidth: 5, takeProfitPct: 50,
    explain: "Alas estrechas y strikes lejos: arriesgas poco por operación y ganas casi siempre, pero poquito.",
  },
  balanceado: {
    id: "balanceado", label: "Balanceado",
    shortDeltaMin: 0.15, shortDeltaMax: 0.30,
    longDeltaMin: 0.45, longDeltaMax: 0.65,
    dteMin: 30, dteMax: 45, maxWidth: 10, takeProfitPct: 50,
    explain: "El punto medio: crédito decente y probabilidad todavía a tu favor.",
  },
  agresivo: {
    id: "agresivo", label: "Agresivo",
    shortDeltaMin: 0.25, shortDeltaMax: 0.42,
    longDeltaMin: 0.35, longDeltaMax: 0.60,
    dteMin: 7, dteMax: 30, maxWidth: 15, takeProfitPct: 50,
    explain: "Cerca del dinero y a poco plazo: cobras mucho más y pierdes bastante más a menudo.",
  },
};

// ── Relleno y liquidez ─────────────────────────────────────────────────

/** Precio asumido de una pata. Vender → bid; comprar → ask. */
export function fillPrice(q: SpreadQuote, action: LegAction): number | null {
  const raw = action === "vender" ? q.bid : q.ask;
  return raw != null && raw > 0 ? raw : null;
}

export function toLeg(q: SpreadQuote, action: LegAction): Leg | null {
  const price = fillPrice(q, action);
  if (price == null) return null;
  return {
    action, type: q.type, strike: q.strike, price,
    delta: q.delta, openInterest: q.openInterest,
    spreadPct: spreadPctOf(q.bid, q.ask),
  };
}

/**
 * Precio neto por acción. **Positivo = cobras** (crédito); negativo = pagas.
 * Coherente con el relleno pesimista: el crédito sale del bid del corto menos
 * el ask del largo, que es lo peor que te pueden dar.
 */
export function netPrice(legs: Leg[]): number {
  return legs.reduce((acc, l) => acc + (l.action === "vender" ? l.price : -l.price), 0);
}

/**
 * Bloqueo por liquidez: manda la PEOR pata. Un spread no es más líquido que su
 * lado más flojo — si no puedes salir de una pata, tienes la posición coja y el
 * riesgo deja de estar acotado, que era justo el motivo de montarla.
 */
export function legBlock(quotes: SpreadQuote[]): WheelBlockReason | null {
  for (const q of quotes) {
    const reason = liquidityBlock({ bid: q.bid, ask: q.ask, openInterest: q.openInterest });
    if (reason) return reason;
  }
  return null;
}

// ── Métricas ───────────────────────────────────────────────────────────

export interface SpreadMetrics {
  /** Neto por acción: + cobras, − pagas. */
  net: number;
  /** $ que cobras al abrir. 0 en las de débito. */
  credit: number;
  /** $ que pagas al abrir. 0 en las de crédito. */
  debit: number;
  /** Ancho del ala en $ (el más ancho, en un condor). */
  width: number;
  maxProfit: number;
  /** Pérdida máxima en $. **Es el colateral**: lo que necesitas tener. */
  maxLoss: number;
  /** Uno en las verticales, dos en el condor. */
  breakevens: number[];
  /** maxProfit / maxLoss en %. Lo que ganas por cada $ arriesgado. */
  returnOnRisk: number;
  /** El mismo retorno llevado a un año, en %. */
  annualizedPct: number;
  /** Probabilidad de acabar en beneficio, 0-100. */
  pop: number;
}

/**
 * Métricas de una vertical ya montada.
 *
 * `anchor` es el strike que define el breakeven: el VENDIDO en las de crédito
 * (es el que te pueden ejercer) y el COMPRADO en las de débito (es el que tiene
 * que superar el precio para que ganes).
 */
export function verticalMetrics(input: {
  kind: Exclude<SpreadKind, "iron_condor">;
  legs: Leg[];
  spot: number;
  dte: number;
  /** IV ATM del vencimiento — ver la nota de `atmIvByExpiry`. */
  iv: number;
}): SpreadMetrics | null {
  const { kind, legs, spot, dte, iv } = input;
  if (legs.length !== 2) return null;

  const strikes = legs.map((l) => l.strike);
  const width = Math.abs(strikes[0] - strikes[1]);
  if (!(width > 0)) return null;

  const net = netPrice(legs);
  const esCredito = familyOf(kind) === "credito";

  // Datos imposibles: un crédito que iguala el ancho sería dinero gratis, y un
  // débito que lo supera no puede ganar ni en el mejor caso. Ambos salen de
  // horquillas rotas, no de oportunidades.
  if (esCredito && !(net > 0 && net < width)) return null;
  if (!esCredito && !(net < 0 && -net < width)) return null;

  const credit = esCredito ? net * MULTIPLIER : 0;
  const debit = esCredito ? 0 : -net * MULTIPLIER;
  const maxProfit = esCredito ? net * MULTIPLIER : (width + net) * MULTIPLIER;
  const maxLoss = esCredito ? (width - net) * MULTIPLIER : -net * MULTIPLIER;
  if (!(maxLoss > 0)) return null;

  const ancla = esCredito
    ? legs.find((l) => l.action === "vender")!
    : legs.find((l) => l.action === "comprar")!;

  // El breakeven se mueve SIEMPRE en contra de tu apuesta: el crédito te aleja
  // el punto de dolor, el débito te lo acerca porque ya pagaste.
  const alcista = kind === "put_credit" || kind === "call_debit";
  const be = esCredito
    ? kind === "put_credit" ? ancla.strike - net : ancla.strike + net
    : kind === "call_debit" ? ancla.strike - net : ancla.strike + net;

  const pAbove = probAbove(spot, be, iv, dte);
  const pop = (alcista ? pAbove : 1 - pAbove) * 100;

  const returnOnRisk = (maxProfit / maxLoss) * 100;

  return {
    net, credit, debit, width, maxProfit, maxLoss,
    breakevens: [be],
    returnOnRisk,
    annualizedPct: returnOnRisk * (365 / Math.max(dte, 1)),
    pop,
  };
}

/**
 * Métricas del iron condor.
 *
 * EL DETALLE QUE TODO EL MUNDO SE COME: el colateral **no** es la suma de las
 * dos alas. Al vencimiento el precio no puede estar a la vez por encima del
 * call y por debajo del put, así que solo una puede perder — el bróker exige el
 * ala más ancha menos el crédito total. Sumar las dos te haría creer que
 * necesitas el doble de lo que necesitas.
 */
export function condorMetrics(input: {
  putLegs: Leg[];
  callLegs: Leg[];
  spot: number;
  dte: number;
  iv: number;
}): SpreadMetrics | null {
  const { putLegs, callLegs, spot, dte, iv } = input;
  if (putLegs.length !== 2 || callLegs.length !== 2) return null;

  const anchoPut = Math.abs(putLegs[0].strike - putLegs[1].strike);
  const anchoCall = Math.abs(callLegs[0].strike - callLegs[1].strike);
  const width = Math.max(anchoPut, anchoCall);
  if (!(width > 0)) return null;

  const net = netPrice([...putLegs, ...callLegs]);
  if (!(net > 0 && net < width)) return null;

  const maxProfit = net * MULTIPLIER;
  const maxLoss = (width - net) * MULTIPLIER;
  if (!(maxLoss > 0)) return null;

  const shortPut = putLegs.find((l) => l.action === "vender")!;
  const shortCall = callLegs.find((l) => l.action === "vender")!;
  const beLow = shortPut.strike - net;
  const beHigh = shortCall.strike + net;

  const returnOnRisk = (maxProfit / maxLoss) * 100;

  return {
    net, credit: maxProfit, debit: 0, width, maxProfit, maxLoss,
    breakevens: [beLow, beHigh],
    returnOnRisk,
    annualizedPct: returnOnRisk * (365 / Math.max(dte, 1)),
    pop: probInBand(spot, beLow, beHigh, iv, dte) * 100,
  };
}

// ── Score compuesto (0-100) ────────────────────────────────────────────

export interface ScorePart {
  points: number;
  max: number;
  band: string;
  why: string;
}

export interface SpreadScore {
  total: number;
  reward: ScorePart;
  pop: ScorePart;
  liquidity: ScorePart;
  ivFit: ScorePart;
  earnings: ScorePart;
}

export type EarningsFlag = "fuera" | "dentro" | "dentro_confirmado" | "no_aplica";

/**
 * Premio por riesgo. Las bandas son distintas por familia a propósito: un
 * crédito que paga el 33% del riesgo es excelente, mientras que en un débito
 * ese mismo 33% es malísimo — ahí lo normal es aspirar a 1:1 o mejor.
 */
function rewardPart(returnOnRisk: number, family: SpreadFamily): ScorePart {
  if (family === "credito") {
    if (returnOnRisk >= 50)
      return { points: 25, max: 30, band: "≥50%",
        why: "Cobras mucho para el ancho del ala — comprueba por qué pagan tanto." };
    if (returnOnRisk >= 30)
      return { points: 30, max: 30, band: "30-50%",
        why: "Relación crédito/riesgo en el rango sano para vender spreads." };
    if (returnOnRisk >= 20)
      return { points: 22, max: 30, band: "20-30%",
        why: "Crédito correcto para el riesgo que asumes." };
    if (returnOnRisk >= 12)
      return { points: 12, max: 30, band: "12-20%",
        why: "Crédito justito: una sola pérdida se come varias ganancias." };
    return { points: 3, max: 30, band: "<12%",
      why: "Arriesgas mucho para cobrar muy poco. Es recoger monedas delante de una apisonadora." };
  }
  if (returnOnRisk >= 200)
    return { points: 30, max: 30, band: "≥200%",
      why: "Pagas poco para lo que puedes ganar: el débito sale muy barato." };
  if (returnOnRisk >= 120)
    return { points: 24, max: 30, band: "120-200%",
      why: "Ganas más de lo que arriesgas si acierta la dirección." };
  if (returnOnRisk >= 80)
    return { points: 15, max: 30, band: "80-120%",
      why: "Ganas aproximadamente lo que arriesgas: necesitas acertar más de la mitad de las veces." };
  return { points: 5, max: 30, band: "<80%",
    why: "Pagas casi todo el ancho: queda poco recorrido aunque aciertes." };
}

/**
 * Probabilidad de beneficio. OJO CON LA TENSIÓN: `reward` y `pop` se pelean a
 * propósito y ninguna estructura puede maximizar las dos. Sin esa tensión el
 * ranking se llenaría de spreads con 95% de acierto que pierden dinero a la
 * larga, que es el error clásico de vender prima muy lejos.
 */
function popPart(pop: number): ScorePart {
  if (pop >= 80)
    return { points: 25, max: 25, band: "≥80%",
      why: "Sale bien en la gran mayoría de escenarios." };
  if (pop >= 65)
    return { points: 20, max: 25, band: "65-80%",
      why: "La probabilidad está claramente de tu lado." };
  if (pop >= 50)
    return { points: 14, max: 25, band: "50-65%",
      why: "Algo mejor que una moneda al aire." };
  if (pop >= 35)
    return { points: 8, max: 25, band: "35-50%",
      why: "Pierdes más veces de las que ganas: solo compensa si el pago es grande." };
  return { points: 3, max: 25, band: "<35%",
    why: "Muy improbable. Necesita un movimiento fuerte para valer algo." };
}

/** Liquidez de la PEOR pata: el spread vale lo que vale su lado más flojo. */
function liquidityPart(legs: Leg[]): ScorePart {
  const peorOi = Math.min(...legs.map((l) => l.openInterest));
  const peorSpread = Math.max(...legs.map((l) => l.spreadPct ?? Infinity));

  if (peorOi >= 500 && peorSpread <= 10)
    return { points: 20, max: 20, band: "excelente",
      why: "Las dos patas muy negociadas: entras y sales sin regalar dinero." };
  if (peorOi >= 250 && peorSpread <= 15)
    return { points: 14, max: 20, band: "buena",
      why: "Liquidez suficiente en ambas patas." };
  if (peorOi >= 100 && peorSpread <= 25)
    return { points: 7, max: 20, band: "justa",
      why: "La horquilla te va a costar al cerrar, y aquí la cruzas dos veces." };
  return { points: 0, max: 20, band: "insuficiente",
    why: "Liquidez insuficiente en alguna pata." };
}

/**
 * Encaje con la volatilidad. **Banda INVERTIDA según la familia**, por la misma
 * razón que wheel.ts invierte respecto a ivcontext.ts: quien VENDE prima quiere
 * la volatilidad cara, y quien la COMPRA la quiere barata. Es el mismo dato
 * puntuado al revés según de qué lado del trade estés.
 */
function ivFitPart(rank: number | null, family: SpreadFamily): ScorePart {
  if (rank == null)
    return { points: 3, max: 15, band: "sin datos",
      why: "Sin historia suficiente para saber si la volatilidad está cara o barata." };

  if (family === "credito") {
    if (rank > 70)
      return { points: 15, max: 15, band: ">70",
        why: "Volatilidad cara frente a su propio año: buen momento para VENDER prima." };
    if (rank >= 50)
      return { points: 12, max: 15, band: "50-70", why: "Volatilidad por encima de su media anual." };
    if (rank >= 30)
      return { points: 7, max: 15, band: "30-50", why: "Volatilidad en su zona media." };
    return { points: 3, max: 15, band: "<30",
      why: "Volatilidad barata: te pagan poco por vender el riesgo." };
  }

  if (rank < 30)
    return { points: 15, max: 15, band: "<30",
      why: "Volatilidad barata frente a su año: buen momento para COMPRAR prima." };
  if (rank < 50)
    return { points: 12, max: 15, band: "30-50", why: "Volatilidad por debajo de su media anual." };
  if (rank <= 70)
    return { points: 7, max: 15, band: "50-70", why: "Volatilidad en su zona media." };
  return { points: 3, max: 15, band: ">70",
    why: "Volatilidad cara: estás comprando caro y el tiempo juega en tu contra." };
}

function earningsPart(flag: EarningsFlag, family: SpreadFamily): ScorePart {
  // En un débito el reporte no es solo riesgo: es el catalizador que puede
  // hacer que la apuesta funcione. Se penaliza, pero mucho menos.
  const dentro = family === "credito" ? 3 : 7;
  const confirmado = family === "credito" ? 0 : 5;
  switch (flag) {
    case "no_aplica":
      return { points: 10, max: 10, band: "no aplica", why: "No reporta resultados: no hay riesgo de reporte." };
    case "fuera":
      return { points: 10, max: 10, band: "fuera", why: "El reporte estimado cae después del vencimiento." };
    case "dentro":
      return { points: dentro, max: 10, band: "dentro",
        why: "El reporte estimado cae ANTES del vencimiento — es una estimación, verifícala." };
    case "dentro_confirmado":
      return { points: confirmado, max: 10, band: "dentro, confirmado",
        why: "El reporte cae antes del vencimiento y la volatilidad del frente lo confirma." };
  }
}

export function scoreSpread(input: {
  kind: SpreadKind;
  metrics: SpreadMetrics;
  legs: Leg[];
  ivRank: number | null;
  earnings: EarningsFlag;
}): SpreadScore {
  const family = familyOf(input.kind);
  const reward = rewardPart(input.metrics.returnOnRisk, family);
  const pop = popPart(input.metrics.pop);
  const liquidity = liquidityPart(input.legs);
  const ivFit = ivFitPart(input.ivRank, family);
  const earnings = earningsPart(input.earnings, family);
  return {
    total: reward.points + pop.points + liquidity.points + ivFit.points + earnings.points,
    reward, pop, liquidity, ivFit, earnings,
  };
}

// ── Ensamblado ─────────────────────────────────────────────────────────

export interface SpreadCandidate {
  ticker: string;
  kind: SpreadKind;
  label: string;
  thesis: string;
  expiration: string;
  dte: number;
  spot: number;
  legs: Leg[];
  metrics: SpreadMetrics | null;
  score: SpreadScore | null;
  blocked: boolean;
  blockReason: WheelBlockReason | null;
  /** Para la UI: "185/180" o "180/185 · 210/215". */
  strikesLabel: string;
}

function strikesLabel(legs: Leg[]): string {
  const puts = legs.filter((l) => l.type === "put").map((l) => l.strike).sort((a, b) => b - a);
  const calls = legs.filter((l) => l.type === "call").map((l) => l.strike).sort((a, b) => a - b);
  const partes: string[] = [];
  if (puts.length) partes.push(puts.join("/"));
  if (calls.length) partes.push(calls.join("/"));
  return partes.join(" · ");
}

/**
 * IV ATM por vencimiento — la que se usa en TODAS las probabilidades.
 *
 * Es deliberado no usar la IV de la pata vendida: el skew infla la IV de los
 * puts lejanos, así que con ella la probabilidad de caída saldría exagerada y
 * el screener descartaría spreads perfectamente sanos. La distribución del
 * subyacente es una sola, y la de ATM es su mejor proxy.
 */
export function atmIvByExpiry(quotes: SpreadQuote[], spot: number): Map<string, number> {
  const porExp = new Map<string, SpreadQuote[]>();
  for (const q of quotes) {
    if (q.iv == null || !(q.iv > 0)) continue;
    const lista = porExp.get(q.expiration);
    if (lista) lista.push(q);
    else porExp.set(q.expiration, [q]);
  }
  const out = new Map<string, number>();
  for (const [exp, lista] of porExp) {
    const cerca = lista.reduce((a, b) =>
      Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a);
    out.set(exp, cerca.iv!);
  }
  return out;
}

export interface BuildInput {
  ticker: string;
  spot: number;
  quotes: SpreadQuote[];
  preset: SpreadPreset;
  ivRank: number | null;
  earnings: EarningsFlag;
  /** IV de respaldo (volatilidad realizada) cuando el proveedor no la da. */
  fallbackIv: number;
  /** Cuántos candidatos conservar por tipo de estructura. */
  perKind?: number;
}

/** Agrupa por vencimiento y tipo, con los strikes ordenados. */
function agrupar(quotes: SpreadQuote[]): Map<string, { put: SpreadQuote[]; call: SpreadQuote[] }> {
  const out = new Map<string, { put: SpreadQuote[]; call: SpreadQuote[] }>();
  for (const q of quotes) {
    if (!(q.strike > 0) || !q.expiration) continue;
    let g = out.get(q.expiration);
    if (!g) { g = { put: [], call: [] }; out.set(q.expiration, g); }
    g[q.type].push(q);
  }
  for (const g of out.values()) {
    g.put.sort((a, b) => a.strike - b.strike);
    g.call.sort((a, b) => a.strike - b.strike);
  }
  return out;
}

function absDelta(q: SpreadQuote): number | null {
  return q.delta == null ? null : Math.abs(q.delta);
}

function enBanda(q: SpreadQuote, min: number, max: number): boolean {
  const d = absDelta(q);
  // Sin delta del proveedor no se inventa: la fila se descarta en vez de
  // colarse en una banda que no le toca.
  return d != null && d >= min && d <= max;
}

/**
 * Monta todas las verticales y condors del ticker.
 *
 * La combinatoria se acota en tres sitios o esto explota: banda de delta en la
 * pata ancla, `maxWidth` para la pareja, y `perKind` al final. Sin eso son
 * O(strikes²) por vencimiento y por ticker.
 */
export function buildSpreads(input: BuildInput): SpreadCandidate[] {
  const { ticker, spot, quotes, preset, ivRank, earnings, fallbackIv } = input;
  const perKind = input.perKind ?? 2;
  if (!(spot > 0)) return [];

  const ivPorExp = atmIvByExpiry(quotes, spot);
  const grupos = agrupar(quotes);
  const out: SpreadCandidate[] = [];

  const armar = (
    kind: Exclude<SpreadKind, "iron_condor">,
    ancla: SpreadQuote,
    pareja: SpreadQuote,
    dte: number,
    iv: number,
  ): SpreadCandidate | null => {
    const esCredito = familyOf(kind) === "credito";
    // En crédito el ancla se VENDE y la pareja protege; en débito al revés.
    const legAncla = toLeg(ancla, esCredito ? "vender" : "comprar");
    const legPareja = toLeg(pareja, esCredito ? "comprar" : "vender");
    if (!legAncla || !legPareja) return null;

    const legs = [legAncla, legPareja];
    const bloqueo = legBlock([ancla, pareja]);
    if (bloqueo) {
      return {
        ticker, kind, label: SPREAD_LABEL[kind], thesis: SPREAD_THESIS[kind],
        expiration: ancla.expiration, dte, spot, legs,
        metrics: null, score: null, blocked: true, blockReason: bloqueo,
        strikesLabel: strikesLabel(legs),
      };
    }

    const metrics = verticalMetrics({ kind, legs, spot, dte, iv });
    if (!metrics) return null;

    return {
      ticker, kind, label: SPREAD_LABEL[kind], thesis: SPREAD_THESIS[kind],
      expiration: ancla.expiration, dte, spot, legs, metrics,
      score: scoreSpread({ kind, metrics, legs, ivRank, earnings }),
      blocked: false, blockReason: null,
      strikesLabel: strikesLabel(legs),
    };
  };

  for (const [exp, g] of grupos) {
    const dte = (g.put[0] ?? g.call[0])?.dte ?? 0;
    if (dte < preset.dteMin || dte > preset.dteMax) continue;
    const iv = ivPorExp.get(exp) ?? fallbackIv;

    // Mejor crédito de cada lado: se guardan para armar el condor sin repetir
    // la búsqueda ni cruzar todas las combinaciones contra todas.
    let mejorPut: SpreadCandidate | null = null;
    let mejorCall: SpreadCandidate | null = null;

    // ── Crédito: el corto en la banda, el largo MÁS lejos del dinero. ──
    for (const corto of g.put) {
      if (!enBanda(corto, preset.shortDeltaMin, preset.shortDeltaMax)) continue;
      for (const largo of g.put) {
        const ancho = corto.strike - largo.strike;
        if (ancho <= 0 || ancho > preset.maxWidth) continue;
        const c = armar("put_credit", corto, largo, dte, iv);
        if (!c) continue;
        out.push(c);
        if (!c.blocked && (mejorPut == null || (c.score?.total ?? 0) > (mejorPut.score?.total ?? 0))) mejorPut = c;
      }
    }
    for (const corto of g.call) {
      if (!enBanda(corto, preset.shortDeltaMin, preset.shortDeltaMax)) continue;
      for (const largo of g.call) {
        const ancho = largo.strike - corto.strike;
        if (ancho <= 0 || ancho > preset.maxWidth) continue;
        const c = armar("call_credit", corto, largo, dte, iv);
        if (!c) continue;
        out.push(c);
        if (!c.blocked && (mejorCall == null || (c.score?.total ?? 0) > (mejorCall.score?.total ?? 0))) mejorCall = c;
      }
    }

    // ── Débito: el comprado en la banda, el vendido MÁS lejos del dinero. ──
    for (const comprado of g.call) {
      if (!enBanda(comprado, preset.longDeltaMin, preset.longDeltaMax)) continue;
      for (const vendido of g.call) {
        const ancho = vendido.strike - comprado.strike;
        if (ancho <= 0 || ancho > preset.maxWidth) continue;
        const c = armar("call_debit", comprado, vendido, dte, iv);
        if (c) out.push(c);
      }
    }
    for (const comprado of g.put) {
      if (!enBanda(comprado, preset.longDeltaMin, preset.longDeltaMax)) continue;
      for (const vendido of g.put) {
        const ancho = comprado.strike - vendido.strike;
        if (ancho <= 0 || ancho > preset.maxWidth) continue;
        const c = armar("put_debit", comprado, vendido, dte, iv);
        if (c) out.push(c);
      }
    }

    // ── Iron condor: las dos mejores alas del mismo vencimiento. ──
    if (mejorPut && mejorCall) {
      const legs = [...mejorPut.legs, ...mejorCall.legs];
      const metrics = condorMetrics({
        putLegs: mejorPut.legs, callLegs: mejorCall.legs, spot, dte, iv,
      });
      if (metrics) {
        out.push({
          ticker, kind: "iron_condor",
          label: SPREAD_LABEL.iron_condor, thesis: SPREAD_THESIS.iron_condor,
          expiration: exp, dte, spot, legs, metrics,
          score: scoreSpread({ kind: "iron_condor", metrics, legs, ivRank, earnings }),
          blocked: false, blockReason: null,
          strikesLabel: strikesLabel(legs),
        });
      }
    }
  }

  return topPerKind(out, perKind);
}

/** Deja los `n` mejores de cada estructura. Sin esto un ticker inunda la tabla. */
export function topPerKind(candidates: SpreadCandidate[], n: number): SpreadCandidate[] {
  const porTipo = new Map<SpreadKind, SpreadCandidate[]>();
  for (const c of candidates) {
    const lista = porTipo.get(c.kind);
    if (lista) lista.push(c);
    else porTipo.set(c.kind, [c]);
  }
  const out: SpreadCandidate[] = [];
  for (const lista of porTipo.values()) {
    lista.sort((a, b) => {
      if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
      return (b.score?.total ?? 0) - (a.score?.total ?? 0);
    });
    out.push(...lista.slice(0, n));
  }
  return sortSpreads(out);
}

/** Orden global: operables primero, luego mejor score. */
export function sortSpreads(candidates: SpreadCandidate[]): SpreadCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
    return (b.score?.total ?? 0) - (a.score?.total ?? 0);
  });
}
