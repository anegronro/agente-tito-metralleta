// Persistencia del perfil sincronizado. web/data/profiles/{huella}.json (gitignored).
// Solo servidor. La lógica pura vive en `profileSync.ts`.
//
// EL CÓDIGO NUNCA SE GUARDA, ni en el nombre del archivo ni dentro: se guarda su
// **huella SHA-256**. Si alguien se hiciera con el disco, tendría los saldos
// pero no los códigos con los que se piden — y como la gente reutiliza
// contraseñas, un código en claro sería un regalo mucho más grande que el saldo.

import { promises as fs } from "fs";
import { createHash } from "crypto";
import path from "path";
import { normalizeCode, type SyncedProfile } from "./profileSync";

const DATA_DIR = path.join(process.cwd(), "data", "profiles");

/** Huella del código, ya normalizado. Es el nombre del archivo. */
export function fingerprint(code: string): string {
  return createHash("sha256").update(normalizeCode(code)).digest("hex").slice(0, 32);
}

function fileFor(code: string): string {
  return path.join(DATA_DIR, `${fingerprint(code)}.json`);
}

export async function loadProfile(code: string): Promise<SyncedProfile | null> {
  try {
    const raw = await fs.readFile(fileFor(code), "utf8");
    const parsed = JSON.parse(raw) as SyncedProfile;
    return typeof parsed?.accountSize === "number" ? parsed : null;
  } catch {
    return null; // ese código todavía no tiene perfil
  }
}

export async function saveProfile(code: string, profile: SyncedProfile): Promise<SyncedProfile> {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(fileFor(code), JSON.stringify(profile, null, 2), { encoding: "utf8", mode: 0o600 });
  return profile;
}
