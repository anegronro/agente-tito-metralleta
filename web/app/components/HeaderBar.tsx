"use client";

import { useState } from "react";
import type { CompanyInfo } from "@/lib/types";
import { pct, px } from "../format";
import NavTabs from "./NavTabs";
import Logo from "@/app/components/Logo";

const QUICK = ["TSLA", "NVDA", "SPY", "AAPL"];

export default function HeaderBar({
  ticker,
  company,
  busy,
  onSearch,
}: {
  ticker: string | null;
  company: CompanyInfo | null;
  busy: boolean;
  onSearch: (t: string) => void;
}) {
  const [q, setQ] = useState("");

  const submit = () => {
    const t = q.trim().toUpperCase();
    if (!t || busy) return;
    setQ("");
    onSearch(t);
  };

  return (
    <div className="hb">
      <div className="hb-brand">
        <div className="hb-logo"><Logo size={30} /></div>
        <div className="hb-name">Interstellar Options</div>
        <div className="hb-chip">AI Options Agent</div>
      </div>
      <NavTabs />
      <div className="hb-tabs">
        {QUICK.map((s) => (
          <button
            key={s}
            type="button"
            className={`hb-tab ${ticker === s ? "on" : ""}`}
            onClick={() => !busy && onSearch(s)}
          >
            {s}
          </button>
        ))}
      </div>
      <input
        className="hb-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        placeholder="Buscar ticker…"
        spellCheck={false}
      />
      <div className="hb-right">
        {company && (
          <>
            <div className="hb-ticker-name">{company.name ?? company.ticker}</div>
            {company.price != null && <div className="hb-price">${px.format(company.price)}</div>}
            {company.changePercent != null && (
              <div className="hb-chg" style={{ color: company.changePercent >= 0 ? "#12b76a" : "#f04438" }}>
                {pct.format(company.changePercent)}%
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
