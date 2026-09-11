/**
 * What happens to a photograph after it lands in the catalogue.
 *
 * Import's own job ends when the record and its thumbnail exist. Everything
 * here is optional work the photographer has asked for in advance — a look
 * applied, a tone found, a preview built — and it runs as a second pass rather
 * than inside `ingest` for one reason: it is the slow part, and a slow *import*
 * and a slow *finish* are different experiences. The grid fills at the same
 * speed it always did, and the extra work happens against photographs that are
 * already on screen.
 *
 * Every step is skipped by default. An import that silently develops a shoot
 * has made a judgement nobody asked it to make, and left the photographer no
 * way to tell what the camera gave them from what the app decided.
 */
import { db } from "./db";
import { ensurePreview } from "./previews";
import { saveEdits } from "./actions";
import { cloneEdits, defaultEdits, editsKind } from "../core/defaults";
import { useUI } from "../state/ui";
import type { Photo, Preset } from "../core/types";

export interface DefaultsProgress {
  done: number;
  total: number;
  current: string;
}

/** True when anything at all is configured, so import can skip the pass whole. */
export function hasImportDefaults(): boolean {
  const { importDevelop, previewOnImport } = useUI.getState();
  return importDevelop !== "none" || previewOnImport;
}

type DevelopMode = "none" | "auto" | "tone" | "preset";

function resolvedDevelopMode(
  configured: ReturnType<typeof useUI.getState>["importDevelop"],
  preset: Preset | null,
): DevelopMode {
  if (configured === "auto" || configured === "tone") return configured;
  return preset ? "preset" : "none";
}

async function applyAutomaticDefaults(
  ids: string[],
  mode: "auto" | "tone",
  onProgress?: (progress: DefaultsProgress) => void,
) {
  const { autoDevelopPhotos } = await import("../develop/autoApply");
  onProgress?.({ done: 0, total: ids.length, current: "" });
  await autoDevelopPhotos(ids, mode === "tone" ? "tone" : "all").catch(() => 0);
}

async function applyPresetDefaults(
  ids: string[],
  preset: Preset,
  opts: { signal?: AbortSignal; onProgress?: (progress: DefaultsProgress) => void },
) {
  const { applyPreset } = await import("../develop/presets");
  let done = 0;
  for (const id of ids) {
    if (opts.signal?.aborted) return;
    const photo = await db.photos.get(id);
    if (!photo) continue;
    try {
      await saveEdits(id, applyPreset(baseEdits(photo), preset));
    } catch {
      /* one photo that won't take the look shouldn't stop the rest */
    }
    opts.onProgress?.({ done: ++done, total: ids.length, current: photo.filename });
  }
}

async function generatePreviews(
  ids: string[],
  opts: { signal?: AbortSignal; onProgress?: (progress: DefaultsProgress) => void },
) {
  let done = 0;
  for (const id of ids) {
    if (opts.signal?.aborted) return;
    await ensurePreview(id).catch(() => false);
    opts.onProgress?.({ done: ++done, total: ids.length, current: "" });
  }
}

/**
 * Runs the configured post-import work over freshly added photographs.
 *
 * Never throws: this is work the user asked for once, in a settings pane, and
 * failing it should not fail the import that carried it. Each photograph is
 * independent, so one unreadable file costs only itself.
 */
export async function applyImportDefaults(
  ids: string[],
  opts: { signal?: AbortSignal; onProgress?: (p: DefaultsProgress) => void } = {},
): Promise<void> {
  const { importDevelop, importPresetId, previewOnImport } = useUI.getState();
  if (!ids.length) return;

  // Read once. A preference changed halfway through a batch would otherwise
  // split it into two differently developed halves.
  const preset =
    importDevelop === "preset" && importPresetId
      ? await findPreset(importPresetId)
      : null;
  const develop = resolvedDevelopMode(importDevelop, preset);

  if (develop === "none" && !previewOnImport) return;

  if (develop === "auto" || develop === "tone") {
    await applyAutomaticDefaults(ids, develop, opts.onProgress);
  } else if (preset) {
    await applyPresetDefaults(ids, preset, opts);
  }

  if (previewOnImport) await generatePreviews(ids, opts);
}

/** A photograph's settings, or the baseline its kind and ISO imply. */
const baseEdits = (photo: Photo) =>
  photo.edits
    ? cloneEdits(photo.edits)
    : defaultEdits(editsKind(photo.isRaw), undefined, photo.meta.iso);

/**
 * The chosen preset, from the user's library or the built-ins.
 *
 * Returns null rather than throwing when the id no longer resolves — a preset
 * deleted after being nominated here should quietly mean "no preset", not break
 * every import until someone visits Settings.
 */
async function findPreset(id: string): Promise<Preset | null> {
  const stored = await db.presets.get(id).catch(() => undefined);
  if (stored) return stored;
  const { BUILTIN_PRESETS } = await import("../develop/presets");
  return BUILTIN_PRESETS.find((p) => p.id === id) ?? null;
}
