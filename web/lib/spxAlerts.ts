// Alertas de SPX sobre la estructura de gamma del día.
//
// PURO — no toca red ni disco. La ruta trae la cadena; aquí solo se decide.
//
// POR QUÉ SPX Y POR QUÉ GAMMA: en un vencimiento del día quien mueve el índice
// no es una tesis de fondo sino la cobertura del dealer. Con gamma NETA POSITIVA
// el dealer vende fuerza y compra debilidad, así que el precio se pega al nodo
// principal —el famoso "pin"—. Con gamma NEGATIVA hace lo contrario y amplifica
// el movimiento en vez de frenarlo. Saber en cuál de los dos regímenes estás, y
// a qué distancia está el punto donde cambia, es la información que de verdad
// sirve para operar SPX intradía.
//
// Todo sale del `gexAnalysis` que ya existe. Este archivo no calcula gamma:
// traduce el análisis a avisos accionables y en lenguaje llano.

export type AlertLevel = "alta" | "media" | "info";

export interface SpxAlert {
  level: AlertLevel;
  /** Etiqueta corta para la UI. */
  title: string;
  detail: string;
  /** Precio al que se refiere el aviso, si aplica. */
  price?: number;
}

export interface SpxAlertInput {
  spot: number;
  /** Nodo principal del GEX: el imán. */
  magnet: number | null;
  /** Strike donde la gamma neta cambia de signo. */
  flip: number | null;
  /** Régimen de la gamma neta total. */
  regime: "positive" | "negative";
  /** Horas de sesión que quedan. */
  hoursLeft: number;
  /** Strikes con más concentración, ordenados. Se usan como muros. */
  walls: { strike: number; netGex: number; concentration: number }[];
}

/**
 * Distancia (en % del precio) por debajo de la cual se considera que el precio
 * "está en" un nivel. Medio punto porcentual es el movimiento típico que le
 * queda a SPX en las últimas horas — la misma referencia que `FULL_VOTE_PCT`.
 */
export const NEAR_PCT = 0.5;

/**
 * Distancia a la que se puede decir que el precio está ENCIMA de un nivel.
 *
 * Mucho más estrecha que `NEAR_PCT` y por una razón medida en producción: con
 * SPX en 7.601 un 0,5% son **$36**, y anunciar "el precio está encima de la
 * zona de inversión" con $36 de separación es sencillamente falso. `NEAR_PCT`
 * sirve para "esto es relevante hoy"; esto otro para "esto está pasando ahora".
 */
export const ON_TOP_PCT = 0.15;

/** Distancia a la que un nivel deja de ser relevante para el día. */
export const FAR_PCT = 2;

function pct(from: number, to: number): number {
  return ((to - from) / from) * 100;
}

/**
 * Traduce la estructura de gamma en avisos.
 *
 * El orden importa: se devuelven de más a menos urgente, porque la UI enseña
 * los primeros y un aviso de régimen enterrado bajo tres informativos no lo lee
 * nadie.
 */
