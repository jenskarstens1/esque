/**
 * The chrome's own appearance: how dark it is, how large it sets its type,
 * and what tone the photograph sits on.
 *
 * None of this is state a component reads. It is two attributes on `<html>`
 * and one custom property, because the tokens they switch are consumed by every
 * generated utility in the app — re-theming through React would mean every
 * subscriber re-rendering to change values the cascade can swap on its own.
 * `appearance.css` holds the values; this file holds the vocabulary and the one
 * function that writes it to the document.
 */

/**
 * How dark the chrome is.
 *
 * Three steps rather than two. `dark` is the reference: a near-black surround
 * is what a photograph should be judged against, and it is what the app opens
 * on. `light` exists because a bright room makes that surround glare, not
 * because anyone edits in it by choice. `dim` is the middle Lightroom has
 * always offered — dark enough not to bias the eye, light enough to read the
 * panels by in daylight.
 */
export type Appearance = "dark" | "dim" | "light";

/**
 * The tone the photograph sits on.
 *
 * Simultaneous contrast is not a preference — a frame reads lighter on black
 * and heavier on white, and which surround tells the truth depends on where the
 * picture is going. `match` follows the appearance, which is what someone who
 * has never thought about it wants; the rest are the fixed tones every other
 * raw converter offers, so a judgement made here can be made the same way twice.
 */
export type Surround =
  | "match"
  | "black"
  | "charcoal"
  | "grey"
  | "paper"
  | "white";

/** UI type size, as a multiplier on the whole scale. */
export type TextSize = "small" | "default" | "medium" | "large";

export const APPEARANCE_LABELS: Record<Appearance, string> = {
  dark: "Dark",
  dim: "Dim",
  light: "Light",
};

export const SURROUND_LABELS: Record<Surround, string> = {
  match: "Match appearance",
  black: "Black",
  charcoal: "Charcoal",
  grey: "Middle grey",
  paper: "Paper",
  white: "White",
};

export const TEXT_SIZE_LABELS: Record<TextSize, string> = {
  small: "Small",
  default: "Default",
  medium: "Medium",
  large: "Large",
};

/**
 * Deliberately narrow. The layout is built in pixels — a 116px label column, a
 * 470px dialog — so type that grows without them starts truncating labels
 * rather than making anything more readable. This is the range where the app
 * still reads as itself.
 */
const TEXT_SCALE: Record<TextSize, number> = {
  small: 0.92,
  default: 1,
  medium: 1.07,
  large: 1.14,
};

export interface AppearanceSettings {
  appearance: Appearance;
  surround: Surround;
  textSize: TextSize;
}

/**
 * Writes the appearance to the document.
 *
 * Called once as the store is created rather than from an effect: an effect
 * runs after the first paint, which is long enough to see the app open dark and
 * turn light.
 */
export function applyAppearance(s: AppearanceSettings) {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  el.dataset.appearance = s.appearance;
  delete el.dataset.accent;
  el.dataset.surround = s.surround;
  el.style.setProperty("--ui-scale", String(TEXT_SCALE[s.textSize] ?? 1));
}
