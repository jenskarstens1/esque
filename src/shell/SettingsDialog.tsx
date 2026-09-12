import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Dialog } from "../design/Dialog";
import {
  Button,
  Checkbox,
  Select,
  TextField,
} from "../design/Controls";
import { Field, FieldGroup } from "../design/Field";
import { Scroller } from "../design/Scroller";
import { Slider } from "../design/Slider";
import { toast } from "../design/toast";
import {
  AiModelIcon,
  CacheIcon,
  DisplayIcon,
  FolderIcon,
  InfoIcon,
  InterfaceIcon,
  KeyboardIcon,
  Logo,
} from "../design/icons";
import { cacheClear, cacheStats, type CacheStats } from "../catalog/opfs";
import { formatBytes } from "../lib/math";
import { useUI } from "../state/ui";
import { hdrReach } from "../core/hdr";
import { cn } from "../lib/cn";
import { APP_VERSION } from "./changelog";
import { openWhatsNew } from "./whatsNew";
import {
  APPEARANCE_LABELS,
  SURROUND_LABELS,
  TEXT_SIZE_LABELS,
  type Appearance,
  type Surround,
  type TextSize,
} from "../design/appearance";
import {
  COMMANDS,
  GROUP_LABELS,
  GROUP_ORDER,
  chordOf,
  chordsFor,
  conflictsFor,
  formatChord,
  type Command,
} from "./commands";
import { db } from "../catalog/db";
import {
  authoriseSidecarWrites,
  cancelSidecarWrites,
} from "../catalog/autoSidecar";
import { forgetDestination } from "../state/exportStore";
import { BUILTIN_PRESETS } from "../develop/presets";
import type { PreviewQuality, ImportDevelop } from "../state/ui";
import type { Preset } from "../core/types";
import type { OutputSpace } from "../gpu/colorspace";
import { CatalogBackup } from "./CatalogBackup";
import { AiModelsPane } from "./AiModelsPane";

const PANES = [
  { id: "display", label: "Display", icon: DisplayIcon },
  { id: "interface", label: "Interface", icon: InterfaceIcon },
  { id: "files", label: "Files", icon: FolderIcon },
  { id: "keyboard", label: "Keyboard", icon: KeyboardIcon },
  { id: "cache", label: "Cache", icon: CacheIcon },
  { id: "ai", label: "AI models", icon: AiModelIcon },
  { id: "about", label: "About", icon: InfoIcon },
] as const;

type PaneId = (typeof PANES)[number]["id"];

const PROOF_SPACES: Array<{ value: OutputSpace; label: string }> = [
  { value: "srgb", label: "sRGB" },
  { value: "display-p3", label: "Display P3" },
  { value: "adobe-rgb", label: "Adobe RGB (1998)" },
  { value: "prophoto", label: "ProPhoto RGB" },
  { value: "rec2020", label: "Rec. 2020" },
];