export function spxAlerts(input: SpxAlertInput): SpxAlert[] {
  const { spot, magnet, flip, regime, hoursLeft, walls } = input;
  const out: SpxAlert[] = [];
  if (!(spot > 0)) return out;

  // ── Régimen: es el marco que da sentido a todo lo demás ──
  if (regime === "negative") {
    out.push({
      level: "alta",
      title: "Gamma negativa",
      detail:
        "El dealer cubre EN LA MISMA dirección del movimiento, así que amplifica en vez de frenar. " +
        "Los rangos se rompen con más facilidad y las velas se alargan.",
    });
  } else {
    out.push({
      level: "info",
      title: "Gamma positiva",
      detail:
        "El dealer vende la fuerza y compra la debilidad: el precio tiende a revertir hacia el nodo " +
        "y a quedarse en rango.",
    });
  }

  // ── Imán: dónde quiere cerrar el día ──
  if (magnet != null && magnet > 0) {
    const d = pct(spot, magnet);
    const abs = Math.abs(d);
    if (abs <= ON_TOP_PCT) {
      out.push({
        level: regime === "positive" ? "alta" : "media",
        title: "Precio clavado en el imán",
        price: magnet,
        detail:
          regime === "positive"
            ? `El precio está sobre el nodo principal ($${magnet.toFixed(0)}). Con gamma positiva ese punto lo sujeta: es el escenario de pin clásico de cierre.`
            : `El precio está sobre el nodo principal ($${magnet.toFixed(0)}), pero con gamma negativa el nodo NO sujeta.`,
      });
    } else if (abs <= FAR_PCT) {
      out.push({
        level: "media",
        title: d > 0 ? "Imán por encima" : "Imán por debajo",
        price: magnet,
        detail: `El nodo principal está en $${magnet.toFixed(0)}, un ${abs.toFixed(2)}% ${d > 0 ? "por encima" : "por debajo"}. Es el precio hacia el que tira la cobertura.`,
      });
    }
  }

  // ── Flip: el punto donde cambia el juego ──
  if (flip != null && flip > 0) {
    const d = pct(spot, flip);
    const abs = Math.abs(d);
    if (abs <= ON_TOP_PCT) {
      out.push({
        level: "alta",
        title: "Pegado a la zona de inversión",
        price: flip,
        detail:
          `La gamma cambia de signo en $${flip.toFixed(0)} y el precio está justo encima. ` +
          "Cruzarlo cambia el comportamiento del mercado de golpe: de revertir a amplificar, o al revés.",
      });
    } else if (abs <= NEAR_PCT) {
      out.push({
        level: "media",
        title: d > 0 ? "Inversión de gamma cerca, arriba" : "Inversión de gamma cerca, abajo",
        price: flip,
        detail:
          `La gamma cambia de signo en $${flip.toFixed(0)}, a un ${abs.toFixed(2)}% (${Math.abs(flip - spot).toFixed(0)} puntos). ` +
          "Si el precio llega ahí, el mercado cambia de comportamiento.",
      });
    } else if (abs <= FAR_PCT) {
      out.push({
        level: "media",
        title: d > 0 ? "Inversión de gamma arriba" : "Inversión de gamma abajo",
        price: flip,
        detail: `La gamma cambia de signo en $${flip.toFixed(0)}, un ${abs.toFixed(2)}% ${d > 0 ? "por encima" : "por debajo"}.`,
      });
    }
  }

  // ── Muros: los strikes con más gamma cerca del precio ──
  const cerca = walls
    .filter((w) => Math.abs(pct(spot, w.strike)) <= FAR_PCT)
    .slice(0, 2);
  for (const w of cerca) {
    const d = pct(spot, w.strike);
    if (Math.abs(d) <= NEAR_PCT) continue; // ya cubierto por imán/flip
    out.push({
      level: "info",
      title: d > 0 ? `Muro de gamma en $${w.strike.toFixed(0)}` : `Soporte de gamma en $${w.strike.toFixed(0)}`,
      price: w.strike,
      detail: `Concentración alta de gamma ${w.netGex >= 0 ? "de calls" : "de puts"} a un ${Math.abs(d).toFixed(2)}% ${d > 0 ? "por encima" : "por debajo"}.`,
    });
  }

  // ── Reloj: la última hora se comporta distinto ──
  if (hoursLeft <= 1.5 && hoursLeft > 0) {
    out.push({
      level: "media",
      title: "Última hora",
      detail:
        `Quedan ${hoursLeft.toFixed(1)}h. La gamma se dispara según se acerca el cierre: los movimientos ` +
        "se aceleran y las horquillas se abren justo cuando menos margen hay para salir.",
    });
  }

  const orden: Record<AlertLevel, number> = { alta: 0, media: 1, info: 2 };
  return out.sort((a, b) => orden[a.level] - orden[b.level]);
}
