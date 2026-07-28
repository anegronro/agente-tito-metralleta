"use client";

import { SPREAD_PRESETS, type SpreadPresetId } from "@/lib/spreads";

const ORDER: SpreadPresetId[] = ["conservador", "balanceado", "agresivo"];

export default function SpreadPresetCard({
  preset,
  onChange,
}: {
  preset: SpreadPresetId;
  onChange: (p: SpreadPresetId) => void;
}) {
  const active = SPREAD_PRESETS[preset];
  return (
    <div className="card wheel-preset">
      <div className="wheel-preset-head">
        <h2>Cómo quieres montar el spread</h2>
        <p>
          Cada perfil ya trae su delta, su plazo y su ancho de ala. El <b>ancho</b> es
          el mando que decide cuánto dinero pones en juego.
        </p>
      </div>
      <div className="wheel-preset-tabs">
        {ORDER.map((id) => (
          <button
            key={id}
            className={`wheel-preset-tab ${preset === id ? "on" : ""}`}
            onClick={() => onChange(id)}
            type="button"
          >
            {SPREAD_PRESETS[id].label}
          </button>
        ))}
      </div>
      <p className="wheel-preset-explain">{active.explain}</p>
      <div className="wheel-preset-facts">
        <span>Delta que vendes <b>{active.shortDeltaMin.toFixed(2)}–{active.shortDeltaMax.toFixed(2)}</b></span>
        <span>Delta que compras <b>{active.longDeltaMin.toFixed(2)}–{active.longDeltaMax.toFixed(2)}</b></span>
        <span>Ancho máximo <b>${active.maxWidth}</b></span>
        <span>Vencimiento <b>{active.dteMin}–{active.dteMax} días</b></span>
        <span>Cierra al <b>{active.takeProfitPct}%</b> del crédito</span>
      </div>
    </div>
  );
}
