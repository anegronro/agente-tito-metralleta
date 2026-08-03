// Sesgo direccional del subyacente: funde GEX, flujo y noticias en un número.
//
// PURO — no toca red ni disco.
//
// POR QUÉ EXISTE: el screener de spreads nacía ciego. Su probabilidad de
// beneficio sale de una lognormal **sin deriva**, o sea que asume que subir y
// bajar son igual de probables. Para un credit spread se defiende —apuestas a
// que el tiempo corra—, pero rankear un call debit alcista sin haberle
// preguntado nunca al GEX ni al flujo si hay algo alcista es apostar a ciegas.
//
// Este módulo no predice: PONDERA. Coge las tres señales que el agente ya
// calcula para el panel de ticker y las reduce a "alcista / bajista / neutral"
// con una fuerza, para que `spreads.ts` pueda premiar las estructuras cuya
// tesis coincide con el contexto y castigar las que reman en contra.

import type { Level } from "./levels";
import type { Bias, NewsBias } from "./news";

/** Un voto de una fuente. `value` va de −1 (bajista) a +1 (alcista). */
export interface BiasVote {
  source: "gex" | "flujo" | "noticias";
  value: number;
  weight: number;
  why: string;
}

export interface DirectionalContext {
  bias: Bias;
  /** −100 (bajista) … +100 (alcista). */
  score: number;
  /** |score|: cuánta convicción hay detrás, 0-100. */
  strength: number;
  /** Precio imán del GEX. null si no se pudo calcular. */
  magnet: number | null;
  votes: BiasVote[];
}

export const NEUTRAL: DirectionalContext = {
  bias: "neutral", score: 0, strength: 0, magnet: null, votes: [],
};

/**
 * Pesos de cada fuente. El GEX pesa más porque sale de la MISMA cadena que se
 * está operando —es estructural, no una opinión— mientras que las noticias son
 * la señal más ruidosa y más fácil de malinterpretar por una máquina.
 */
export const SOURCE_WEIGHT = { gex: 0.45, flujo: 0.35, noticias: 0.20 } as const;

/**
 * Pesos en modo 0DTE: **el GEX manda**.
 *
 * En un contrato que vence en horas, quien mueve el precio es la cobertura del
 * dealer alrededor de los strikes con gamma, no una tesis de fondo. Y las
 * noticias salen del todo: nuestra capa de titulares se cachea por horas y un
 * titular de esta mañana no dice nada útil sobre las próximas dos. Dejarla con
 * un peso pequeño solo metería ruido de ayer en una decisión de hoy.
 */
export const ZERO_DTE_WEIGHT = { gex: 0.65, flujo: 0.35, noticias: 0 } as const;

/**
 * Distancia al imán que cuenta como voto PLENO, en % del precio.
 *
 * Son dos escalas porque son dos horizontes, y usar la de 30 días en un 0DTE
 * deja al GEX mudo. Medido en el escaneo real de las 13:48 ET: los once imanes
 * detectados estaban **entre el 0,0% y el 0,9%** del precio — sobre la escala
 * de ±3% eso da votos de 0,03 a 0,3 y el sesgo sale neutral siempre, por mucho
 * peso que se le dé.
 *
 * El 0,5% no es arbitrario: la σ diaria de SPY ronda el 1%, y a dos horas del
 * cierre eso es 1%·√(2/6,5) ≈ 0,55%. O sea, medio punto porcentual ES el
 * movimiento típico que queda por delante.
 */
export const FULL_VOTE_PCT = { normal: 3, zeroDte: 0.5 } as const;

function clamp(v: number, min = -1, max = 1): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Voto del imán de gamma. Un 3% de distancia ya es un voto pleno: más allá de
 * eso el imán deja de ser un objetivo creíble dentro del plazo del spread.
 */
export function gexVote(
  magnet: number | null,
  spot: number,
  weight: number = SOURCE_WEIGHT.gex,
  fullVotePct: number = FULL_VOTE_PCT.normal,
): BiasVote | null {
  if (magnet == null || !(spot > 0) || !(magnet > 0)) return null;
  const distPct = ((magnet - spot) / spot) * 100;
  const value = clamp(distPct / Math.max(fullVotePct, 0.05));
  const dir = distPct > 0 ? "por encima" : "por debajo";
  return {
    source: "gex",
    value,
    weight,
    why: `El imán de gamma está en $${magnet.toFixed(2)}, un ${Math.abs(distPct).toFixed(1)}% ${dir} del precio.`,
  };
}

/**
 * Voto del flujo de opciones, por el % de premium que va a calls. El 50% es el
 * empate y el 70/30 es un voto pleno — pedir más sería exigir un extremo que
 * casi nunca aparece en un ticker líquido.
 */
export function flowVote(callPremiumPct: number | null): BiasVote | null {
  if (callPremiumPct == null || !Number.isFinite(callPremiumPct)) return null;
  const value = clamp((callPremiumPct - 50) / 20);
  return {
    source: "flujo",
    value,
    weight: SOURCE_WEIGHT.flujo,
    why: `El ${callPremiumPct.toFixed(0)}% del dinero en opciones está en calls.`,
  };
}

