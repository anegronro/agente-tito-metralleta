"use client";

import { useEffect, useState } from "react";
import type { HealthReport, SourceHealth } from "@/app/api/health/route";

/**
 * Aviso de fuente caída. Va en la cabecera de todas las páginas.
 *
 * Existe porque la forma de enterarse de que la cookie de MarketSnack había
 * caducado era abrir /ideas y encontrársela rota. Ahora lo dice antes.
 *
 * Cuando todo está bien NO PINTA NADA: un semáforo permanente en verde se
 * vuelve invisible en dos días y deja de avisar cuando de verdad hace falta.
 */
const NOMBRE: Record<string, string> = {
  marketsnack: "MarketSnack (flujo e ideas)",
  schwab: "Schwab (cadena de opciones)",
};

export default function HealthBanner() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [oculto, setOculto] = useState(false);

  useEffect(() => {
    let vivo = true;
    const mirar = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as HealthReport;
        if (vivo) setReport(data);
      } catch {
        // Sin red no se avisa de nada: el propio fallo ya es evidente.
      }
    };
    void mirar();
    // Cada 5 min. La ruta cachea 60s, así que esto no castiga a nadie.
    const id = setInterval(mirar, 5 * 60_000);
    return () => { vivo = false; clearInterval(id); };
  }, []);

  if (!report || oculto) return null;

  const rotas = (["marketsnack", "schwab"] as const)
    .map((k) => [k, report[k]] as [string, SourceHealth])
    .filter(([, s]) => s.state === "caducado" || s.state === "error");

  if (rotas.length === 0) return null;

  return (
    <div className="health-banner" role="status">
      <div className="health-banner-body">
        {rotas.map(([clave, s]) => (
          <div key={clave} className="health-row">
            <b>{s.state === "caducado" ? "⏳" : "⚠"} {NOMBRE[clave] ?? clave}</b>
            <span>{s.detail}</span>
            {s.fix && <span className="health-fix">{s.fix}</span>}
          </div>
        ))}
      </div>
      <button
        type="button"
        className="health-close"
        onClick={() => setOculto(true)}
        aria-label="Ocultar aviso"
      >
        ✕
      </button>
    </div>
  );
}
