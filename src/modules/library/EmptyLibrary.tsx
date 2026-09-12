import { type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { CollectionIcon, FolderIcon, Logo, SearchIcon } from "../../design/icons";
import { Button } from "../../design/Controls";
import { useImporter } from "../../state/importer";
import { filtersActive, useCatalog } from "../../state/catalog";
import { useCollections, useSourceQuery } from "../../catalog/hooks";
import { db } from "../../catalog/db";
import { editSmartCollection } from "../../state/smartEditor";
import { useUI } from "../../state/ui";

export function EmptyLibrary() {
  const total = useLiveQuery(() => db.photos.count(), []);
  const source = useCatalog((s) => s.source);
  const setSource = useCatalog((s) => s.setSource);
  const photos = useSourceQuery();
  const collections = useCollections();
  const filters = useCatalog((s) => s.filters);
  const clearFilters = useCatalog((s) => s.clearFilters);

  if (total === undefined || photos === undefined)
    return <div className="size-full" aria-busy="true" aria-label="Loading photos" />;
  if (total === 0) return <FirstRun />;
  if (photos.length > 0 && filtersActive(filters))
    return <NoMatches onClear={clearFilters} />;

  const showAll = () => {
    clearFilters();
    setSource({ kind: "all" });
    useUI.getState().setViewMode("grid");
  };
  const collection =
    source.kind === "collection" ? collections.find((c) => c.id === source.id) : undefined;

  if (collection?.smart) {
    return (
      <EmptySource
        title="No photos match this collection"
        description="This smart collection’s rules don’t match any photos in your catalog."
        icon={<SearchIcon size={18} />}
      >
        <Button variant="secondary" onClick={() => editSmartCollection(collection)}>
          Edit rules…
        </Button>
        <Button variant="ghost" onClick={showAll}>All Photos</Button>
      </EmptySource>
    );
  }

  if (source.kind === "collection") {
    return (
      <EmptySource
        title="This collection is empty"
        description="Choose photos in All Photos, then use Add to Collection in the photo menu."
        icon={<CollectionIcon size={18} />}
      >
        <Button variant="secondary" onClick={showAll}>Choose photos</Button>
      </EmptySource>
    );
  }

  return (
    <EmptySource
      title={
        source.kind === "folder"
          ? "No photos in this folder"
          : source.kind === "previousImport"
            ? "No photos in the previous import"
            : "No photos in this view"
      }
      description="Your other photos are still in the catalog. Browse them in All Photos."
      icon={source.kind === "folder" ? <FolderIcon size={18} /> : <CollectionIcon size={18} />}
    >
      <Button variant="secondary" onClick={showAll}>All Photos</Button>
    </EmptySource>
  );
}

function EmptySource({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Centered>
      <div className="flex max-w-[36ch] flex-col items-center gap-3 text-center">
        <span className="text-icon-quaternary">{icon}</span>
        <div className="flex flex-col gap-1">
          <h2 className="text-title text-label">{title}</h2>
          <p className="text-ui text-balance text-label-secondary">{description}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">{children}</div>
      </div>
    </Centered>
  );
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
 * The catalog is empty exactly once. One heading, two ways in, nothing else.
 */
function FirstRun() {
  const active = useImporter((s) => s.active);
  const run = useImporter((s) => s.run);
  const runFiles = useImporter((s) => s.runFiles);

  return (
    <Centered>
      <div className="flex flex-col items-center gap-4 text-center">
        <Logo size={28} />

        <h1 className="text-headline text-label">No photos yet</h1>

        <div className="flex items-center gap-2">
          <Button variant="primary" disabled={active} onClick={() => void run()}>
            {active ? "Importing…" : "Choose Folder"}
          </Button>
          <Button
            variant="secondary"
            disabled={active}
            onClick={() => void runFiles(null, true)}
          >
            Choose Photos
          </Button>
        </div>
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="relative grid size-full place-items-center px-8">
      {children}
    </div>
  );
}