/** Voto de las noticias. `newsBias.score` ya viene en −1…+1 ponderado por frescura. */
export function newsVote(news: NewsBias | null): BiasVote | null {
  if (!news || news.bias === "neutral" || news.score === 0) return null;
  return {
    source: "noticias",
    value: clamp(news.score),
    weight: SOURCE_WEIGHT.noticias,
    why: `Titulares recientes con tono ${news.score > 0 ? "positivo" : "negativo"} (${news.positive}+ / ${news.negative}−).`,
  };
}

/**
 * Funde los votos disponibles.
 *
 * Se normaliza por el peso de las fuentes PRESENTES, no por el total: si no hay
 * noticias, el GEX y el flujo se reparten el 100% en vez de quedar amputados a
 * un 80% que fingiría menos convicción de la que hay. Que falte una fuente no
 * es una señal neutral, es simplemente menos información.
 */
export function combineBias(votes: (BiasVote | null)[], magnet: number | null = null): DirectionalContext {
  const presentes = votes.filter((v): v is BiasVote => v != null);
  if (presentes.length === 0) return { ...NEUTRAL, magnet };

  const pesoTotal = presentes.reduce((a, v) => a + v.weight, 0);
  const score = (presentes.reduce((a, v) => a + v.value * v.weight, 0) / pesoTotal) * 100;

  // El umbral de 20 es deliberadamente alto: por debajo de eso las fuentes se
  // están contradiciendo o son tibias, y un sesgo tibio aplicado a un ranking
  // hace más daño que no tener sesgo.
  let bias: Bias = "neutral";
  if (score >= 20) bias = "bullish";
  else if (score <= -20) bias = "bearish";
  else if (presentes.some((v) => v.value > 0.2) && presentes.some((v) => v.value < -0.2)) bias = "mixed";

  return { bias, score, strength: Math.abs(score), magnet, votes: presentes };
}

// ── Flujo: de un escaneo de mercado a un % por ticker ──────────────────

/** Lo mínimo de un `FlowRow` para medir dirección. */
export interface FlowLite {
  underlying: string;
  type: "call" | "put" | "unknown";
  premium: number;
}

/**
 * % del premium que va a calls, por ticker. Es el insumo de `flowVote`.
 *
 * Se pondera por DINERO y no por número de operaciones: mil lotes de $200 no
 * dicen lo que dice una sola de $2M, y contar transacciones dejaría que el
 * ruido minorista tapara al que de verdad está posicionándose.
 *
 * Se exige un mínimo de premium por ticker (`minPremium`) porque con dos
 * operaciones sueltas el porcentaje salta entre 0 y 100 y fabricaría
 * convicciones que no existen.
 */
export function callPremiumPctByTicker(
  rows: FlowLite[],
  minPremium = 250_000,
): Map<string, number> {
  const acc = new Map<string, { calls: number; total: number }>();
  for (const r of rows) {
    if (r.type === "unknown" || !(r.premium > 0) || !r.underlying) continue;
    const a = acc.get(r.underlying) ?? { calls: 0, total: 0 };
    a.total += r.premium;
    if (r.type === "call") a.calls += r.premium;
    acc.set(r.underlying, a);
  }
  const out = new Map<string, number>();
  for (const [ticker, a] of acc) {
    if (a.total < minPremium) continue;
    out.set(ticker, (a.calls / a.total) * 100);
  }
  return out;
}

// ── Flujo 0DTE: aquí el LADO de la ejecución cambia el signo ───────────

/** Como `FlowLite`, más cómo se ejecutó la operación. */
export interface FlowAggr extends FlowLite {
  aggression: "ask" | "bid" | "mid" | "unknown";
}

/**
 * Sesgo alcista 0-100 del flujo AGRESIVO, ponderado por dinero.
 *
 * POR QUÉ NO VALE `callPremiumPctByTicker` AQUÍ: esa cuenta todo el premium de
 * calls como alcista, y en un feed de apuestas agresivas eso es sencillamente
 * falso. Vender una call no es apostar a que suba, es marcar resistencia. Se
 * aplica la tabla del Proceso Principal:
 *
 *   comprar call (al ask) → alcista      vender call (al bid) → bajista
 *   comprar put  (al ask) → bajista      vender put  (al bid) → alcista
 *
 * Las ejecuciones al medio o sin lado reconocible **no votan**: no se sabe
 * quién fue el agresor, y adivinarlo inventaría dirección donde no la hay.
 */
export function aggressiveBullishPctByTicker(
  rows: FlowAggr[],
  minPremium = 100_000,
): Map<string, number> {
  const acc = new Map<string, { alcista: number; bajista: number }>();
  for (const r of rows) {
    if (r.type === "unknown" || !(r.premium > 0) || !r.underlying) continue;
    if (r.aggression !== "ask" && r.aggression !== "bid") continue;

    const comprado = r.aggression === "ask";
    const alcista = r.type === "call" ? comprado : !comprado;

    const a = acc.get(r.underlying) ?? { alcista: 0, bajista: 0 };
    if (alcista) a.alcista += r.premium;
    else a.bajista += r.premium;
    acc.set(r.underlying, a);
  }

  const out = new Map<string, number>();
  for (const [ticker, a] of acc) {
    const total = a.alcista + a.bajista;
    if (total < minPremium) continue;
    out.set(ticker, (a.alcista / total) * 100);
  }
  return out;
}

