"use client";

import { useState } from "react";
import { familyOf, type Leg, type SpreadKind } from "@/lib/spreads";
import type { AffordableSpread } from "@/lib/spreadAfford";

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const money2 = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${n.toFixed(1)}%`;

/**
 * Encaje con el contexto (GEX + flujo + noticias + niveles). Va en la cabecera
 * de la fila y no escondido en el desplegable: es la diferencia entre "este
 * spread está bien construido" y "además el mercado empuja a tu favor", y sin
 * verlo el score de 100 no se puede interpretar.
 */
const ALIGN_CLASS: Record<string, string> = {
  "a favor": "good",
  neutro: "meh",
  "en contra": "bad",
};
const ALIGN_ICON: Record<string, string> = {
  "a favor": "▲",
  neutro: "•",
  "en contra": "▼",
};

/** Filtro por estructura. `null` = todas. */
export type KindFilter = SpreadKind | null;

const FILTERS: { id: KindFilter; label: string }[] = [
  { id: null, label: "Todas" },
  { id: "put_credit", label: "Put credit" },
  { id: "call_credit", label: "Call credit" },
  { id: "iron_condor", label: "Iron condor" },
  { id: "call_debit", label: "Call debit" },
  { id: "put_debit", label: "Put debit" },
];

export default function SpreadsTable({
  rows,
  view,
  filter,
  onFilter,
}: {
  rows: AffordableSpread[];
  view: "estudiante" | "pro";
  filter: KindFilter;
  onFilter: (k: KindFilter) => void;
}) {
  const shown = filter ? rows.filter((r) => r.kind === filter) : rows;

  return (
    <>
      <div className="spread-filters">
        {FILTERS.map((f) => (
          <button
            key={f.id ?? "todas"}
            type="button"
            className={`spread-filter ${filter === f.id ? "on" : ""}`}
            onClick={() => onFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="card wheel-empty">
          Sin estructuras con este filtro. Prueba otro preset o quita el filtro.
        </div>
      ) : (
        <div className="wheel-list">
          {shown.map((c, i) => (
            <SpreadRow key={`${c.ticker}-${c.kind}-${c.strikesLabel}-${c.expiration}-${i}`} c={c} view={view} />
          ))}
        </div>
      )}
    </>
  );
}

/** "Vende PUT $100 · Compra PUT $95" — lo que tecleas en el bróker. */
function LegsLine({ legs }: { legs: Leg[] }) {
  return (
    <div className="spread-legs">
      {legs.map((l, i) => (
        <span key={i} className={`spread-leg ${l.action}`}>
          {l.action === "vender" ? "Vende" : "Compra"} {l.type.toUpperCase()} ${l.strike}
        </span>
      ))}
    </div>
  );
}

function SpreadRow({ c, view }: { c: AffordableSpread; view: "estudiante" | "pro" }) {
  const [open, setOpen] = useState(false);

  if (c.blocked) {
    return (
      <div className="card wheel-row blocked">
        <div className="wheel-row-head">
          <b>{c.ticker}</b> {c.label} {c.strikesLabel} · {c.expiration}
          <span className="wheel-tag danger">Ilíquido — no operable</span>
        </div>
        <p className="wheel-blocked-why">
          {c.blockReason === "sin_bid" && "Alguna pata no tiene precio de compra: no podrías montarlo."}
          {c.blockReason === "spread_ancho" && "La horquilla es demasiado ancha, y aquí la cruzas dos veces."}
          {c.blockReason === "oi_bajo" && "Muy pocos contratos abiertos en alguna pata: no hay con quién operar."}
        </p>
      </div>
    );
  }

  const m = c.metrics!;
  const s = c.score!;
  const a = c.afford;
  const esCredito = familyOf(c.kind) === "credito";
  const cabe = a.maxContracts > 0;

  return (
    <div className={`card wheel-row ${cabe ? "" : "unafford"}`}>
      <button className="wheel-row-head" onClick={() => setOpen((v) => !v)} type="button">
        <span>
          <b>{c.ticker}</b> {c.label} <span className="spread-strikes">{c.strikesLabel}</span> · {c.expiration} ({c.dte}d)
        </span>
        <span className="spread-head-right">
          <span className={`spread-align ${ALIGN_CLASS[s.alignment.band] ?? ""}`}>
            {ALIGN_ICON[s.alignment.band] ?? ""} {s.alignment.band}
          </span>
          <span className="wheel-score">{s.total}<small>/100</small></span>
        </span>
      </button>

      <LegsLine legs={c.legs} />

      {view === "estudiante" ? (
        <p className="wheel-plain">
          {esCredito ? (
            <>Cobras <b>{money(m.credit)}</b> por adelantado y lo máximo que puedes perder son <b>{money(m.maxLoss)}</b>.</>
          ) : (
            <>Pagas <b>{money(m.debit)}</b>, y eso es <b>todo</b> lo que puedes perder. Puedes ganar hasta <b>{money(m.maxProfit)}</b>.</>
          )}{" "}
          {c.thesis} Hay <b>{Math.round(m.pop)}%</b> de que salga bien.{" "}
          {cabe ? (
            <>Con tu cuenta, tu límite es <b>{a.maxContracts}</b> {a.maxContracts === 1 ? "spread" : "spreads"}
            {" "}({money(a.totalRisk)} en riesgo).</>
          ) : (
            <>
              <b>No te cabe:</b> te faltan {money(a.shortfall)}.
              {a.suggestedWidth != null && <> Con alas de ~${a.suggestedWidth} sí entraría.</>}
            </>
          )}{" "}
          {s.alignment.band === "a favor" && <b>El mercado empuja a favor de esta apuesta.</b>}
          {s.alignment.band === "en contra" && <b>Ojo: el mercado empuja en contra de esta apuesta.</b>}
        </p>
      ) : (
        <div className="wheel-grid">
          <span>{esCredito ? "Crédito" : "Débito"} <b>{money(esCredito ? m.credit : m.debit)}</b> <small>({money2(Math.abs(m.net))}/acc)</small></span>
          <span>Ancho <b>${m.width}</b></span>
          <span>Riesgo máx <b>{money(m.maxLoss)}</b></span>
          <span>Ganancia máx <b>{money(m.maxProfit)}</b></span>
          <span>R/R <b>{pct(m.returnOnRisk)}</b></span>
          <span>Anualizado <b>{pct(m.annualizedPct)}</b></span>
          <span>POP <b>{Math.round(m.pop)}%</b></span>
          <span>BE <b>{m.breakevens.map((b) => money2(b)).join(" / ")}</b></span>
          <span>Contratos <b>{a.maxContracts}</b> {a.binding && <small>(topa {a.binding})</small>}</span>
          {!cabe && <span className="wheel-tag warn">faltan {money(a.shortfall)}</span>}
        </div>
      )}

      {open && (
        <div className="wheel-outcomes">
          {esCredito ? (
            <>
              <div><b>Si acierta</b> ({Math.round(m.pop)}%): las dos patas expiran sin valor y te quedas los {money(m.credit)}.</div>
              <div><b>Si falla del todo</b>: pierdes {money(m.maxLoss)}, y ni un dólar más — el ala comprada pone el tope.</div>
              <div><b>Punto de dolor</b>: {m.breakevens.map((b) => money2(b)).join(" y ")}. El precio de hoy es {money2(c.spot)}.</div>
            </>
          ) : (
            <>
              <div><b>Si acierta</b> ({Math.round(m.pop)}%): puedes llegar a ganar {money(m.maxProfit)} sobre los {money(m.debit)} que pusiste.</div>
              <div><b>Si falla</b>: pierdes los {money(m.debit)} que pagaste. Es todo tu riesgo, ya está desembolsado.</div>
              <div><b>Punto de dolor</b>: {m.breakevens.map((b) => money2(b)).join(" y ")}. El precio de hoy es {money2(c.spot)}.</div>
            </>
          )}
          <div className="wheel-why">
            {[s.alignment, s.reward, s.pop, s.liquidity, s.ivFit, s.earnings].map((part, i) => (
              <div key={i}>· {part.why}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
