// GET /api/chain?ticker=XXX — transmite los pasos del proceso por SSE y al final los datos.

import { countExpirations, sortByOpenInterestDesc, toRow } from "@/lib/compute";
import { structureScore } from "@/lib/structure";
import { saveChainSnapshot, type ChainSnapshot } from "@/lib/chainStore";
import { MassiveError } from "@/lib/massive";
// La cadena viene del proveedor activo (Schwab si hay credenciales); el resto de
// datos de empresa sigue saliendo de Massive, que sí los sirve con este plan.
import { fetchChain, fetchCompanyInfo } from "@/lib/marketData";
import { SchwabError } from "@/lib/schwab";
import type { ChainEvent, ChainMeta, Row } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sse(event: ChainEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChainEvent) =>
        controller.enqueue(encoder.encode(sse(event)));

      try {
        if (!ticker) {
          send({ type: "error", message: "Escribe un ticker (p. ej. AAPL)." });
          controller.close();
          return;
        }

        send({ type: "step", label: `Buscando información de ${ticker}…` });
        const company = await fetchCompanyInfo(ticker);
        send({ type: "company", company });

        send({ type: "step", label: "Conectando con Massive…" });

        const { contracts, underlyingPrice, pages, truncated } =
          await fetchChain(ticker, {
            onPage: (page, accumulated) => {
              send({
                type: "step",
                label: `Descargando option chain de ${ticker} — página ${page}`,
                detail: `${accumulated} contratos`,
              });
            },
          });

        if (contracts.length === 0) {
          send({ type: "error", message: `Sin contratos para "${ticker}".` });
          controller.close();
          return;
        }

        let rows: Row[] = contracts.map(toRow);
        const expirations = countExpirations(rows);
        send({
          type: "step",
          label: `Consolidando ${rows.length} contratos en ${expirations} vencimientos…`,
        });

        send({ type: "step", label: "Calculando Open Premium por strike…" });
        send({ type: "step", label: "Calculando Valor Nocional…" });

        send({ type: "step", label: "Ordenando por Open Interest (mayor → menor)…" });
        rows = sortByOpenInterestDesc(rows);

        send({ type: "step", label: "Analizando acumulación por strike y vencimiento…" });
        const structure = structureScore(rows);

        // Foto diaria de la cadena: el historial de 45 días se acumula hacia adelante.
        send({ type: "step", label: "Guardando foto diaria de la cadena…" });
        let history: ChainSnapshot[] = [];
        try {
          history = (await saveChainSnapshot(ticker, structure)).snapshots;
        } catch {
          // el guardado no debe romper el reporte
        }

        const meta: ChainMeta = {
          ticker,
          underlyingPrice,
          contractCount: rows.length,
          expirationCount: expirations,
          pages,
          truncated,
        };
        send({ type: "done", rows, meta, structure, history });
      } catch (err) {
        // Reconocer AMBOS proveedores: con solo MassiveError, un fallo de Schwab
        // caía en el genérico y encima culpaba a Massive. El mensaje del
        // proveedor dice qué hacer; el genérico no dice nada.
        const message =
          err instanceof MassiveError || err instanceof SchwabError
            ? err.message
            : err instanceof Error
              ? `Error inesperado: ${err.message}`
              : "Error inesperado al consultar los datos de mercado.";
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
