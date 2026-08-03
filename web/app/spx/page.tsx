"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import NavTabs from "@/app/components/NavTabs";
import Logo from "@/app/components/Logo";
import type { SpxReport } from "@/app/api/spx/route";

const REFRESCO_MS = 60_000;

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export default function SpxPage() {
  const [report, setReport] = useState<SpxReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const vivo = useRef(true);

  const mirar = useCallback(async () => {
    try {
      const res = await fetch("/api/spx", { cache: "no-store" });
      const data = await res.json();
      if (!vivo.current) return;
      if (!res.ok) { setError(data.error ?? "No se pudo consultar SPX."); setReport(null); }
      else { setReport(data as SpxReport); setError(null); }
    } catch {
      if (vivo.current) setError("Sin conexión con el servidor.");
    } finally {
      if (vivo.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    vivo.current = true;
    void mirar();
    // La ruta cachea 60s, así que refrescar a ese ritmo no gasta llamadas de más.
    const id = setInterval(mirar, REFRESCO_MS);
    return () => { vivo.current = false; clearInterval(id); };
  }, [mirar]);

  return (
    <main className="ideas-page">
      <div className="hb">
        <div className="hb-brand">
          <div className="hb-logo"><Logo size={30} /></div>
          <div className="hb-name">Interstellar Options</div>
          <div className="hb-chip">SPX · gamma de hoy</div>
        </div>
        <NavTabs />
      </div>

      <div className="ideas-body">
        {busy && !report && <div className="card wheel-empty">Leyendo la cadena 0DTE de SPX…</div>}
        {error && <div className="error">⚠ {error}</div>}

        {report && (
          <>
            <section className="card spx-head">
              <div className="spx-spot">
                <span className="muted">SPX</span>
                <strong>{money(report.spot)}</strong>
              </div>
              <div className="spx-facts">
                <span>Imán <b>{report.magnet != null ? money(report.magnet) : "—"}</b></span>
                <span>Inversión <b>{report.flip != null ? money(report.flip) : "—"}</b></span>
                <span>
                  Régimen{" "}
                  <b className={report.regime === "negative" ? "spx-neg" : "spx-pos"}>
                    {report.regime === "negative" ? "γ negativa" : "γ positiva"}
                  </b>
                </span>
                <span>Quedan <b>{report.hoursLeft.toFixed(1)}h</b></span>
              </div>
              <p className="wheel-disclaimer">
                Calculado con los <b>{report.contracts} contratos más negociados de hoy</b> (10 calls
                y 10 puts), pesando por volumen y no por open interest, que es de anoche. No es el
                mismo GEX que el del panel Pro.
              </p>
            </section>

            <div className="wheel-list">
              {report.alerts.map((a, i) => (
                <div key={i} className={`card spx-alert nivel-${a.level}`}>
                  <div className="spx-alert-head">
                    <b>{a.title}</b>
                    {a.price != null && <span className="spx-strikes">{money(a.price)}</span>}
                  </div>
                  <p>{a.detail}</p>
                </div>
              ))}
            </div>

            <section className="card">
              <h2 className="spx-nodes-title">Nodos de gamma más concentrados</h2>
              <div className="spx-nodes">
                {report.nodes.map((n) => (
                  <span key={n.strike} className={`spread-leg ${n.netGex >= 0 ? "" : "vender"}`}>
                    {money(n.strike)} {n.netGex >= 0 ? "call" : "put"}
                  </span>
                ))}
              </div>
            </section>

            <p className="wheel-disclaimer">
              Se refresca solo cada minuto. Última lectura:{" "}
              {new Date(report.checkedAt).toLocaleTimeString("es-ES")}.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