export function SettingsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  // Held above `open` on purpose: the dialog reopens on the pane you left it on.
  const [pane, setPane] = useState<PaneId>("display");
  const [backupBusy, setBackupBusy] = useState(false);

  useEffect(() => {
    const select = (event: Event) => {
      if (!backupBusy && event instanceof CustomEvent && event.detail?.pane === "ai") setPane("ai");
    };
    window.addEventListener("esque:settings", select);
    return () => window.removeEventListener("esque:settings", select);
  }, [backupBusy]);

  useEffect(() => {
    if (!open || pane !== "ai") return;
    const frame = requestAnimationFrame(() => {
      const tab = document.getElementById("settings-tab-ai");
      tab?.focus({ preventScroll: true });
      tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, pane]);

  return (
    <Dialog
      open={open}
      onClose={() => { if (!backupBusy) onClose(); }}
      dismissable={!backupBusy}
      title="Settings"
      // The rail names the dialog better than a heading above it would, and it
      // is where the hand goes first. The surface clips it to the top corners.
      hideTitle
      width={720}
      height={560}
      scrollable={false}
      // The rail draws the one rule this dialog needs. Past the pane's own
      // edges the fade says there is more, the way the welcome dialog does.
      dividers={false}
      // The pane now has the dialog's whole width, but a select holding "sRGB"
      // should not: controls keep the measure they had beside the old column.
      bodyClassName="flex-col items-stretch [--field-measure:100%] [--field-label-width:104px] md:[--field-label-width:132px] md:[--field-measure:400px]"
      footer={
        <Button variant="primary" className="min-w-20" disabled={backupBusy} onClick={onClose}>
          Done
        </Button>
      }
    >
      <Rail pane={pane} onSelect={setPane} disabled={backupBusy} />
      {/* Panes mount only while shown, so each one's setup — the cache reading
          the disk, say — happens exactly when it is asked for. */}
      <Scroller
        key={pane}
        frameClassName="min-h-0 min-w-0 flex-1"
        className="px-5 py-4"
        edgeFade
        role="tabpanel"
        id={`settings-pane-${pane}`}
        aria-labelledby={`settings-tab-${pane}`}
      >
        {pane === "display" && <DisplayPane />}
        {pane === "interface" && <InterfacePane />}
        {pane === "files" && <FilesPane onBackupBusyChange={setBackupBusy} />}
        {pane === "keyboard" && <KeyboardPane />}
        {pane === "cache" && <CachePane />}
        {pane === "ai" && <AiModelsPane />}
        {pane === "about" && <AboutPane />}
      </Scroller>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------

function Rail({
  pane,
  onSelect,
  disabled,
}: {
  pane: PaneId;
  onSelect: (id: PaneId) => void;
  disabled: boolean;
}) {
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  // One rail at every width. The row of tabs reads as a set you can take in at
  // a glance and leaves the pane the dialog's full measure, where the column
  // spent 148px of it on seven words.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const index = PANES.findIndex((p) => p.id === pane);
    let next = -1;
    if (step) next = (index + step + PANES.length) % PANES.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = PANES.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onSelect(PANES[next].id);
    tabs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Settings sections"
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className="flex min-w-0 shrink-0 gap-1 overflow-x-auto bg-base p-3 hairline-b"
    >
      {PANES.map(({ id, label, icon: Icon }, i) => {
        const active = id === pane;
        return (
          <button
            key={id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            disabled={disabled}
            id={`settings-tab-${id}`}
            aria-selected={active}
            aria-controls={`settings-pane-${id}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(id)}
            className={cn(
              "flex h-8 shrink-0 items-center gap-2.5 rounded-sm px-2.5 text-left text-ui coarse:h-11",
              "transition-colors duration-[--duration-fast] ease-[--ease-out]",
              "disabled:pointer-events-none disabled:opacity-35",
              active
                ? "bg-control font-medium text-label"
                : "text-label-secondary hover:bg-raised hover:text-label",
            )}
          >
            <Icon
              className={cn(
                "size-3.5 shrink-0",
                active ? "text-icon" : "text-icon-tertiary",
              )}
            />
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panes
// ---------------------------------------------------------------------------

const PREVIEW_QUALITIES: Array<{ value: PreviewQuality; label: string }> = [
  { value: "standard", label: "Standard — 1600 px" },
  { value: "high", label: "High — 2560 px" },
  { value: "full", label: "Maximum — 4096 px" },
];

const SURROUNDS = Object.entries(SURROUND_LABELS).map(([value, label]) => ({
  value: value as Surround,
  label,
}));

function DisplayPane() {
  const softProof = useUI((s) => s.softProof);
  const setSoftProof = useUI((s) => s.setSoftProof);
  const hdr = useUI((s) => s.hdr);
  const setHdr = useUI((s) => s.setHdr);
  const surround = useUI((s) => s.surround);
  const setSurround = useUI((s) => s.setSurround);
  const previewQuality = useUI((s) => s.previewQuality);
  const setPreviewQuality = useUI((s) => s.setPreviewQuality);
  const clipHighlight = useUI((s) => s.clipHighlight);
  const clipShadow = useUI((s) => s.clipShadow);
  const setClipThreshold = useUI((s) => s.setClipThreshold);
  const reach = hdrReach();

  return (
    <>
      <FieldGroup title="Colour management">
        <Field label="Proof against">
          <Select
            value={softProof}
            onChange={setSoftProof}
            options={PROOF_SPACES}
            aria-label="Proof against"
            className="flex-1"
          />
        </Field>
        <Field
          label="Dynamic range"
          hint={reach === "none" ? "Not available in this browser." : undefined}
        >
          <Checkbox
            checked={hdr}
            onChange={setHdr}
            disabled={reach === "none"}
            label="Enable HDR preview"
          />
        </Field>
      </FieldGroup>
      <FieldGroup title="Previews">
        <Field label="Backdrop">
          <Select
            value={surround}
            onChange={setSurround}
            options={SURROUNDS}
            aria-label="Backdrop"
            className="flex-1"
          />
        </Field>
        <Field label="Preview quality">
          <Select
            value={previewQuality}
            onChange={setPreviewQuality}
            options={PREVIEW_QUALITIES}
            aria-label="Preview quality"
            className="flex-1"
          />
        </Field>
      </FieldGroup>
      <FieldGroup title="Clipping warnings">
        <Field label="Highlights">
          <Slider
            value={clipHighlight * 100}
            onChange={(v) => setClipThreshold("highlights", v / 100)}
            min={90}
            max={100}
            step={0.1}
            origin={99.5}
            size="S"
            className="min-w-0 flex-1"
            aria-label="Highlight clipping threshold"
          />
          <Readout>{(clipHighlight * 100).toFixed(1)}%</Readout>
        </Field>
        <Field label="Shadows">
          <Slider
            value={clipShadow * 100}
            onChange={(v) => setClipThreshold("shadows", v / 100)}
            min={0}
            max={5}
            step={0.05}
            origin={0.25}
            size="S"
            className="min-w-0 flex-1"
            aria-label="Shadow clipping threshold"
          />
          <Readout>{(clipShadow * 100).toFixed(2)}%</Readout>
        </Field>
      </FieldGroup>
    </>
  );
}

const APPEARANCES = Object.entries(APPEARANCE_LABELS).map(([value, label]) => ({
  value: value as Appearance,
  label,
}));

const TEXT_SIZES = Object.entries(TEXT_SIZE_LABELS).map(([value, label]) => ({
  value: value as TextSize,
  label,
}));

function InterfacePane() {
  const appearance = useUI((s) => s.appearance);
  const setAppearance = useUI((s) => s.setAppearance);
  const textSize = useUI((s) => s.textSize);
  const setTextSize = useUI((s) => s.setTextSize);
  const soloPanels = useUI((s) => s.soloPanels);
  const toggleSoloPanels = useUI((s) => s.toggleSoloPanels);
  const showGridExtras = useUI((s) => s.showGridExtras);
  const toggleGridExtras = useUI((s) => s.toggleGridExtras);
  const thumbSize = useUI((s) => s.thumbSize);
  const setThumbSize = useUI((s) => s.setThumbSize);

  return (
    <>
      <FieldGroup title="Appearance">
        <Field label="Theme">
          <Select
            options={APPEARANCES}
            value={appearance}
            onChange={setAppearance}
            aria-label="Appearance"
            className="flex-1"
          />
        </Field>
        <Field label="Text size">
          <Select
            value={textSize}
            onChange={setTextSize}
            options={TEXT_SIZES}
            aria-label="Text size"
            className="flex-1"
          />
        </Field>
      </FieldGroup>
      <FieldGroup title="Workspace">
        <Field label="Develop panels">
          <Checkbox
            checked={soloPanels}
            onChange={toggleSoloPanels}
            label="Open one panel at a time"
          />
        </Field>
      </FieldGroup>
      <FieldGroup title="Library">
        <Field label="Overlays">
          <Checkbox
            checked={showGridExtras}
            onChange={toggleGridExtras}
            label="Show grid badges"
          />
        </Field>
        <Field label="Thumbnail size">
          <Slider
            value={thumbSize}
            onChange={setThumbSize}
            min={90}
            max={420}
            step={1}
            origin={90}
            size="S"
            className="min-w-0 flex-1"
            aria-label="Thumbnail size"
          />
          <Readout>{thumbSize} px</Readout>
        </Field>
      </FieldGroup>
    </>
  );
}

const IMPORT_DEVELOP: Array<{ value: ImportDevelop; label: string }> = [
  { value: "none", label: "As shot" },
  { value: "tone", label: "Auto tone" },
  { value: "auto", label: "Auto tone and white balance" },
  { value: "preset", label: "A preset…" },
];

function FilesPane({ onBackupBusyChange }: { onBackupBusyChange: (busy: boolean) => void }) {
  const importSidecars = useUI((s) => s.importSidecars);
  const setImportSidecars = useUI((s) => s.setImportSidecars);
  const autoWriteSidecars = useUI((s) => s.autoWriteSidecars);
  const setAutoWriteSidecars = useUI((s) => s.setAutoWriteSidecars);
  const importDevelop = useUI((s) => s.importDevelop);
  const setImportDevelop = useUI((s) => s.setImportDevelop);
  const importPresetId = useUI((s) => s.importPresetId);
  const setImportPresetId = useUI((s) => s.setImportPresetId);
  const previewOnImport = useUI((s) => s.previewOnImport);
  const setPreviewOnImport = useUI((s) => s.setPreviewOnImport);
  const rememberDestination = useUI((s) => s.rememberDestination);
  const setRememberDestination = useUI((s) => s.setRememberDestination);

  const [presets, setPresets] = useState<Preset[] | null>(null);

  // Only read when the row that needs them appears — a preset library can run
  // to hundreds of rows and nothing else in this pane wants them.
  useEffect(() => {
    if (importDevelop !== "preset" || presets) return;
    void db.presets
      .toArray()
      .then((user) => setPresets([...BUILTIN_PRESETS, ...user]))
      .catch(() => setPresets([...BUILTIN_PRESETS]));
  }, [importDevelop, presets]);

  /**
   * Writing needs permission the browser will only grant inside a gesture, so
   * the ask happens on the click that turns the switch on. Refused, the switch
   * goes back rather than sitting on and quietly writing nothing.
   */
  const toggleWrite = async (on: boolean) => {
    if (!on) {
      setAutoWriteSidecars(false);
      cancelSidecarWrites();
      return;
    }
    const { granted, denied } = await authoriseSidecarWrites();
    if (!granted && denied) {
      toast.error(
        "No folders are writable",
        "esque needs permission to write beside your originals.",
      );
      return;
    }
    setAutoWriteSidecars(true);
    if (denied) {
      toast.show("Sidecars on for some folders", {
        detail: `${denied} ${denied === 1 ? "folder" : "folders"} refused write access.`,
      });
    }
  };

  const presetOptions = useMemo(
    () =>
      (presets ?? []).map((p) => ({
        value: p.id,
        label: p.group ? `${p.group} — ${p.name}` : p.name,
      })),
    [presets],
  );

  return (
    <>
      <FieldGroup title="Import">
        <Field label="XMP sidecars">
          <Checkbox
            checked={importSidecars}
            onChange={setImportSidecars}
            label="Read sidecars on import"
          />
        </Field>
        <Field label="Develop">
          <Select
            value={importDevelop}
            onChange={setImportDevelop}
            options={IMPORT_DEVELOP}
            aria-label="Develop on import"
            className="flex-1"
          />
        </Field>
        {importDevelop === "preset" && (
          <Field label="Preset">
            <Select
              value={importPresetId ?? ""}
              onChange={(id) => setImportPresetId(id || null)}
              options={
                presets === null
                  ? [{ value: "", label: "Loading…" }]
                  : presetOptions.length
                    ? presetOptions
                    : [{ value: "", label: "No presets" }]
              }
              aria-label="Import preset"
              disabled={presets === null || !presetOptions.length}
              className="flex-1"
            />
          </Field>
        )}
        <Field label="Previews">
          <Checkbox
            checked={previewOnImport}
            onChange={setPreviewOnImport}
            label="Build previews on import"
          />
        </Field>
      </FieldGroup>
      <FieldGroup title="Sidecar files">
        <Field label="Automatic writes">
          <Checkbox
            checked={autoWriteSidecars}
            onChange={(on) => void toggleWrite(on)}
            label="Write sidecars automatically"
          />
        </Field>
      </FieldGroup>
      <FieldGroup title="Export">
        <Field label="Destination">
          <Checkbox
            checked={rememberDestination}
            onChange={(on) => {
              setRememberDestination(on);
              if (!on) forgetDestination();
            }}
            label="Remember the last export folder"
          />
        </Field>
      </FieldGroup>
      <CatalogBackup onBusyChange={onBackupBusyChange} />
    </>
  );
}

const GB = 1024 * 1024 * 1024;

const CACHE_LIMITS = [
  { value: "0", label: "Automatic" },
  { value: String(GB), label: "1 GB" },
  { value: String(2 * GB), label: "2 GB" },
  { value: String(5 * GB), label: "5 GB" },
  { value: String(10 * GB), label: "10 GB" },
  { value: String(20 * GB), label: "20 GB" },
];

const CACHE_AGES = [
  { value: "0", label: "Forever" },
  { value: "7", label: "A week" },
  { value: "30", label: "A month" },
  { value: "90", label: "Three months" },
  { value: "365", label: "A year" },
];

function CachePane() {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [clearing, setClearing] = useState(false);
  const cacheLimit = useUI((s) => s.cacheLimit);
  const setCacheLimit = useUI((s) => s.setCacheLimit);
  const cacheMaxAgeDays = useUI((s) => s.cacheMaxAgeDays);
  const setCacheMaxAgeDays = useUI((s) => s.setCacheMaxAgeDays);

  const refresh = useCallback(() => {
    void cacheStats().then(setStats);
  }, []);

  useEffect(refresh, [refresh]);

  const clear = async () => {
    setClearing(true);
    try {
      await cacheClear({ previewsOnly: true });
      toast.show("Preview cache cleared", {
        detail: "AI models and saved mask coverage are unchanged.",
      });
      refresh();
    } catch (err) {
      toast.error(
        "Could not clear the cache",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setClearing(false);
    }
  };

  // A limit is measured against itself, not the quota: a 2 GB ceiling on a
  // 300 GB allowance would otherwise draw as an empty bar however full it was.
  const ceiling = cacheLimit > 0 ? cacheLimit : (stats?.quota ?? 0);
  const usedShare = stats && ceiling > 0 ? Math.min(1, stats.bytes / ceiling) : 0;
  const empty = !stats || stats.bytes === 0;

  return (
    <>
      <FieldGroup title="Local cache">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <Readout disabled={!stats}>
            {stats && ceiling > 0
              ? `${formatBytes(stats.bytes)} of ${formatBytes(ceiling)}`
              : "Measuring…"}
          </Readout>
          <Button onClick={() => void clear()} disabled={clearing || empty}>
            {clearing ? "Clearing…" : "Clear previews"}
          </Button>
        </div>
        <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-control">
          <div
            className="h-full rounded-full bg-label-secondary transition-[width] duration-[--duration-slow] ease-[--ease-out]"
            style={{
              width: `${Math.max(usedShare * 100, stats && stats.bytes ? 1 : 0)}%`,
            }}
          />
        </div>
        <p className="mt-2 text-mini leading-relaxed text-label-secondary">
          Includes previews, AI models and saved masks. Clearing previews keeps AI
          models and mask coverage. Manage model downloads in AI models.
        </p>
      </FieldGroup>
      <FieldGroup title="Cache limits">
        <p className="mb-3 text-mini leading-relaxed text-label-secondary">
          Cleanup removes previews first. AI models and saved masks are protected,
          so total storage can remain above the size limit.
        </p>
        <Field label="Size limit">
          <Select
            value={String(cacheLimit)}
            onChange={(v) => setCacheLimit(Number(v))}
            options={CACHE_LIMITS}
            aria-label="Cache size limit"
            className="flex-1"
          />
        </Field>
        <Field label="Keep previews">
          <Select
            value={String(cacheMaxAgeDays)}
            onChange={(v) => setCacheMaxAgeDays(Number(v))}
            options={CACHE_AGES}
            aria-label="Keep previews"
            className="flex-1"
          />
        </Field>
      </FieldGroup>
    </>
  );
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

/**
 * The shortcut reference, and the place to change one.
 *
 * It is a reference first. Nearly everyone who opens this pane wants to know
 * what a key does, not to change it — so the list is complete, grouped the way
 * the app is, and searchable by both name and chord. Remapping is the same
 * rows, one click deeper: press the chip, press the keys.
 *
 * A few bindings are marked fixed and cannot be taken: undo, Escape, Tab and
 * ⌘, are how you get out of trouble, and a keymap that can lock you out of
 * its own settings dialog is not a feature.
 */
function KeyboardPane() {
  const keyBindings = useUI((s) => s.keyBindings);
  const setKeyBinding = useUI((s) => s.setKeyBinding);
  const resetKeyBindings = useUI((s) => s.resetKeyBindings);
  const [query, setQuery] = useState("");
  const [capturing, setCapturing] = useState<string | null>(null);

  const needle = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const match = (c: Command) =>
      !needle ||
      c.label.toLowerCase().includes(needle) ||
      GROUP_LABELS[c.group].toLowerCase().includes(needle) ||
      chordsFor(c, keyBindings).some((k) =>
        formatChord(k).toLowerCase().includes(needle),
      );
    return GROUP_ORDER.map((group) => ({
      group,
      commands: COMMANDS.filter((c) => c.group === group && match(c)),
    })).filter((g) => g.commands.length);
  }, [needle, keyBindings]);

  const capture = useCallback(
    (commandId: string, e: KeyboardEvent) => {
      // Escape leaves without binding; every other key is being swallowed, so
      // without it the armed chip would be a trap.
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      // A bare modifier is halfway through a chord, not a chord.
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();

      const chord = chordOf(e);
      if (chord === "backspace" || chord === "delete") {
        setKeyBinding(commandId, null);
        setCapturing(null);
        return;
      }
      const clash = conflictsFor(chord, commandId, keyBindings);
      setKeyBinding(commandId, [chord]);
      setCapturing(null);
      if (clash.length) {
        toast.show(`${formatChord(chord)} is also ${clash[0].label}`, {
          detail: "Whichever applies where you are wins.",
        });
      }
    },
    [keyBindings, setKeyBinding],
  );

  /**
   * Capture runs on the window, not on the chip.
   *
   * A `keydown` handler on the button only fires while the button has focus,
   * and a click does not reliably focus a button — it does not in Safari at
   * all. That made the chip look armed and swallow nothing. Listening on the
   * window in the capture phase means the next key is caught wherever focus
   * happens to be, which is also what "press the keys you want" promises.
   */
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => capture(capturing, e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, capture]);

  const changed = Object.keys(keyBindings).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <TextField
          value={query}
          onChange={setQuery}
          placeholder="Search shortcuts"
          aria-label="Search shortcuts"
          className="min-w-0 flex-1"
        />
        <Button onClick={resetKeyBindings} disabled={!changed}>
          Reset
        </Button>
      </div>

      {groups.length === 0 && (
        <p className="py-6 text-center text-ui text-label-tertiary">
          Nothing matches “{query.trim()}”.
        </p>
      )}

      {groups.map(({ group, commands }) => (
        <section key={group} className="pt-1">
          <h3 className="pb-2 text-ui font-medium text-label">
            {GROUP_LABELS[group]}
          </h3>
          <div>
            {commands.map((command) => {
              const custom = !!keyBindings[command.id];
              const chords = chordsFor(command, keyBindings);
              const armed = capturing === command.id;
              return (
                <div
                  key={command.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-1.5 [&+&]:hairline-t"
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="text-ui text-label">
                      {command.label}
                    </span>
                    {command.scope && (
                      <span className="shrink-0 text-micro text-label-tertiary">
                        {command.scope}
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    disabled={command.fixed}
                    onClick={() => setCapturing(armed ? null : command.id)}
                    aria-label={`${command.label}: ${chords.map((chord) => formatChord(chord)).join(" or ")}${
                      command.fixed ? " (fixed)" : ". Press to change."
                    }`}
                    className={cn(
                      "h-6 shrink-0 rounded-sm px-2 text-mini tabular-nums coarse:h-9",
                      "transition-colors duration-[--duration-fast] ease-[--ease-out]",
                      armed
                        ? "bg-accent-soft text-accent"
                        : command.fixed
                          ? "cursor-default text-label-tertiary"
                          : cn(
                              "hover:bg-raised",
                              custom ? "text-accent" : "text-label-secondary",
                            ),
                    )}
                  >
                    {armed ? "Press keys…" : formatChord(chords[0])}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function AboutPane() {
  const [credits, setCredits] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <Logo size={32} />
        <div>
          <p className="font-display text-headline font-[590] text-label">
            esque
          </p>
          <p className="mt-1 text-ui leading-relaxed text-label-secondary">
            Version {APP_VERSION}
          </p>
        </div>
      </div>
      <p className="text-ui leading-relaxed text-label-secondary">
        A photo editor that runs in your browser.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={openWhatsNew}>What's new…</Button>
        <Button onClick={() => setCredits(true)}>Acknowledgements…</Button>
      </div>
      <p className="text-mini text-label-secondary">
        Free software under the AGPL-3.0 licence.
      </p>

      <AcknowledgementsDialog
        open={credits}
        onClose={() => setCredits(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

/** A slider's or meter's value, in the UI face with figures that hold their column. */
function Readout({
  children,
  disabled,
}: {
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <span
      className={cn(
        "shrink-0 text-right text-ui whitespace-nowrap tabular-nums",
        disabled ? "text-label-tertiary" : "text-label-secondary",
      )}
    >
      {children}
    </span>
  );
}

/** Package name → the licence it ships under. Grouped so the column reads short. */
const LICENCES: Array<[string, string]> = [
  ["LibRaw", "LGPL-2.1 / CDDL-1.0"],
  ["React", "MIT"],
  ["Zustand", "MIT"],
  ["Immer", "MIT"],
  ["TanStack Virtual", "MIT"],
  ["exifr", "MIT"],
  ["clsx", "MIT"],
  ["Tailwind CSS", "MIT"],
  ["Vite", "MIT"],
  ["Dexie", "Apache-2.0"],
  ["Comlink", "Apache-2.0"],
  ["jSquash", "Apache-2.0"],
  ["Lucide", "ISC"],
  ["Inter", "SIL OFL 1.1"],
  ["JetBrains Mono", "SIL OFL 1.1"],
];

function AcknowledgementsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Acknowledgements"
      width={400}
      height={320}
    >
      <p className="pb-3 text-mini leading-relaxed text-label-secondary">
        esque ships the following open-source components.
      </p>
      <dl className="grid grid-cols-[1fr_auto] gap-x-6 text-ui">
        {LICENCES.map(([name, licence]) => (
          <div
            key={name}
            className="col-span-2 grid grid-cols-subgrid py-1.5 [&+&]:hairline-t"
          >
            <dt className="truncate text-label">{name}</dt>
            <dd className="text-label-secondary tabular-nums">{licence}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
