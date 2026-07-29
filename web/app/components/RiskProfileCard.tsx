"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { THETA_BUDGET_PCT, budgetsOf, type RiskProfile } from "@/lib/risk";
import {
  MIN_CODE_LENGTH, normalizeCode, pickNewer, toProfile, validateCode,
  type SyncedProfile,
} from "@/lib/profileSync";

const KEY_ACCOUNT = "tito.risk.accountSize";
const KEY_TOLERANCE = "tito.risk.tolerancePct";
const KEY_UPDATED = "tito.risk.updatedAt";
const KEY_CODE = "tito.risk.syncCode";

export const DEFAULT_PROFILE: RiskProfile = { accountSize: 10_000, tolerancePct: 4 };

const money = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0,
});

/** Lee el perfil de localStorage. Solo cliente. */
export function loadProfile(): RiskProfile {
  if (typeof window === "undefined") return DEFAULT_PROFILE;
  const account = Number(window.localStorage.getItem(KEY_ACCOUNT));
  const tolerance = Number(window.localStorage.getItem(KEY_TOLERANCE));
  return {
    accountSize: Number.isFinite(account) && account > 0 ? account : DEFAULT_PROFILE.accountSize,
    tolerancePct:
      Number.isFinite(tolerance) && tolerance > 0 ? tolerance : DEFAULT_PROFILE.tolerancePct,
  };
}

/** Marca de tiempo de la última edición local — la usa `pickNewer`. */
function localStamp(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(KEY_UPDATED) ?? "";
}

type SyncState = "off" | "syncing" | "ok" | "error";

