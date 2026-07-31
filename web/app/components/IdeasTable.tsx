"use client";

import type { Idea } from "@/app/ideas/types";
import type { RiskProfile, Sizing } from "@/lib/risk";

const px = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0,
});
const compact = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1,
});
const cents = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2,
});

/** Dólares con céntimos cuando la cifra es chica — si no, un theta de $0.25/día sale como "$0". */
function dollars(n: number): string {
  return Math.abs(n) < 10 ? cents.format(n) : money.format(n);
}

export interface SizedIdea {
  idea: Idea;
  sizing: Sizing;
}

function contractLabel(i: Idea): string {
  const t = i.type === "call" ? "C" : "P";
  return `$${i.strike != null ? px.format(i.strike) : "?"}${t}`;
}

/** Fecha real + días restantes — nunca solo "57d". */
function expiryLabel(i: Idea): string {
  if (!i.expiration) return "—";
  const d = new Date(`${i.expiration}T00:00:00Z`);
  const fecha = d.toLocaleDateString("es-ES", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
  });
  return i.dte != null ? `${fecha} · ${i.dte}d` : fecha;
}

function timeLabel(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function HistoryCell({ i }: { i: Idea }) {
  if (!i.history || i.history.resolved === 0 || i.history.hitRate == null) {
    return <span className="muted">sin historial</span>;
  }
  const { hitRate, medianSessions, resolved } = i.history;
  const cls = hitRate >= 60 ? "up" : hitRate >= 45 ? "neutral" : "down";
  return (
    <span className={`hist ${cls}`} title={`Sobre ${resolved} flows pasados de ${i.ticker}`}>
      {Math.round(hitRate)}%
      {medianSessions != null && <span className="muted"> · ~{medianSessions} ses</span>}
    </span>
  );
}

/**
 * Segunda opinión de MarketSnack sobre la misma operación.
 *
 * Solo aparece cuando de verdad la hay: su score llega **sin calcular** en
 * buena parte del feed (y precisamente en las operaciones más grandes), así que
 * un chip permanente mentiría sobre cuántas veces hay confirmación.
 */
function ConsensusChip({ i }: { i: Idea }) {
  const c = i.consensus;
  if (!c || c.ms == null) return null;
  if (c.agreement === "solo_nuestro") {
    // 0DTE: se enseña el dato pero no puntúa (ver lib/consensus.ts).
    return <span className="chip chip-neutral" title={c.why}>MS {Math.round(c.ms * 10)}</span>;
  }
  const confirma = c.agreement === "confirma";
  return (
    <span className={`chip ${confirma ? "chip-prima" : "chip-neutral"}`} title={c.why}>
      {confirma ? "✓" : "≠"} MarketSnack {Math.round(c.ms * 10)}
    </span>
  );
}

function BindingChip({ s }: { s: Sizing }) {
  if (s.blocked) return <span className="chip chip-blocked">bloqueado</span>;
  if (s.maxContracts === 0) return <span className="chip chip-neutral">no alcanza</span>;
  return (
    <span className={`chip ${s.binding === "theta" ? "chip-theta" : "chip-prima"}`}>
      {s.binding === "theta" ? "θ" : "prima"}
    </span>
  );
}

/** Vista Estudiante — una tarjeta por idea, en lenguaje llano. */
function IdeaCard({
  idea: i, sizing: s, profile, starred, onStar,
}: SizedIdea & { profile: RiskProfile; starred: boolean; onStar: () => void }) {
  return (
    <article className={`idea-card ${s.blocked ? "is-blocked" : ""}`}>
      <header>
        <a className="idea-ticker" href={`/?ticker=${i.ticker}`}>{i.ticker}</a>
        <span className="idea-contract">{contractLabel(i)}</span>
        <span className="muted">{expiryLabel(i)}</span>
        {i.repeated && <span className="chip chip-neutral">🔁 repetido</span>}
        <ConsensusChip i={i} />
        <button
          className={`star ${starred ? "on" : ""}`}
          onClick={onStar}
          aria-label={starred ? "Quitar del watchlist" : "Guardar en el watchlist"}
          title={starred ? "Quitar del watchlist" : "Guardar en el watchlist"}
        >
          {starred ? "★" : "☆"}
        </button>
      </header>

      {s.blocked ? (
        <p className="idea-blocked">🚫 {s.blocked.detail}</p>
      ) : s.maxContracts === 0 ? (
        <p className="idea-blocked">
          Con {money.format(profile.accountSize)} al {profile.tolerancePct}% no alcanza ni para
          un contrato ({money.format(s.costPerContract)} cada uno).
        </p>
      ) : (
        <>
          <p className="idea-verdict">
            Máximo <strong>{s.maxContracts} {s.maxContracts === 1 ? "contrato" : "contratos"}</strong>
            {" — "}arriesgas {money.format(s.totalCost)} de tus {money.format(profile.accountSize)}
            {" "}({s.costPctOfAccount.toFixed(1)}%).
          </p>
          <p className="idea-sub muted">
            El theta se come {dollars(s.thetaBurnPerContract / Math.max(s.burnDays, 1))} al día
            por contrato: {dollars(s.totalBurn)} en {s.burnDays} días
            ({s.burnPctOfAccount.toFixed(1)}% de la cuenta).
            {s.binding === "theta"
              ? " Te frenó el theta, no el capital."
              : " Te frenó el capital, no el theta."}
            {s.fullyDecays && " ⚠️ A este ritmo el contrato se consume entero dentro del horizonte."}
          </p>
        </>
      )}

      <footer className="idea-foot muted">
        <span>Prima del flow {compact.format(i.premium)}</span>
        <span>·</span>
        {i.history && i.history.resolved > 0 ? (
          <span>este patrón acertó <HistoryCell i={i} /></span>
        ) : (
          <span className="muted">sin historial todavía</span>
        )}
        <span>·</span>
        <span>visto {timeLabel(i.timestamp)}</span>
      </footer>
    </article>
  );
}

export default function IdeasTable({
  rows,
  profile,
  view,
  horizonDays,
  starred = new Set(),
  onStar,
}: {
  rows: SizedIdea[];
  profile: RiskProfile;
  view: "estudiante" | "pro";
  horizonDays: number;
  /** Símbolos OCC ya guardados. Con default para que un render temprano no reviente. */
  starred?: Set<string>;
  onStar: (r: SizedIdea) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="muted empty-note">
        No hay ideas que pasen el filtro ahora mismo. El escaneo solo deja pasar flujo
        institucional en contratos con theta sano y tiempo suficiente.
      </p>
    );
  }

  if (view === "estudiante") {
    return (
      <div className="ideas-cards">
        {rows.map(({ idea, sizing }) => (
          <IdeaCard
            key={idea.id}
            idea={idea}
            sizing={sizing}
            profile={profile}
            starred={starred.has(idea.symbol)}
            onStar={() => onStar({ idea, sizing })}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="ideas-table">
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Contrato</th>
            <th>Vencimiento</th>
            <th className="num">Prima flow</th>
            <th className="num">Precio</th>
            <th className="num">θ/día</th>
            <th className="num">θ%</th>
            <th className="num">Quema {horizonDays}d</th>
            <th className="num">Límite</th>
            <th>Freno</th>
            <th className="num">% cuenta</th>
            <th>Historial</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ idea: i, sizing: s }) => (
            <tr key={i.id} className={s.blocked ? "row-blocked" : ""}>
              <td>
                <a className="idea-ticker" href={`/?ticker=${i.ticker}`}>{i.ticker}</a>
              </td>
              <td>
                {contractLabel(i)}
                {i.repeated && <span className="chip chip-neutral">🔁</span>}
              </td>
              <td className="muted">{expiryLabel(i)}</td>
              <td className="num">{compact.format(i.premium)}</td>
              <td className="num">${px.format(i.price)}</td>
              <td className="num">{px.format(Math.abs(i.theta))}</td>
              <td className="num">
                {i.thetaPctDaily != null ? `${i.thetaPctDaily.toFixed(1)}%` : "—"}
              </td>
              <td className="num">
                {s.blocked ? "—" : money.format(s.thetaBurnPerContract)}
                {s.fullyDecays && <span title="Se consume entera en el horizonte"> ⚠️</span>}
              </td>
              <td className="num strong">{s.blocked ? "—" : s.maxContracts}</td>
              <td><BindingChip s={s} /></td>
              <td className="num">
                {s.blocked || s.maxContracts === 0 ? "—" : `${s.costPctOfAccount.toFixed(1)}%`}
              </td>
              <td><HistoryCell i={i} /></td>
              <td>
                <button
                  className={`star ${starred.has(i.symbol) ? "on" : ""}`}
                  onClick={() => onStar(rows.find((r) => r.idea.id === i.id)!)}
                  aria-label={starred.has(i.symbol) ? "Quitar del watchlist" : "Guardar en el watchlist"}
                >
                  {starred.has(i.symbol) ? "★" : "☆"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