/**
 * Voto del flujo de 0DTE. Misma escala que `flowVote` (50 = empate) pero con
 * su propio texto: aquí el número ya es direccional, no un simple % de calls.
 */
export function zeroDteFlowVote(bullishPct: number | null): BiasVote | null {
  if (bullishPct == null || !Number.isFinite(bullishPct)) return null;
  return {
    source: "flujo",
    value: clamp((bullishPct - 50) / 20),
    weight: ZERO_DTE_WEIGHT.flujo,
    why: `Del dinero grande que hoy opera 0DTE, el ${bullishPct.toFixed(0)}% apuesta al alza.`,
  };
}

// ── Colocación del strike frente a los niveles ─────────────────────────

export type LevelFit = "protegido" | "expuesto" | "sin_nivel";

export interface LevelCheck {
  fit: LevelFit;
  level: Level | null;
  why: string;
}

/** Fuerza mínima para considerar que un nivel de verdad sostiene o frena. */
export const STRONG_LEVEL = 35;

/**
 * ¿El strike vendido está detrás de un nivel que lo proteja?
 *
 * Regla del Proceso Principal: **vender calls marca resistencia y vender puts
 * marca soporte**. Así que un put vendido POR DEBAJO de un soporte fuerte está
 * protegido —el precio ya rebotó ahí antes—, y un call vendido POR ENCIMA de
 * una resistencia fuerte, igual. Es la misma idea del colchón de la Wheel,
 * aplicada a la pata corta del spread.
 */
export function checkLevel(input: {
  shortStrike: number;
  side: "put" | "call";
  supports: Level[];
  resistances: Level[];
}): LevelCheck {
  const { shortStrike, side, supports, resistances } = input;

  if (side === "put") {
    // Soportes que quedan POR ENCIMA del strike: el precio tendría que
    // atravesarlos para hacerte daño.
    const escudos = supports.filter((s) => s.price >= shortStrike);
    const fuerte = escudos.reduce<Level | null>(
      (best, s) => (best == null || s.strength > best.strength ? s : best), null);
    if (fuerte && fuerte.strength >= STRONG_LEVEL) {
      return { fit: "protegido", level: fuerte,
        why: `El put vendido queda bajo un soporte de fuerza ${Math.round(fuerte.strength)}: el precio ya rebotó ahí antes.` };
    }
    if (fuerte) {
      return { fit: "sin_nivel", level: fuerte,
        why: "Hay un soporte por encima del strike, pero es flojo." };
    }
    return { fit: "expuesto", level: null,
      why: "No hay soporte entre el precio y tu strike: nada frena una caída." };
  }

  const escudos = resistances.filter((r) => r.price <= shortStrike);
  const fuerte = escudos.reduce<Level | null>(
    (best, r) => (best == null || r.strength > best.strength ? r : best), null);
  if (fuerte && fuerte.strength >= STRONG_LEVEL) {
    return { fit: "protegido", level: fuerte,
      why: `El call vendido queda sobre una resistencia de fuerza ${Math.round(fuerte.strength)}: el precio ya se dio la vuelta ahí.` };
  }
  if (fuerte) {
    return { fit: "sin_nivel", level: fuerte,
      why: "Hay una resistencia por debajo del strike, pero es floja." };
  }
  return { fit: "expuesto", level: null,
    why: "No hay resistencia entre el precio y tu strike: nada frena una subida." };
}

/**
 * ¿Estorba un nivel al camino de una apuesta direccional?
 *
 * En un débito el nivel juega al revés que en un crédito: una resistencia
 * fuerte entre el precio y tu objetivo no te protege, te **frena**. Se mira
 * solo lo que hay en el camino, no lo que queda detrás.
 */
export function checkPath(input: {
  spot: number;
  target: number;
  supports: Level[];
  resistances: Level[];
}): LevelCheck {
  const { spot, target, supports, resistances } = input;
  const alcista = target > spot;
  const enMedio = (alcista ? resistances : supports).filter((l) =>
    alcista ? l.price > spot && l.price < target : l.price < spot && l.price > target);

  const estorbo = enMedio.reduce<Level | null>(
    (best, l) => (best == null || l.strength > best.strength ? l : best), null);

  if (estorbo && estorbo.strength >= STRONG_LEVEL) {
    return { fit: "expuesto", level: estorbo,
      why: `Hay ${alcista ? "una resistencia" : "un soporte"} de fuerza ${Math.round(estorbo.strength)} en $${estorbo.price.toFixed(2)}, en medio del camino.` };
  }
  if (estorbo) {
    return { fit: "sin_nivel", level: estorbo, why: "Hay un nivel flojo en el camino." };
  }
  return { fit: "protegido", level: null,
    why: "El camino hasta tu objetivo está despejado de niveles fuertes." };
}
