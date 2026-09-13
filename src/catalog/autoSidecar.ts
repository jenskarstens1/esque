/**
 * Writing edits back to disk as they are made.
 *
 * `sidecar.ts` knows how to write one `.xmp`; this decides when. The two are
 * separate because the *when* is the entire difficulty: an edit is not one
 * event but a hundred, a slider drag emits a `saveEdits` per animation frame,
 * and a sync across a selection emits one per photograph in a tight loop.
 * Writing on each would put the app in a fight with the user's disk that the
 * disk would win.
 *
 * So every photo carries at most one pending write, coalesced behind a quiet
 * period. Whatever the settings are when the timer fires is what gets written —
 * the queue holds an id, never a snapshot — which means the burst of a drag
 * collapses to a single file containing the value it landed on.
 *
 * Failure is reported once and then not again. A folder whose permission has
 * lapsed will fail for every photo in it, and a photographer culling a shoot
 * does not need to be told two hundred times.
 */
import { db } from "./db";
import { writeSidecar } from "./sidecar";
import { ensurePermission } from "./fs";
import { useUI } from "../state/ui";
import { toast } from "../design/toast";

/**
 * Long enough to swallow a slider drag and a keyboard repeat, short enough that
 * switching to another application finds the file already written.
 */
const QUIET_MS = 1200;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Set<string>();
let complained = false;

/**
 * Notes that a photograph's stored state has changed.
 *
 * Cheap and synchronous when the preference is off, because it is called from
 * the hot path of every rating, flag and slider in the app.
 */
export function queueSidecarWrite(target: string | string[]) {
  if (!useUI.getState().autoWriteSidecars) return;
  for (const id of Array.isArray(target) ? target : [target]) {
    const pending = timers.get(id);
    if (pending) clearTimeout(pending);
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        void flush(id);
      }, QUIET_MS),
    );
  }
}

async function flush(id: string) {
  // A write already running for this photo would race the one about to start,
  // and the loser's contents are whichever the filesystem finished last. The
  // second request is re-queued behind the first instead.
  if (inFlight.has(id)) {
    queueSidecarWrite(id);
    return;
  }
  inFlight.add(id);
  try {
    const photo = await db.photos.get(id);
    // A virtual copy has no file of its own to sit beside — writing it would
    // overwrite the master's sidecar with one of its variants.
    if (!photo || photo.masterId) return;
    if (!useUI.getState().autoWriteSidecars) return;

    const ok = await writeSidecar(photo);
    if (!ok && !complained) {
      complained = true;
      toast.error(
        "Could not write a sidecar",
        "Automatic sidecars need a writable source folder. For browser-local copies, use Export with XMP sidecars. For linked folders, turn automatic writes off and on in Settings to renew permission.",
      );
    }
  } catch {
    /* Automatic and silent by design; the toast above is the one report. */
  } finally {
    inFlight.delete(id);
  }
}

/**
 * Asks for write access to every folder in the catalogue.
 *
 * Called when the preference is switched on, and only then. `requestPermission`
 * needs a user gesture, and the gesture that means "yes, write to my photo
 * folders" is the switch itself — a prompt raised later, from a timer behind a
 * slider, arrives with no explanation and is dismissed.
 *
 * Returns how many folders are now writable and how many were refused, so the
 * caller can say whether the setting actually took.
 */
export async function authoriseSidecarWrites(): Promise<{
  granted: number;
  denied: number;
}> {
  const folders = await db.folders.toArray();
  let granted = 0;
  let denied = 0;
  for (const folder of folders) {
    if (!folder.handle) continue;
    const result = await ensurePermission(folder.handle, "readwrite").catch(
      () => false,
    );
    if (result) granted++;
    else denied++;
  }
  // A fresh grant deserves a fresh chance to complain.
  complained = false;
  return { granted, denied };
}

/** Drops pending writes. Used when the preference is switched off. */
export function cancelSidecarWrites() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}
