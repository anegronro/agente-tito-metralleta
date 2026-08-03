"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RiskProfileCard, { DEFAULT_PROFILE, loadProfile } from "@/app/components/RiskProfileCard";
import SpreadPresetCard from "@/app/components/SpreadPresetCard";
import SpreadsTable, { type KindFilter } from "@/app/components/SpreadsTable";
import NavTabs from "@/app/components/NavTabs";
import Logo from "@/app/components/Logo";
import { sortByAffordThenScore } from "@/lib/spreadAfford";
import type { SpreadCandidate, SpreadPresetId } from "@/lib/spreads";
import type { RiskProfile } from "@/lib/risk";
import type { SpreadSseEvent } from "./types";

const KEY_VIEW = "tito.view";
const KEY_PRESET = "tito.spreads.preset";

type SpreadMeta = { scanned: number; failed: number; withCandidates: number; degraded: boolean };

export default function SpreadsPage() {
  const [profile, setProfile] = useState<RiskProfile>(DEFAULT_PROFILE);
  const [view, setView] = useState<"estudiante" | "pro">("estudiante");
  // 0DTE por defecto: es la prioridad que pidió Angel. Fuera de sesión la ruta
  // lo dice con su propio mensaje, que es más informativo que esconder el modo.
  const [preset, setPreset] = useState<SpreadPresetId>("0dte");
  const [filter, setFilter] = useState<KindFilter>(null);

  const [candidates, setCandidates] = useState<SpreadCandidate[] | null>(null);
  const [meta, setMeta] = useState<SpreadMeta | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    setProfile(loadProfile());
    const v = window.localStorage.getItem(KEY_VIEW);
    if (v === "pro" || v === "estudiante") setView(v);
    const p = window.localStorage.getItem(KEY_PRESET);
    if (p === "conservador" || p === "balanceado" || p === "agresivo" || p === "0dte") setPreset(p);
  }, []);

  const scan = useCallback((which: SpreadPresetId) => {
    esRef.current?.close();
    setBusy(true); setError(null); setSteps([]); setCandidates(null); setMeta(null);
    const es = new EventSource(`/api/spreads?preset=${which}`);
    esRef.current = es;
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data) as SpreadSseEvent;
      if (data.type === "step") setSteps((s) => [...s, data.label]);
      else if (data.type === "done") { setCandidates(data.candidates); setMeta(data.meta); setBusy(false); es.close(); }
      else if (data.type === "error") { setError(data.message); setBusy(false); es.close(); }
    };
    es.onerror = () => { setError("Se cortó la conexión con el escáner."); setBusy(false); es.close(); };
  }, []);

  useEffect(() => { scan(preset); return () => esRef.current?.close(); }, [scan, preset]);

  const pickPreset = (p: SpreadPresetId) => { setPreset(p); window.localStorage.setItem(KEY_PRESET, p); };
  const pickView = (v: "estudiante" | "pro") => { setView(v); window.localStorage.setItem(KEY_VIEW, v); };

  // El sizing corre AQUÍ, en el cliente: el perfil vive en localStorage y no
  // viaja al servidor. Misma frontera que /ideas y /wheel.
  const rows = useMemo(
    () => (candidates ? sortByAffordThenScore(candidates, profile) : []),
    [candidates, profile],
  );

  const caben = rows.filter((r) => !r.blocked && r.afford.maxContracts > 0).length;

  return (
    <main className="ideas-page">
      <div className="hb">
        <div className="hb-brand">
          <div className="hb-logo"><Logo size={30} /></div>
          <div className="hb-name">Interstellar Options</div>
          <div className="hb-chip">Spreads · riesgo definido</div>
        </div>
        <NavTabs />
      </div>

      <div className="ideas-body">
        <SpreadPresetCard preset={preset} onChange={pickPreset} />
        <RiskProfileCard profile={profile} onChange={setProfile} />

        <div className="ideas-controls">
          <div className="view-toggle">
            <button className={view === "estudiante" ? "active" : ""} onClick={() => pickView("estudiante")}>👤 Estudiante</button>
            <button className={view === "pro" ? "active" : ""} onClick={() => pickView("pro")}>⚡ Pro</button>
          </div>
          <button className="rescan" onClick={() => scan(preset)} disabled={busy}>↻ Volver a escanear</button>
        </div>

        {busy && (
          <div className="card wheel-empty">
            {steps.length > 0 ? steps[steps.length - 1] : "Escaneando el mercado…"}
          </div>
        )}
        {error && <div className="error">⚠ {error}</div>}

        {candidates && meta && (
          <>
            <div className="wheel-status">
              Escaneadas {meta.scanned} · {caben} te caben · {rows.filter((r) => !r.blocked).length} estructuras
              {meta.degraded && <span className="wheel-tag warn"> datos parciales: falló más de la mitad</span>}
            </div>
            <p className="wheel-disclaimer">
              El crédito se calcula <b>vendiendo al bid y comprando al ask</b>: es el peor
              relleno realista, así que en tu bróker deberías conseguir esto o algo mejor.
              Son candidatos, no órdenes — confirma los precios antes de entrar.
            </p>
            <SpreadsTable rows={rows} view={view} filter={filter} onFilter={setFilter} />
          </>
        )}
      </div>
    </main>
  );
}
