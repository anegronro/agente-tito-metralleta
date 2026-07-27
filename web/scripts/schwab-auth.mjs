#!/usr/bin/env node
/**
 * Canje OAuth de Schwab — se corre A MANO, una sola vez (y cuando caduque el refresh).
 *
 *   node scripts/schwab-auth.mjs
 *
 * Lee SCHWAB_APP_KEY / SCHWAB_APP_SECRET de .env.local, imprime la URL de
 * autorización, y espera a que pegues la URL a la que te redirigió el navegador.
 * Guarda los tokens en data/schwab-tokens.json (gitignorado con el resto de /data).
 *
 * Por qué es un guion y no parte del servidor: el login lo hace Angel con sus
 * credenciales de Schwab. Este proceso nunca ve la contraseña — solo el `code`
 * de un solo uso que Schwab devuelve DESPUÉS de que él se autentique.
 *
 * Nada de esto se imprime nunca: ni el secret, ni los tokens. Solo longitudes.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(WEB_DIR, ".env.local");
const TOKEN_FILE = join(WEB_DIR, "data", "schwab-tokens.json");

const AUTH_URL = "https://api.schwabapi.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";

/** Lee una variable del .env.local sin depender de dotenv. */
function envVar(name) {
  let raw;
  try {
    raw = readFileSync(ENV_FILE, "utf8");
  } catch {
    throw new Error(`No existe ${ENV_FILE}.`);
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== name) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

async function main() {
  const key = envVar("SCHWAB_APP_KEY");
  const secret = envVar("SCHWAB_APP_SECRET");
  const redirect = envVar("SCHWAB_CALLBACK_URL") || "https://127.0.0.1";

  const faltan = [
    !key && "SCHWAB_APP_KEY",
    !secret && "SCHWAB_APP_SECRET",
  ].filter(Boolean);
  if (faltan.length) {
    console.error(`Faltan en .env.local: ${faltan.join(", ")}`);
    return 1;
  }

  const authorize =
    `${AUTH_URL}?client_id=${encodeURIComponent(key)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}`;

  console.log("\n1. Abre esta URL en el navegador e inicia sesión en Schwab:\n");
  console.log(`   ${authorize}\n`);

  // Se abre solo: el code caduca en segundos, así que cada paso manual cuenta.
  if (process.platform === "darwin") {
    try {
      const { spawn } = await import("node:child_process");
      spawn("open", [authorize], { stdio: "ignore", detached: true }).unref();
      console.log("   (te la he abierto en el navegador)\n");
    } catch {
      /* si falla, queda la URL de arriba para copiarla a mano */
    }
  }

  console.log("2. Tras aprobar, el navegador intentará ir a " + redirect);
  console.log("   y fallará con un error de conexión. ESO ES LO ESPERADO.");
  console.log("   Lo que importa es la URL completa que queda en la barra de");
  console.log("   direcciones: lleva un ?code=... dentro.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pegada = (await rl.question("3. Pega aquí esa URL completa: ")).trim();
  rl.close();

  let code;
  try {
    code = new URL(pegada).searchParams.get("code");
  } catch {
    console.error("\nEso no parece una URL. Copia la barra de direcciones entera.");
    return 1;
  }
  if (!code) {
    console.error("\nEsa URL no trae ?code=. ¿Copiaste la de después de aprobar?");
    return 1;
  }

  // El navegador aterriza en "https://127.0.0.1/?code=…" (CON barra), pero en el
  // portal se declara "https://127.0.0.1" (SIN barra). Schwab exige que el
  // redirect_uri del canje sea idéntico al usado, y no dice cuál espera: se
  // prueban ambas. Un canje rechazado por redirect no consume el code.
  const variantes = [redirect, redirect.endsWith("/") ? redirect.slice(0, -1) : `${redirect}/`];

  console.log("\nCanjeando el code por tokens…");
  let tok = null;
  let ultimoFallo = "";
  for (const uri of variantes) {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: uri,
      }),
    });
    if (res.ok) {
      tok = await res.json();
      console.log(`   (aceptado con redirect_uri = ${uri})`);
      break;
    }
    ultimoFallo = `HTTP ${res.status} con redirect_uri=${uri}\n${(await res.text().catch(() => "")).slice(0, 300)}`;
  }

  if (!tok) {
    console.error(`\n❌ Schwab rechazó el canje.\n${ultimoFallo}`);
    console.error(
      "\nCausas, por probabilidad:\n" +
        "  1. CADUCÓ. Los codes de Schwab duran muy poco. Vuelve a correr el guion\n" +
        "     y pega la URL en cuanto el navegador falle, sin pausas.\n" +
        "  2. Ya se usó: son de un solo uso. Cada intento necesita un code nuevo.\n" +
        "  3. El redirect_uri no coincide con el declarado en el portal (ya se\n" +
        "     probaron las variantes con y sin barra final).",
    );
    return 1;
  }
  if (!tok.refresh_token) {
    console.error("\n❌ La respuesta no trae refresh_token. No se guarda nada.");
    return 1;
  }

  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(
    TOKEN_FILE,
    JSON.stringify(
      {
        refresh_token: tok.refresh_token,
        access_token: tok.access_token ?? null,
        // Marca de tiempo propia: el access token se renueva solo desde el
        // servidor, pero el refresh caduca y hay que volver a correr esto.
        obtained_at: new Date().toISOString(),
        expires_in: tok.expires_in ?? null,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  console.log(`\n✅ Tokens guardados en ${TOKEN_FILE} (permisos 600).`);
  console.log(`   refresh_token: ${String(tok.refresh_token).length} caracteres`);
  console.log(`   access_token:  ${String(tok.access_token ?? "").length} caracteres`);
  console.log("\nEse archivo está gitignorado (/data). No lo compartas ni lo commitees.");
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(`\nError inesperado: ${e.message}`);
    process.exit(1);
  });
