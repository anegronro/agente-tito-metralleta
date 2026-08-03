// Aritmética del 0DTE: el día que vence, medido en horas y no en días.
//
// PURO — no toca red ni disco.
//
// POR QUÉ HACE FALTA UN ARCHIVO ENTERO PARA ESTO: el resto del motor mide el
// tiempo en días enteros, y con `dte = 0` las fórmulas no se degradan, se
// ROMPEN. Cuatro sitios concretos:
//
//   1. `probAbove` calcula σ = IV·√T. Con T = 0 la desviación es 0 y devuelve
//      1 o 0 — o sea, TODA probabilidad de éxito saldría 100% o 0%. Un
//      screener que dice "100% de acierto" es peor que uno que no dice nada.
//   2. El anualizado hace `365 / max(dte, 1)`: en un 0DTE multiplicaría el
//      retorno por 365 y pondría arriba justo lo más peligroso.
//   3. El open interest de un 0DTE es de ANOCHE. Filtrar por él descarta
//      contratos que hoy mueven millones y aprueba otros que ya nadie toca.
//   4. La quema de theta de un 0DTE es del 100% del contrato, así que la banda
//      `MAX_THETA_PCT_DAILY` de Inusualidad lo declara lotería siempre.
//
// Aquí se resuelven 1, 2 y 3. El 4 es una decisión de producto, no de
// aritmética: vive en el preset `0dte` de `spreads.ts`, que es de riesgo
// definido — la pérdida está topada al ancho, así que la quema total del
// contrato ya no es una pérdida ilimitada.

/** Apertura y cierre del mercado en horas ET. */
export const MARKET_OPEN_HOUR = 9.5;
export const MARKET_CLOSE_HOUR = 16;
const SESSION_HOURS = MARKET_CLOSE_HOUR - MARKET_OPEN_HOUR; // 6.5

/**
 * Hora del día en ET, en decimal (14.5 = 14:30). Se saca con `Intl` y no con
 * aritmética de UTC para que el horario de verano lo resuelva el sistema: el
 * cambio de DST movería el cierre una hora y todos los cálculos con él.
 */
export function marketHour(now: Date): number {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const h = Number(partes.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(partes.find((p) => p.type === "minute")?.value ?? "0");
  // Intl puede devolver "24" a medianoche.
  return (h % 24) + m / 60;
}

/** Horas de sesión que quedan hasta el cierre. 0 si ya cerró o aún no abre. */
export function hoursToClose(now: Date): number {
  const h = marketHour(now);
  if (h >= MARKET_CLOSE_HOUR) return 0;
  if (h <= MARKET_OPEN_HOUR) return SESSION_HOURS;
  return MARKET_CLOSE_HOUR - h;
}

/**
 * Mínimo de horas para que un 0DTE tenga sentido.
 *
 * Por debajo de esto la gamma se dispara, las horquillas se abren y la
 * probabilidad deja de significar gran cosa: el precio del contrato pasa a ser
 * casi todo ruido de ejecución. No es una regla del mercado, es dónde este
 * screener deja de fiarse de sus propios números.
 */
export const MIN_HOURS_LEFT = 1;

/**
 * Tiempo al vencimiento **en días**, admitiendo fracciones.
 *
 * Es lo que se le pasa a `probAbove` y compañía en lugar del entero. Para
 * `dte >= 1` devuelve el entero de siempre, así que no cambia nada de lo que ya
 * funcionaba; solo el 0 pasa a medirse en horas de sesión.
 */
export function fractionalDte(dte: number, now: Date): number {
  if (dte >= 1) return dte;
  const horas = hoursToClose(now);
  // Suelo de 15 minutos: con menos, √T se va a cero y volvemos al problema 1.
  return Math.max(horas, 0.25) / 24;
}

/** ¿Estamos dentro de la ventana en la que un 0DTE es operable? */
export function zeroDteWindow(now: Date): { open: boolean; hoursLeft: number; why: string } {
  const hoursLeft = hoursToClose(now);
  const h = marketHour(now);
  if (h < MARKET_OPEN_HOUR) {
    return { open: false, hoursLeft: 0, why: "El mercado todavía no ha abierto." };
  }
  if (hoursLeft <= 0) {
    return { open: false, hoursLeft: 0, why: "El mercado ya cerró: los 0DTE de hoy vencieron." };
  }
  if (hoursLeft < MIN_HOURS_LEFT) {
    return {
      open: false, hoursLeft,
      why: `Quedan menos de ${MIN_HOURS_LEFT}h: demasiado cerca del cierre para fiarse de los precios.`,
    };
  }
  return { open: true, hoursLeft, why: `Quedan ${hoursLeft.toFixed(1)}h de sesión.` };
}

// ── Liquidez de un 0DTE: manda el VOLUMEN, no el open interest ─────────

/**
 * Volumen mínimo del día para considerar operable una pata de 0DTE.
 *
 * Sustituye al `MIN_OI = 100` de la Wheel, que aquí mide el pasado: el open
 * interest se calcula al cierre de ayer, así que en un contrato que vence HOY
 * habla de posiciones que a media sesión pueden estar ya cerradas. El volumen
 * es lo único que dice si ahora mismo hay alguien al otro lado.
 */
export const MIN_ZERO_DTE_VOLUME = 250;

/** Cuántos contratos de cada lado entran en el GEX del 0DTE. */
export const ZERO_DTE_TOP_N = 10;

/**
 * Los `n` calls y `n` puts MÁS NEGOCIADOS del día.
 *
 * Es la selección con la que se calcula el GEX en modo 0DTE, y acota a
 * propósito: en un vencimiento del día la gamma que de verdad mueve al dealer
 * está donde hay volumen hoy, no repartida por toda la cadena. Los strikes
 * lejanos sin operar meten ruido en el imán.
 *
 * CONSECUENCIA ASUMIDA: el imán que sale de aquí **no es** el del panel Pro,
 * que usa la cadena entera. Son dos números distintos que responden a dos
 * preguntas distintas, y no deberían compararse entre sí.
 */
export function topByVolume<T extends { type: "put" | "call"; volume: number }>(
  quotes: T[],
  n = ZERO_DTE_TOP_N,
): T[] {
  const porLado = (lado: "put" | "call") =>
    quotes
      .filter((q) => q.type === lado && q.volume > 0)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, n);
  return [...porLado("call"), ...porLado("put")];
}

export type ZeroDteBlock = "sin_bid" | "spread_ancho" | "volumen_bajo";

/**
 * Horquilla máxima para un 0DTE, en % del mid.
 *
 * Más estrecha que el 25% del resto del agente y a propósito: en un contrato
 * que vence hoy no hay un mañana en el que la horquilla se cierre. Lo que
 * pagues de spread al entrar es definitivo.
 */
export const MAX_ZERO_DTE_SPREAD_PCT = 15;

export function zeroDteLiquidityBlock(input: {
  bid?: number | null;
  ask?: number | null;
  volume: number;
}): ZeroDteBlock | null {
  if (!(input.bid != null && input.bid > 0)) return "sin_bid";
  const { bid, ask } = input;
  if (!(ask != null && ask > 0) || ask < bid) return "spread_ancho";
  const mid = (bid + ask) / 2;
  if (!(mid > 0) || ((ask - bid) / mid) * 100 > MAX_ZERO_DTE_SPREAD_PCT) return "spread_ancho";
  if (input.volume < MIN_ZERO_DTE_VOLUME) return "volumen_bajo";
  return null;
}
