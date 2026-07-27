// GET /api/history?ticker=XXX — barras diarias del subyacente para la gráfica.

import { MassiveError } from "@/lib/massive";
import { fetchDaily } from "@/lib/marketData";
import { SchwabError } from "@/lib/schwab";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!ticker) {
    return Response.json({ error: "ticker requerido" }, { status: 400 });
  }
  try {
    const bars = await fetchDaily(ticker);
    return Response.json({ ticker, bars });
  } catch (err) {
    // El mensaje del proveedor viaja tal cual: "Límite de tasa de Massive
    // alcanzado" o "La sesión de Schwab expiró" dicen qué hacer. Antes esto
    // devolvía un array vacío con 200 y la app se colgaba sin explicación.
    const message =
      err instanceof MassiveError || err instanceof SchwabError
        ? err.message
        : "Error al cargar histórico.";
    return Response.json({ error: message }, { status: 502 });
  }
}
