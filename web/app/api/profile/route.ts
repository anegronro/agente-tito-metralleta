// GET /api/profile?code=…   → perfil guardado bajo ese código (o null)
// POST /api/profile          → guarda { code, accountSize, tolerancePct }
//
// Es la ÚNICA ruta del agente por la que pasa el saldo, y solo porque el usuario
// pidió sincronizarlo entre sus dispositivos. Todo lo demás (sizing de /ideas,
// /wheel y /spreads) sigue calculándose en el navegador.
//
// No hay login: la autorización ES el código, y por eso `profileStore` guarda
// su huella y nunca el código en claro. Ver la nota de `profileSync.ts` sobre
// por qué no es un archivo único en el servidor.

import { loadProfile, saveProfile } from "@/lib/profileStore";
import { deviceLabel, sanitize, validateCode } from "@/lib/profileSync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Nunca cachear: es estado por usuario y cambiaría de dueño en un proxy. */
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: Request) {
  const code = new URL(req.url).searchParams.get("code") ?? "";
  const check = validateCode(code);
  if (!check.ok) {
    return Response.json({ error: check.reason }, { status: 400, headers: NO_STORE });
  }

  const profile = await loadProfile(code);
  return Response.json({ profile }, { headers: NO_STORE });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Cuerpo inválido." }, { status: 400, headers: NO_STORE });
  }

  const { code, ...rest } = (body ?? {}) as Record<string, unknown>;
  const check = validateCode(typeof code === "string" ? code : "");
  if (!check.ok) {
    return Response.json({ error: check.reason }, { status: 400, headers: NO_STORE });
  }

  const device = deviceLabel(req.headers.get("user-agent") ?? "");
  const profile = sanitize({ ...rest, device }, new Date());
  if (!profile) {
    return Response.json(
      { error: "El perfil necesita un saldo y una tolerancia mayores que cero." },
      { status: 400, headers: NO_STORE },
    );
  }

  await saveProfile(code as string, profile);
  return Response.json({ profile }, { headers: NO_STORE });
}
