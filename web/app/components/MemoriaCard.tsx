"use client";

import { useEffect, useState } from "react";
import type { PredictionEval, PredictionReview } from "@/lib/predictionStore";
import { px } from "../format";

type Review = PredictionReview & { total: number };

function fmtDate(d: string): string {
  try {
    return new Date(`${d}T12:00:00Z`).toLocaleDateString("es", { month: "short", day: "numeric" });
  } catch { return d; }
}

const BEST_LABEL = { bear: "Bajista", base: "Base", bull: "Alcista" } as const;

function Row({ e }: { e: PredictionEval }) {
  const err = e.baseErrorPct;
  return (
    <div className="mem-row">
      <span className="mem-date">{fmtDate(e.date)}</span>
      <span className="mem-pred">${px.format(e.base)}</span>
      <span className="mem-actual">
        {e.actualClose != null ? `$${px.format(e.actualClose)}` : "—"}
        {!e.matured && <span className="mem-pending"> · en curso</span>}
      </span>
      <span className={`mem-err ${err == null ? "" : Math.abs(err) <= 3 ? "good" : Math.abs(err) <= 7 ? "mid" : "bad"}`}>
        {err == null ? "—" : `${err >= 0 ? "+" : ""}${err.toFixed(1)}%`}
      </span>
      <span className="mem-best">
        {e.matured && e.best ? `acertó ${BEST_LABEL[e.best]}` : ""}
      </span>
    </div>
  );
}

/**
 * Memoria del agente (vista Estudiante). Muestra cómo le fue a las predicciones pasadas
 * contra el precio real: error del target base, si tocó el nivel y si acertó la dirección.
 * Se acumula hacia adelante — al principio dirá que aún está juntando historial.
 */
export default function MemoriaCard({ ticker }: { ticker: string }) {
  const [r, setR] = useState<Review | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setR(null); setFailed(false);
    // Respiro para que el POST de guardado de esta sesión llegue antes que el GET
    // (si no, la primera vez que se ve un ticker aún no está persistida la foto de hoy).
    const t = setTimeout(() => {
      fetch(`/api/prediction?ticker=${encodeURIComponent(ticker)}`)
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error("mem"))))
        .then((d: Review) => { if (!cancelled) setR(d); })
        .catch(() => { if (!cancelled) setFailed(true); });
    }, 1500);
    return () => { cancelled = true; clearTimeout(t); };
  }, [ticker]);

  if (failed) return null;

  return (
    <section className="card">
      <div>
        <div className="card-title">🧠 Memoria del agente — ¿qué tan bien predijo antes?</div>
        <div className="card-sub">
          Cada día el agente guarda su predicción y la compara con lo que la acción hizo después.
          Así mide su error y va afinando los targets. El historial se acumula con el tiempo.
        </div>
      </div>

      {!r && <div className="feed-empty">Leyendo la memoria de {ticker}…</div>}

      {r && r.maturedCount === 0 && (
        <div className="mem-empty">
          Aún no hay predicciones <b>vencidas</b> para {ticker}
          {r.total > 0 ? ` (${r.total} guardada${r.total === 1 ? "" : "s"}, esperando a que pase el horizonte).` : "."}
          {" "}Vuelve en unos días para ver qué tan cerca quedó.
        </div>
      )}

      {/* Sin este aviso, el reseteo de la calibración parece un historial perdido. */}
      {r && r.legacyMaturedCount > 0 && (
        <div className="mem-empty">
          <b>{r.legacyMaturedCount}</b> predicción{r.legacyMaturedCount === 1 ? "" : "es"}
          {" "}vencida{r.legacyMaturedCount === 1 ? "" : "s"} no cuenta
          {r.legacyMaturedCount === 1 ? "" : "n"} en estos números: se hicieron con el
          motor anterior, que estimaba la gamma en vez de leerla del proveedor.
          Se siguen viendo abajo, pero mezclarlas falsearía el sesgo.
        </div>
      )}

      {r && r.maturedCount > 0 && (
        <>
          <div className="mem-stats">
            <div className="mem-stat">
              <div className="mem-stat-label">Error medio del target</div>
              <div className="mem-stat-value">±{r.meanAbsErrorPct?.toFixed(1)}%</div>
              <div className="mem-stat-sub">sobre {r.maturedCount} predicción{r.maturedCount === 1 ? "" : "es"}</div>
            </div>
            <div className="mem-stat">
              <div className="mem-stat-label">Acierto de dirección</div>
              <div className="mem-stat-value">{r.directionHitRate?.toFixed(0)}%</div>
              <div className="mem-stat-sub">¿subió/bajó como dijo?</div>
            </div>
            <div className="mem-stat">
              <div className="mem-stat-label">Tocó el target base</div>
              <div className="mem-stat-value">{r.baseTouchRate?.toFixed(0)}%</div>
              <div className="mem-stat-sub">llegó al precio previsto</div>
            </div>
            <div className="mem-stat">
              <div className="mem-stat-label">Sesgo</div>
              <div className="mem-stat-value">{r.biasPct == null ? "—" : `${r.biasPct >= 0 ? "+" : ""}${r.biasPct.toFixed(1)}%`}</div>
              <div className="mem-stat-sub">
                {r.biasPct == null ? "" : r.biasPct > 1 ? "suele apuntar bajo" : r.biasPct < -1 ? "suele apuntar alto" : "bien calibrado"}
              </div>
            </div>
          </div>

          <div className="mem-table">
            <div className="mem-head">
              <span>Fecha</span><span>Predijo</span><span>Real</span><span>Error</span><span></span>
            </div>
            {r.evals.map((e) => <Row key={e.date} e={e} />)}
          </div>
        </>
      )}
    </section>
  );
}
