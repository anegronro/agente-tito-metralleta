import { describe, expect, it } from "vitest";
import { FAR_PCT, NEAR_PCT, ON_TOP_PCT, spxAlerts, type SpxAlertInput } from "./spxAlerts";

const base: SpxAlertInput = {
  spot: 7600, magnet: null, flip: null,
  regime: "positive", hoursLeft: 3, walls: [],
};

const titulos = (i: Partial<SpxAlertInput>) =>
  spxAlerts({ ...base, ...i }).map((a) => a.title);

describe("régimen de gamma", () => {
  it("la gamma negativa es aviso de nivel alto", () => {
    const a = spxAlerts({ ...base, regime: "negative" })[0];
    expect(a.level).toBe("alta");
    expect(a.title).toMatch(/negativa/i);
    expect(a.detail).toMatch(/amplifica/i);
  });

  it("la positiva se informa, no se alarma", () => {
    const a = spxAlerts(base).find((x) => x.title.match(/positiva/i))!;
    expect(a.level).toBe("info");
    expect(a.detail).toMatch(/revert/i);
  });
});

describe("imán", () => {
  it("avisa fuerte cuando el precio está encima y la gamma sujeta", () => {
    const a = spxAlerts({ ...base, magnet: 7605 }).find((x) => x.title.match(/clavado/i))!;
    expect(a.level).toBe("alta");
    expect(a.detail).toMatch(/pin/i);
    expect(a.price).toBe(7605);
  });

  it("con gamma negativa el mismo pin baja de nivel: el nodo NO sujeta", () => {
    const a = spxAlerts({ ...base, magnet: 7605, regime: "negative" }).find((x) => x.title.match(/clavado/i))!;
    expect(a.level).toBe("media");
    expect(a.detail).toMatch(/NO sujeta/);
  });

  it("distingue arriba de abajo", () => {
    expect(titulos({ magnet: 7700 })).toContain("Imán por encima");
    expect(titulos({ magnet: 7500 })).toContain("Imán por debajo");
  });

  it("un imán lejano no genera aviso", () => {
    const lejos = base.spot * (1 + (FAR_PCT + 1) / 100);
    expect(titulos({ magnet: lejos }).some((t) => t.match(/imán/i))).toBe(false);
  });
});

describe("zona de inversión", () => {
  it("estar encima del flip es lo más urgente", () => {
    const a = spxAlerts({ ...base, flip: 7602 }).find((x) => x.title.match(/[Pp]egado/))!;
    expect(a.level).toBe("alta");
    expect(a.detail).toMatch(/justo encima/i);
  });

  it("NO dice 'encima' con 36 puntos de separación", () => {
    // Caso real: SPX 7601,83 con el flip en 7565,65 son $36 y un 0,47%. Con el
    // umbral viejo (0,5%) el aviso anunciaba que el precio estaba encima.
    const a = spxAlerts({ ...base, spot: 7601.83, flip: 7565.65 })
      .find((x) => x.title.match(/[Ii]nversión|[Pp]egado/))!;
    expect(a.title).not.toMatch(/[Pp]egado/);
    expect(a.detail).not.toMatch(/justo encima/);
    expect(a.detail).toMatch(/36 puntos/);
    expect(a.level).toBe("media");
  });

  it("cerca pero no encima baja a medio", () => {
    const a = spxAlerts({ ...base, flip: 7680 }).find((x) => x.title.match(/[Ii]nversión/))!;
    expect(a.level).toBe("media");
  });

  it("ON_TOP es mucho más estrecho que NEAR", () => {
    expect(ON_TOP_PCT).toBeLessThan(NEAR_PCT);
  });
});

describe("muros", () => {
  it("saca los nodos cercanos y los nombra según el lado", () => {
    const t = titulos({ walls: [{ strike: 7680, netGex: 500, concentration: 1 }] });
    expect(t.some((x) => x.match(/Muro de gamma/))).toBe(true);
    const t2 = titulos({ walls: [{ strike: 7520, netGex: -500, concentration: 1 }] });
    expect(t2.some((x) => x.match(/Soporte de gamma/))).toBe(true);
  });

  it("no repite el nivel que ya cubrió el imán", () => {
    // Un muro pegadísimo al precio ya está contado como pin.
    const t = titulos({ magnet: 7601, walls: [{ strike: 7601, netGex: 1, concentration: 1 }] });
    expect(t.filter((x) => x.match(/7601/)).length).toBeLessThanOrEqual(1);
  });

  it("como mucho dos muros: la lista tiene que caber en una pantalla", () => {
    const muchos = [7620, 7640, 7660, 7680].map((strike) => ({ strike, netGex: 1, concentration: 1 }));
    expect(titulos({ walls: muchos }).filter((x) => x.match(/Muro/)).length).toBeLessThanOrEqual(2);
  });
});

describe("reloj", () => {
  it("avisa en la última hora y media", () => {
    expect(titulos({ hoursLeft: 1 })).toContain("Última hora");
    expect(titulos({ hoursLeft: 4 })).not.toContain("Última hora");
  });
});

describe("orden y robustez", () => {
  it("lo urgente va primero", () => {
    const a = spxAlerts({ ...base, regime: "negative", flip: 7602, magnet: 7700, hoursLeft: 1 });
    const niveles = a.map((x) => x.level);
    expect(niveles).toEqual([...niveles].sort((p, q) =>
      ({ alta: 0, media: 1, info: 2 })[p] - ({ alta: 0, media: 1, info: 2 })[q]));
  });

  it("sin precio no inventa avisos", () => {
    expect(spxAlerts({ ...base, spot: 0 })).toHaveLength(0);
  });

  it("sin imán ni flip sigue diciendo el régimen", () => {
    expect(spxAlerts(base).length).toBeGreaterThan(0);
  });

  it("todos los avisos traen explicación", () => {
    for (const a of spxAlerts({ ...base, magnet: 7605, flip: 7620, regime: "negative", hoursLeft: 1 })) {
      expect(a.detail.length).toBeGreaterThan(20);
    }
  });

  it("los tres umbrales van de más estrecho a más ancho", () => {
    expect(ON_TOP_PCT).toBeLessThan(NEAR_PCT);
    expect(NEAR_PCT).toBeLessThan(FAR_PCT);
  });
});
