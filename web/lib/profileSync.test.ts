import { describe, expect, it } from "vitest";
import {
  MIN_CODE_LENGTH,
  deviceLabel,
  normalizeCode,
  pickNewer,
  sanitize,
  toProfile,
  validateCode,
  type SyncedProfile,
} from "./profileSync";

const now = new Date("2026-07-28T18:00:00.000Z");

function synced(over: Partial<SyncedProfile> = {}): SyncedProfile {
  return { accountSize: 1000, tolerancePct: 4, updatedAt: now.toISOString(), ...over };
}

describe("normalizeCode", () => {
  it("iguala mayúsculas y espacios de los extremos", () => {
    expect(normalizeCode("  MiCuenta ")).toBe("micuenta");
    expect(normalizeCode("MICUENTA")).toBe(normalizeCode("micuenta"));
  });

  it("respeta los espacios de en medio: puede ser una frase", () => {
    expect(normalizeCode("cohete azul")).toBe("cohete azul");
  });
});

describe("validateCode", () => {
  it("exige una longitud mínima", () => {
    expect(validateCode("abc").ok).toBe(false);
    expect(validateCode("a".repeat(MIN_CODE_LENGTH)).ok).toBe(true);
  });

  it("rechaza vacío y solo espacios", () => {
    expect(validateCode("").ok).toBe(false);
    expect(validateCode("     ").ok).toBe(false);
  });

  it("rechaza códigos absurdamente largos", () => {
    expect(validateCode("x".repeat(500)).ok).toBe(false);
  });

  it("siempre explica por qué falla", () => {
    expect(validateCode("abc").reason).toBeTruthy();
  });
});

describe("sanitize — no confiar en el cuerpo del POST", () => {
  it("acepta un perfil sano y le pone la fecha del servidor", () => {
    const s = sanitize({ accountSize: 2500, tolerancePct: 3 }, now)!;
    expect(s.accountSize).toBe(2500);
    expect(s.tolerancePct).toBe(3);
    expect(s.updatedAt).toBe(now.toISOString());
  });

  it("rechaza saldos negativos, cero, NaN e Infinity", () => {
    for (const accountSize of [-100, 0, NaN, Infinity, "mucho"]) {
      expect(sanitize({ accountSize, tolerancePct: 4 }, now)).toBeNull();
    }
  });

  it("rechaza tolerancias no positivas", () => {
    expect(sanitize({ accountSize: 1000, tolerancePct: 0 }, now)).toBeNull();
    expect(sanitize({ accountSize: 1000, tolerancePct: -3 }, now)).toBeNull();
  });

  it("topa la tolerancia en 100: un % mayor no significa nada", () => {
    expect(sanitize({ accountSize: 1000, tolerancePct: 5000 }, now)!.tolerancePct).toBe(100);
  });

  it("rechaza lo que ni siquiera es un objeto", () => {
    for (const basura of [null, undefined, "hola", 42, []]) {
      expect(sanitize(basura, now)).toBeNull();
    }
  });

  it("recorta la etiqueta del dispositivo", () => {
    const s = sanitize({ accountSize: 1000, tolerancePct: 4, device: "x".repeat(200) }, now)!;
    expect(s.device!.length).toBeLessThanOrEqual(40);
  });

  it("ignora campos de más que intenten colarse", () => {
    const s = sanitize({ accountSize: 1000, tolerancePct: 4, admin: true, watchlist: ["X"] }, now)!;
    expect(Object.keys(s).sort()).toEqual(["accountSize", "device", "tolerancePct", "updatedAt"].filter((k) => k in s).sort());
    expect("admin" in s).toBe(false);
    expect("watchlist" in s).toBe(false);
  });
});

describe("pickNewer", () => {
  const viejo = synced({ accountSize: 1000, updatedAt: "2026-07-28T10:00:00.000Z" });
  const nuevo = synced({ accountSize: 5000, updatedAt: "2026-07-28T12:00:00.000Z" });

  it("gana la escritura más reciente", () => {
    expect(pickNewer(viejo, nuevo)).toBe(nuevo);
    expect(pickNewer(nuevo, viejo)).toBe(nuevo);
  });

  it("si falta un lado, gana el otro", () => {
    expect(pickNewer(null, nuevo)).toBe(nuevo);
    expect(pickNewer(viejo, null)).toBe(viejo);
    expect(pickNewer(null, null)).toBeNull();
  });

  it("EN EMPATE gana lo remoto, para que los dispositivos converjan", () => {
    const a = synced({ accountSize: 1, updatedAt: "2026-07-28T12:00:00.000Z" });
    const b = synced({ accountSize: 2, updatedAt: "2026-07-28T12:00:00.000Z" });
    expect(pickNewer(a, b)).toBe(b);
  });

  it("una fecha corrupta no gana", () => {
    const roto = synced({ updatedAt: "no es una fecha" });
    expect(pickNewer(roto, nuevo)).toBe(nuevo);
    expect(pickNewer(nuevo, roto)).toBe(nuevo);
  });
});

describe("toProfile", () => {
  it("deja fuera los metadatos de sincronización", () => {
    const p = toProfile(synced({ device: "iPhone" }));
    expect(p).toEqual({ accountSize: 1000, tolerancePct: 4 });
  });
});

describe("deviceLabel", () => {
  it("reconoce los dispositivos habituales", () => {
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe("iPhone");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)")).toBe("Mac");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 14)")).toBe("Android");
  });

  it("no se cae con un agente desconocido o vacío", () => {
    expect(deviceLabel("")).toBe("otro dispositivo");
    expect(deviceLabel("curl/8.0")).toBe("otro dispositivo");
  });

  it("el iPad no se confunde con el iPhone", () => {
    expect(deviceLabel("Mozilla/5.0 (iPad; CPU OS 17_0)")).toBe("iPad");
  });
});
