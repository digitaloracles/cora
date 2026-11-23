import { createHash } from "node:crypto";
import { imageMime } from "./images.js";

/** The ready-made themes the panel draws (web/styles.css › Themes); "custom" takes the owner's own colors. */
export const THEMES = ["cora", "giorno", "notte", "studio", "dopamina", "custom"];
export const LOGO_LIMIT = 512 * 1024;
const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const HEX = /^#[0-9a-f]{6}$/;

export class AppearanceError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const DEFAULT = { theme: "cora", mode: "light", accent: "#264cd6", sidebar: "#121a3a", name: "", logo: "" };

/** How the space looks: a theme, or the owner's mode, accent and sidebar colors, a name and the logo's version. */
export function readAppearance(store) {
  const saved = store.value("appearance", {}) || {};
  const logo = store.value("appearanceLogo", null);
  return { ...DEFAULT, ...saved, logo: logo?.hash || "" };
}

export function cleanAppearance(input, previous = DEFAULT) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AppearanceError("aspetto non valido");
  const next = { theme: previous.theme, mode: previous.mode, accent: previous.accent, sidebar: previous.sidebar, name: previous.name };
  if (input.theme !== undefined) {
    if (!THEMES.includes(input.theme)) throw new AppearanceError("tema sconosciuto");
    next.theme = input.theme;
  }
  if (input.mode !== undefined) {
    if (!["light", "dark"].includes(input.mode)) throw new AppearanceError("scegli chiaro o scuro");
    next.mode = input.mode;
  }
  for (const key of ["accent", "sidebar"]) {
    if (input[key] === undefined) continue;
    const value = String(input[key]).trim().toLowerCase();
    if (!HEX.test(value)) throw new AppearanceError("usa un colore esadecimale, per esempio #264cd6");
    next[key] = value;
  }
  if (input.name !== undefined) {
    const name = String(input.name).replace(/\s+/g, " ").trim();
    if (name.length > 40 || /[\x00-\x1f\x7f<>]/.test(name)) throw new AppearanceError("il nome dello spazio va da 0 a 40 caratteri, senza < e >");
    next.name = name;
  }
  return next;
}

export function saveAppearance(store, input) {
  const next = cleanAppearance(input, readAppearance(store));
  store.setValue("appearance", next);
  return readAppearance(store);
}

/** A logo is a PNG, JPEG or WebP up to 512 KB, read by its bytes: never SVG, which could carry a script. */
export function saveLogo(store, image) {
  if (typeof image !== "string" || !image) throw new AppearanceError("manca l'immagine del logo");
  if (image.length > Math.ceil(LOGO_LIMIT * 4 / 3) + 64) throw new AppearanceError("il logo supera 512 KB");
  const data = Buffer.from(image.replace(/^data:[^,]*,/, ""), "base64");
  const mime = imageMime(data);
  if (!LOGO_TYPES.has(mime)) throw new AppearanceError("il logo dev'essere un PNG, un JPEG o un WebP");
  if (data.length > LOGO_LIMIT) throw new AppearanceError("il logo supera 512 KB");
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
  store.setValue("appearanceLogo", { mime, hash, data: data.toString("base64") });
  return readAppearance(store);
}

export function removeLogo(store) {
  store.setValue("appearanceLogo", null);
  return readAppearance(store);
}

export function readLogo(store) {
  const logo = store.value("appearanceLogo", null);
  return logo?.data ? { mime: logo.mime, hash: logo.hash, data: Buffer.from(logo.data, "base64") } : null;
}