export default function RiskProfileCard({
  profile,
  onChange,
}: {
  profile: RiskProfile;
  onChange: (p: RiskProfile) => void;
}) {
  // El input se edita como texto para no pelear con el 0 inicial al teclear.
  const [draft, setDraft] = useState(String(profile.accountSize));
  const [code, setCode] = useState("");
  const [codeDraft, setCodeDraft] = useState("");
  const [sync, setSync] = useState<SyncState>("off");
  const [syncMsg, setSyncMsg] = useState("");
  const [openSync, setOpenSync] = useState(false);

  // Lo último que se acordó con el servidor. Corta el ping-pong: sin esto, bajar
  // un perfil remoto dispararía el efecto de subida y volvería a mandarlo.
  const acordado = useRef("");

  useEffect(() => {
    setDraft(String(profile.accountSize));
  }, [profile.accountSize]);

  const stampLocal = () => {
    window.localStorage.setItem(KEY_UPDATED, new Date().toISOString());
  };

  const commitAccount = (raw: string) => {
    const n = Number(raw.replace(/[^0-9.]/g, ""));
    const accountSize = Number.isFinite(n) && n > 0 ? n : 0;
    window.localStorage.setItem(KEY_ACCOUNT, String(accountSize));
    stampLocal();
    onChange({ ...profile, accountSize });
  };

  const commitTolerance = (tolerancePct: number) => {
    window.localStorage.setItem(KEY_TOLERANCE, String(tolerancePct));
    stampLocal();
    onChange({ ...profile, tolerancePct });
  };

  // ── Bajada: al montar, si ya hay código guardado ──
  const pull = useCallback(async (theCode: string) => {
    setSync("syncing"); setSyncMsg("");
    try {
      const res = await fetch(`/api/profile?code=${encodeURIComponent(theCode)}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) { setSync("error"); setSyncMsg(data.error ?? "No se pudo sincronizar."); return; }

      const remote: SyncedProfile | null = data.profile ?? null;
      const local: SyncedProfile | null = {
        accountSize: profile.accountSize,
        tolerancePct: profile.tolerancePct,
        updatedAt: localStamp(),
      };
      const gana = pickNewer(local.updatedAt ? local : null, remote);

      if (gana && gana === remote) {
        const p = toProfile(remote!);
        window.localStorage.setItem(KEY_ACCOUNT, String(p.accountSize));
        window.localStorage.setItem(KEY_TOLERANCE, String(p.tolerancePct));
        window.localStorage.setItem(KEY_UPDATED, remote!.updatedAt);
        acordado.current = JSON.stringify(p);
        onChange(p);
        setSyncMsg(remote!.device ? `Traído de tu ${remote!.device}.` : "Perfil traído del servidor.");
      } else {
        setSyncMsg(remote ? "Tu copia local es más reciente." : "Código nuevo: se guardará lo de aquí.");
      }
      setSync("ok");
    } catch {
      setSync("error"); setSyncMsg("Sin conexión con el servidor.");
    }
  }, [onChange, profile.accountSize, profile.tolerancePct]);

  useEffect(() => {
    const saved = window.localStorage.getItem(KEY_CODE);
    if (saved) { setCode(saved); setCodeDraft(saved); void pull(saved); }
    // A propósito solo al montar: `pull` depende del perfil y re-ejecutarlo en
    // cada cambio pelearía con la subida de abajo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Subida: con retardo, para no mandar una petición por cada píxel del slider ──
  useEffect(() => {
    if (!code) return;
    const actual = JSON.stringify({ accountSize: profile.accountSize, tolerancePct: profile.tolerancePct });
    if (actual === acordado.current) return;

    const id = setTimeout(async () => {
      try {
        const res = await fetch("/api/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code,
            accountSize: profile.accountSize,
            tolerancePct: profile.tolerancePct,
          }),
        });
        if (!res.ok) { setSync("error"); setSyncMsg("No se pudo guardar."); return; }
        const data = await res.json();
        acordado.current = actual;
        window.localStorage.setItem(KEY_UPDATED, data.profile.updatedAt);
        setSync("ok"); setSyncMsg("Guardado para tus otros dispositivos.");
      } catch {
        setSync("error"); setSyncMsg("Sin conexión con el servidor.");
      }
    }, 900);
    return () => clearTimeout(id);
  }, [code, profile.accountSize, profile.tolerancePct]);

  const activar = () => {
    const check = validateCode(codeDraft);
    if (!check.ok) { setSync("error"); setSyncMsg(check.reason!); return; }
    const limpio = normalizeCode(codeDraft);
    window.localStorage.setItem(KEY_CODE, limpio);
    setCode(limpio);
    void pull(limpio);
  };

  const desactivar = () => {
    window.localStorage.removeItem(KEY_CODE);
    setCode(""); setCodeDraft(""); setSync("off"); setSyncMsg("");
    acordado.current = "";
  };

  const budgets = budgetsOf(profile);

  return (
    <section className="risk-card">
      <div className="risk-head">
        <h2>Tu perfil de riesgo</h2>
        <span className="muted">
          {code
            ? "Se sincroniza entre tus dispositivos con tu código."
            : "Se guarda solo en este navegador — tu saldo nunca sale de tu equipo."}
        </span>
      </div>

      <div className="risk-controls">
        <label className="risk-field">
          <span>Tamaño de cuenta</span>
          <input
            className="risk-input"
            inputMode="decimal"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => commitAccount(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            aria-label="Tamaño de cuenta en dólares"
          />
        </label>

        <label className="risk-field grow">
          <span>
            Riesgo por trade — <strong>{profile.tolerancePct}%</strong>
          </span>
          <input
            className="risk-slider"
            type="range"
            min={1}
            max={10}
            step={0.5}
            value={profile.tolerancePct}
            onChange={(e) => commitTolerance(Number(e.target.value))}
            aria-label="Tolerancia al riesgo como porcentaje de la cuenta"
          />
          <span className="risk-scale">
            <span>conservador 1%</span>
            <span>agresivo 10%</span>
          </span>
        </label>
      </div>

      <div className="risk-budgets">
        <div>
          <span className="muted">Capital máximo por trade</span>
          <strong>{money.format(budgets.premium)}</strong>
        </div>
        <div>
          <span className="muted">Máxima quema de theta ({THETA_BUDGET_PCT}%)</span>
          <strong>{money.format(budgets.theta)}</strong>
        </div>
      </div>

      <div className="risk-sync">
        <button type="button" className="risk-sync-toggle" onClick={() => setOpenSync((v) => !v)}>
          {code ? `🔗 Sincronizado (${code})` : "🔗 Sincronizar entre dispositivos"}
        </button>

        {openSync && (
          <div className="risk-sync-body">
            <p className="muted">
              Escribe la <b>misma frase</b> en tu móvil y en tu portátil y los dos usarán el mismo
              saldo. Mínimo {MIN_CODE_LENGTH} caracteres. No es una contraseña de nadie: solo
              identifica tu perfil, y en el servidor se guarda cifrada en un solo sentido.
            </p>
            <div className="risk-sync-row">
              <input
                className="risk-input"
                value={codeDraft}
                onChange={(e) => setCodeDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") activar(); }}
                placeholder="p.ej. cohete-azul-42"
                aria-label="Código de sincronización"
                autoComplete="off"
              />
              <button type="button" className="rescan" onClick={activar}>
                {code ? "Volver a traer" : "Activar"}
              </button>
              {code && (
                <button type="button" className="risk-sync-off" onClick={desactivar}>
                  Desconectar
                </button>
              )}
            </div>
            {syncMsg && (
              <p className={`risk-sync-msg ${sync === "error" ? "bad" : "good"}`}>
                {sync === "syncing" ? "Sincronizando…" : syncMsg}
              </p>
            )}
          </div>
        )}
      </div>

      <p className="risk-note">
        Los números de abajo son un <strong>techo</strong>, no una sugerencia de compra. El
        límite de theta sale de la banda del documento de Inusualidad: un contrato que pierde
        más del {THETA_BUDGET_PCT}% de su valor al día se descarta por lotería.
      </p>
    </section>
  );
}
