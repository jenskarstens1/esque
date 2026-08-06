import { useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Logo, SearchIcon } from "../../design/icons";
import { Button } from "../../design/Controls";
import { useImporter } from "../../state/importer";
import { filtersActive, useCatalog } from "../../state/catalog";
import { useFolders } from "../../catalog/hooks";

export function EmptyLibrary() {
  const folders = useFolders();
  const filters = useCatalog((s) => s.filters);
  const clearFilters = useCatalog((s) => s.clearFilters);
  const hasPhotos = folders.some((f) => f.photoCount > 0);

  if (hasPhotos && filtersActive(filters))
    return <NoMatches onClear={clearFilters} />;
  return <FirstRun />;
}

// ---------------------------------------------------------------------------
// Filtered to nothing
// ---------------------------------------------------------------------------

/*
 * A recoverable state rather than an empty one, so it stays small and quiet —
 * and the way out sits directly under the sentence that explains the problem.
 */
function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <Centered>
      <div className="flex max-w-[34ch] flex-col items-center gap-3 text-center">
        <span className="text-icon-quaternary">
          <SearchIcon size={18} />
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="text-title text-label">No photos match</h2>
          <p className="text-ui text-label-secondary">
            Nothing in this view passes the current filter.
          </p>
        </div>
        <Button variant="secondary" onClick={onClear}>
          Clear filters
        </Button>
      </div>
    </Centered>
  );
}

// ---------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------

/*
 * The catalog is empty exactly once, so this screen says the one thing that
 * has to happen next and nothing else — no feature list, no glow, no card.
 * Everything the app promises about your files is better learned by using it
 * than by reading it here.
 */
function FirstRun() {
  const run = useImporter((s) => s.run);
  const runFiles = useImporter((s) => s.runFiles);
  const active = useImporter((s) => s.active);
  const [over, setOver] = useState(false);

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setOver(false);
    const files: FileSystemFileHandle[] = [];
    for (const item of Array.from(e.dataTransfer.items)) {
      // Chromium hands back a real directory handle, so a dropped folder
      // imports exactly like one chosen through the picker.
      const handle = await (
        item as DataTransferItem & {
          getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
        }
      ).getAsFileSystemHandle?.();
      if (handle?.kind === "directory") {
        run(handle as FileSystemDirectoryHandle);
        return;
      }
      // Dropped files come in one at a time and have no directory of their own.
      if (handle?.kind === "file") files.push(handle as FileSystemFileHandle);
    }
    if (files.length) runFiles(files);
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className="relative size-full"
    >
      {/*
       * The whole view is the drop target, so the whole view is what
       * acknowledges the drag: one accent edge drawn just inside it. Nothing
       * moves, nothing blooms.
       */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-2 rounded-xl",
          "shadow-[inset_0_0_0_1px_var(--color-accent)]",
          "transition-opacity duration-[--duration-base] ease-[--ease-out]",
          over ? "opacity-100" : "opacity-0",
        )}
      />

      <Centered>
        <div className="flex max-w-[32ch] flex-col items-center gap-4 text-center">
          <Logo size={28} />

          <div className="flex flex-col gap-1">
            <h1 className="text-headline text-label">
              {over ? "Drop to import" : "No photos yet"}
            </h1>
            <p className="text-ui text-balance text-label-secondary">
              Import a folder or a single file, or drop one anywhere here. Your
              files stay where they are.
            </p>
          </div>

          <div className="mt-0.5 flex items-center gap-2">
            <Button variant="primary" disabled={active} onClick={() => run()}>
              {active ? "Importing…" : "Import folder…"}
            </Button>
            <Button disabled={active} onClick={() => runFiles()}>
              Import file…
            </Button>
          </div>
        </div>
      </Centered>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="relative grid size-full place-items-center px-8">
      {children}
    </div>
  );
}
