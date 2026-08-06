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
  const develop =
    importDevelop === "auto" || importDevelop === "tone"
      ? importDevelop
      : preset
        ? "preset"
        : "none";

  if (develop === "none" && !previewOnImport) return;

  if (develop === "auto" || develop === "tone") {
    // The maths already knows how to walk a list, decode what it needs and put
    // the answer somewhere that undoes, so this is one call rather than a loop.
    const { autoDevelopPhotos } = await import("../develop/autoApply");
    opts.onProgress?.({ done: 0, total: ids.length, current: "" });
    await autoDevelopPhotos(ids, develop === "tone" ? "tone" : "all").catch(
      () => 0,
    );
  } else if (preset) {
    const { applyPreset } = await import("../develop/presets");
    let done = 0;
    for (const id of ids) {
      if (opts.signal?.aborted) return;
      const photo = await db.photos.get(id);
      if (photo) {
        try {
          await saveEdits(id, applyPreset(baseEdits(photo), preset));
        } catch {
          /* one photo that won't take the look shouldn't stop the rest */
        }
        opts.onProgress?.({
          done: ++done,
          total: ids.length,
          current: photo.filename,
        });
      }
    }
  }

  if (previewOnImport) {
    let done = 0;
    for (const id of ids) {
      if (opts.signal?.aborted) return;
      await ensurePreview(id).catch(() => false);
      opts.onProgress?.({ done: ++done, total: ids.length, current: "" });
    }
  }
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
