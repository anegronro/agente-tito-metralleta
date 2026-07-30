import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, parseSetCookie, withLiveSession } from "./msSession";

describe("parseSetCookie", () => {
  it("saca el par entero, no solo el valor", () => {
    const h = `${SESSION_COOKIE}=abc123; path=/; secure; httponly; samesite=lax`;
    expect(parseSetCookie(h)).toBe(`${SESSION_COOKIE}=abc123`);
  });

  it("descarta los atributos de la cookie", () => {
    const h = `${SESSION_COOKIE}=xyz; path=/; expires=Thu, 01 Jan 2027 00:00:00 GMT`;
    expect(parseSetCookie(h)).toBe(`${SESSION_COOKIE}=xyz`);
  });

  it("encuentra la de sesión aunque vengan varias unidas por coma", () => {
    // `set-cookie` puede llegar concatenado; el valor de Rails es base64 y no
    // lleva comas, así que se puede partir con seguridad por el patrón "nombre=".
    const h = `_ga=GA1.2.999; path=/, ${SESSION_COOKIE}=elbueno; path=/; httponly`;
    expect(parseSetCookie(h)).toBe(`${SESSION_COOKIE}=elbueno`);
  });

  it("devuelve null cuando no hay cookie de sesión", () => {
    expect(parseSetCookie("_ga=GA1.2.999; path=/")).toBeNull();
    expect(parseSetCookie(null)).toBeNull();
    expect(parseSetCookie("")).toBeNull();
  });

  it("no acepta una cookie de sesión vacía", () => {
    expect(parseSetCookie(`${SESSION_COOKIE}=; path=/`)).toBeNull();
  });
});

describe("withLiveSession", () => {
  const tarro = `_ga=GA1.2.111; ${SESSION_COOKIE}=VIEJA; _fbp=fb.1.222`;

  it("SUSTITUYE la sesión vieja, no la añade al lado", () => {
    // Mandar las dos dejaría que el servidor eligiera, probablemente la
    // primera, y el rotado no serviría de nada.
    const out = withLiveSession(tarro, `${SESSION_COOKIE}=NUEVA`);
    expect(out).toContain(`${SESSION_COOKIE}=NUEVA`);
    expect(out).not.toContain("VIEJA");
    expect(out.match(new RegExp(SESSION_COOKIE, "g"))).toHaveLength(1);
  });

  it("conserva el resto del tarro", () => {
    const out = withLiveSession(tarro, `${SESSION_COOKIE}=NUEVA`);
    expect(out).toContain("_ga=GA1.2.111");
    expect(out).toContain("_fbp=fb.1.222");
  });

  it("sin sesión viva devuelve el tarro tal cual", () => {
    expect(withLiveSession(tarro, null)).toBe(tarro);
  });

  it("funciona con un tarro que solo trae la sesión", () => {
    const out = withLiveSession(`${SESSION_COOKIE}=VIEJA`, `${SESSION_COOKIE}=NUEVA`);
    expect(out).toBe(`${SESSION_COOKIE}=NUEVA`);
  });

  it("aguanta espacios y puntos y coma sobrantes", () => {
    const sucio = `  _ga=1 ;; ${SESSION_COOKIE}=VIEJA ;  `;
    const out = withLiveSession(sucio, `${SESSION_COOKIE}=NUEVA`);
    expect(out).toBe(`_ga=1; ${SESSION_COOKIE}=NUEVA`);
  });

  it("el resultado es una cabecera Cookie válida", () => {
    const out = withLiveSession(tarro, `${SESSION_COOKIE}=NUEVA`);
    for (const par of out.split(";").map((p) => p.trim())) {
      expect(par).toMatch(/^[^=\s]+=[^;]*$/);
    }
  });
});
