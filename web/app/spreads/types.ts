// Tipos del evento SSE del screener de spreads. Ver app/api/spreads/route.ts.

import type { SpreadCandidate } from "@/lib/spreads";

export type SpreadIdea = SpreadCandidate;

export interface SpreadStepEvent {
  type: "step";
  label: string;
}

export interface SpreadDoneEvent {
  type: "done";
  candidates: SpreadIdea[];
  meta: {
    preset: string;
    scanned: number;
    failed: number;
    withCandidates: number;
    /** true si falló más de la mitad del universo. */
    degraded: boolean;
  };
}

export interface SpreadErrorEvent {
  type: "error";
  message: string;
}

export type SpreadSseEvent = SpreadStepEvent | SpreadDoneEvent | SpreadErrorEvent;
