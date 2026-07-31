// TEMPORAL — análisis de acuerdo entre el score de MarketSnack y el nuestro.
// Se borra al terminar. No forma parte de la suite.
import { describe, it } from "vitest";
import { readFileSync } from "fs";
import { classifyFlow, unusualTradeScore, UNUSUAL_TRADE_THRESHOLD, type RawTrade } from "./flow";

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

function spearman(a: number[], b: number[]): number {
  const rank = (v: number[]) => {
    const idx = v.map((x, i) => [x, i] as [number, number]).sort((p, q) => p[0] - q[0]);
    const r = new Array(v.length).fill(0);
    idx.forEach(([, i], k) => (r[i] = k + 1));
    return r;
  };
  return pearson(rank(a), rank(b));
}

describe("acuerdo de scores", () => {
  it("mide", () => {
    for (const [nombre, file] of [
      ["mercado general", "/tmp/base.json"],
      ["0dte-momentum-spike", "/tmp/pre_0dte-momentum-spike.json"],
      ["unusual-flow-spike", "/tmp/pre_unusual-flow-spike.json"],
    ] as const) {
      let raw: RawTrade[];
      try {
        raw = JSON.parse(readFileSync(file, "utf8")).list as RawTrade[];
      } catch { continue; }
      const { rows } = classifyFlow(raw, new Date());
      const pares = rows
        .map((r) => ({ ms: r.score, mio: unusualTradeScore(r).total, r }))
        .filter((p) => typeof p.ms === "number" && Number.isFinite(p.mio));
      if (pares.length < 5) { console.log(`\n${nombre}: muestra insuficiente`); continue; }

      const ms = pares.map((p) => p.ms);
      const mio = pares.map((p) => p.mio);
      console.log(`\n── ${nombre} (n=${pares.length})`);
      console.log(`   Pearson  r = ${pearson(ms, mio).toFixed(3)}`);
      console.log(`   Spearman ρ = ${spearman(ms, mio).toFixed(3)}`);
      console.log(`   MS   → media ${(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(1)}  rango ${Math.min(...ms)}-${Math.max(...ms)}`);
      console.log(`   mío  → media ${(mio.reduce((a, b) => a + b, 0) / mio.length).toFixed(1)}  rango ${Math.min(...mio)}-${Math.max(...mio)}`);

      // ¿Coinciden en lo que consideran "top"?
      const topMs = new Set([...pares].sort((a, b) => b.ms - a.ms).slice(0, Math.ceil(pares.length * 0.25)).map((p) => p.r.id));
      const topMio = new Set([...pares].sort((a, b) => b.mio - a.mio).slice(0, Math.ceil(pares.length * 0.25)).map((p) => p.r.id));
      const solapan = [...topMs].filter((id) => topMio.has(id)).length;
      console.log(`   top-25%: coinciden ${solapan} de ${topMs.size}`);

      // Desacuerdos más fuertes.
      const norm = pares.map((p) => ({ ...p, z: p.ms / 100 - p.mio / 10 }));
      const peores = [...norm].sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 3);
      for (const p of peores) {
        console.log(`   ✗ ${p.r.underlying} ${p.r.type} $${(p.r.premium / 1000).toFixed(0)}K dte=${p.r.dte} — MS ${p.ms}/100 vs mío ${p.mio}/10`);
      }
      const inusualesMios = pares.filter((p) => p.mio >= UNUSUAL_TRADE_THRESHOLD).length;
      console.log(`   inusuales para mí (≥${UNUSUAL_TRADE_THRESHOLD}): ${inusualesMios}`);
    }
  });
});
