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
  SegmentedControl,
  Select,
  Switch,
  TextField,
} from "../design/Controls";
import { Field } from "../design/Field";
import { Scroller } from "../design/Scroller";
import { Slider } from "../design/Slider";
import { toast } from "../design/toast";
import {
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
  ACCENTS,
  ACCENT_LABELS,
  ACCENT_SWATCHES,
  APPEARANCE_LABELS,
  SURROUND_LABELS,
  TEXT_SIZE_LABELS,
  type Accent,
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

/**
 * Settings is a *panel*, not a list.
 *
 * Every row here is a label in a fixed column and a control in the next, and
 * for three groups of settings that grid is the whole vocabulary. About is not
 * a setting though — it is the app's signature — and stacking it under the
 * cache meter as a fourth "group" forced it to borrow a grid it could never
 * satisfy, which is what made the bottom of this dialog read as a pile.
 *
 * So the groups became panes behind a rail that runs along the top, under the
 * title. Each pane owns its own state and lands in a frame of fixed size —
 * switching panes never resizes the dialog under the pointer — and About
 * finally gets a stage of its own instead of a leftover row.
 *
 * The frame is sized to the panes, not to a round number: three or four rows do
 * not fill 340px, and the emptiness underneath read as something missing rather
 * than as air. `--field-measure` closes the control column on its right, so a
 * select, a switch and a slider all start and end on the same two verticals.
 *
 * It grew when Keyboard arrived. A shortcut reference is a *list* and a list
 * needs a run of rows to read as one — six visible rows is a settings pane with
 * a scrollbar, twelve is a reference — so the frame was set by that pane and
 * the others were allowed to keep their air rather than the reverse.
 */

const PANES = [
  { id: "display", label: "Display", icon: DisplayIcon },
  { id: "interface", label: "Interface", icon: InterfaceIcon },
  { id: "files", label: "Files", icon: FolderIcon },
  { id: "keyboard", label: "Keys", icon: KeyboardIcon },
  { id: "cache", label: "Cache", icon: CacheIcon },
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

  return (
    <Dialog
      open={open}
      onClose={() => { if (!backupBusy) onClose(); }}
      dismissable={!backupBusy}
      title="Settings"
      width={520}
      height={430}
      scrollable={false}
      dividers={false}
      // The control column closes on the dialog's own right margin: 116px of
      // label, the gap, and the rest. A narrower measure left a band of nothing
      // down the right of every pane that the keyboard list could not use.
      bodyClassName="flex-col items-stretch [--field-measure:352px]"
      footer={
        <Button variant="primary" disabled={backupBusy} onClick={onClose}>
          Done
        </Button>
      }
    >
      <Rail pane={pane} onSelect={setPane} disabled={backupBusy} />
      {/* Panes mount only while shown, so each one's setup — the cache reading
          the disk, say — happens exactly when it is asked for. */}
      <Scroller
        key={pane}
        frameClassName="min-h-0 flex-1"
        className="px-5 pt-1 pb-3"
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
        {pane === "about" && <AboutPane />}
      </Scroller>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------

/**
 * The pane list. It runs along the top, its items starting on the same left
 * edge as the dialog's own title — the padding is split between the rail and
 * the item so the icons land at 20px, exactly where "Settings" starts.
 */
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

  // Roving focus: the rail is one tab stop and the arrows walk it, so a
  // keyboard user isn't made to step through five buttons to reach the fields.
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
      // No rule under the rail: with the header and footer undivided, a hairline
      // inset from the dialog's edges dangles short of both. The selected chip
      // and the gap carry the separation instead.
      className="flex min-w-0 shrink-0 items-center gap-px overflow-x-auto px-3 pt-1 pb-2"
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
              "flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-left text-ui",
              "transition-colors duration-[--duration-fast] ease-[--ease-out]",
              active
                ? "bg-accent-soft text-accent"
                : "text-label-secondary hover:bg-raised hover:text-label",
            )}
          >
            <Icon
              className={cn(
                "size-3.5 shrink-0",
                !active && "text-icon-tertiary",
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
      <Field label="Proof against">
        <Select
          value={softProof}
          onChange={setSoftProof}
          options={PROOF_SPACES}
          className="flex-1"
        />
      </Field>
      <Field
        label="HDR preview"
        hint={reach === "none" ? "Not available in this browser." : undefined}
      >
        <Switch
          checked={hdr}
          onChange={setHdr}
          disabled={reach === "none"}
          label="HDR preview"
        />
      </Field>
      {/* Named "backdrop" rather than "surround" because that is what it is to
          everyone who has not read a colour-science paper — but it is the
          surround field in the technical sense, which is why it belongs to
          Display and sits directly under the proofing space it biases. */}
      <Field label="Backdrop">
        <Select
          value={surround}
          onChange={setSurround}
          options={SURROUNDS}
          className="flex-1"
        />
      </Field>
      <Field label="Preview quality">
        <Select
          value={previewQuality}
          onChange={setPreviewQuality}
          options={PREVIEW_QUALITIES}
          className="flex-1"
        />
      </Field>
      {/* Expressed as stops-from-clipping would be truer to how the numbers are
          used and unreadable on a slider. Percent of full scale is what the
          histogram already shows, so the two agree on screen. */}
      <Field label="Highlight warning">
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
      <Field label="Shadow warning">
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
  const accent = useUI((s) => s.accent);
  const setAccent = useUI((s) => s.setAccent);
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
      {/* Three appearances, not two. Dim exists because a fully black chrome
          around a bright photo is the highest-contrast thing on the desk and
          the eye keeps re-adapting to it; Dark is for a dark room, Dim for a
          lit one, and Light for working next to a window. */}
      <Field label="Appearance">
        <SegmentedControl
          options={APPEARANCES}
          value={appearance}
          onChange={setAppearance}
          size="sm"
          full
        />
      </Field>
      {/* The selected swatch carries a 2px ring at a 2px offset, so the row is
          4px taller on each side than it measures. Packed to the field's own
          3px rhythm that ring all but touched the control above and the select
          below; this gives it the air the other rows get for free. */}
      <Field label="Accent" className="pt-3 pb-2.5">
        <AccentPicker value={accent} onChange={setAccent} />
      </Field>
      <Field label="Text size">
        <Select
          value={textSize}
          onChange={setTextSize}
          options={TEXT_SIZES}
          className="flex-1"
        />
      </Field>
      {/* Every control starts on the column's left edge — select, slider,
          switch alike. A 26px toggle floated out to the right edge instead put
          a hand's width of nothing between a label and the thing it names. */}
      <Field label="Solo panels">
        <Switch
          checked={soloPanels}
          onChange={toggleSoloPanels}
          label="Solo panels"
        />
      </Field>
      <Field label="Grid badges">
        <Switch
          checked={showGridExtras}
          onChange={toggleGridExtras}
          label="Grid badges"
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
      </Field>
    </>
  );
}

/**
 * Nine colours as nine colours.
 *
 * A select naming them would be the consistent choice and the wrong one: the
 * value *is* the swatch, and reading the word "Teal" to find out what teal
 * looks like is a step the eye does not need. The names stay as the accessible
 * label, so nothing is lost to anyone not using the picker by sight.
 */
function AccentPicker({
  value,
  onChange,
}: {
  value: Accent;
  onChange: (a: Accent) => void;
}) {
  const swatches = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next =
      (ACCENTS.indexOf(value) + step + ACCENTS.length) % ACCENTS.length;
    onChange(ACCENTS[next]);
    swatches.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Accent colour"
      onKeyDown={onKeyDown}
      className="flex min-w-0 flex-1 items-center justify-between"
    >
      {ACCENTS.map((name, i) => {
        const active = name === value;
        return (
          <button
            key={name}
            ref={(el) => {
              swatches.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={ACCENT_LABELS[name]}
            title={ACCENT_LABELS[name]}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(name)}
            className={cn(
              "grid size-[18px] shrink-0 place-items-center rounded-full",
              "transition-transform duration-[--duration-fast] ease-[--ease-out]",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-label)",
              active ? "scale-100" : "scale-[0.82] hover:scale-95",
            )}
            style={{
              backgroundColor: ACCENT_SWATCHES[name],
              // An outline rather than a ring of box-shadows: the offset gap is
              // transparent, so it shows whatever the dialog is painted in and
              // the selected state reads the same in all three appearances
              // without naming a background colour it would have to keep in step.
              outline: active ? `2px solid ${ACCENT_SWATCHES[name]}` : undefined,
              outlineOffset: active ? 2 : undefined,
            }}
          />
        );
      })}
    </div>
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
      {/* Named for what it reads rather than for the file format: someone
          arriving from Lightroom is looking for their ratings and edits, and
          would not necessarily know those live in a file called .xmp. */}
      <Field label="Read sidecars">
        <Switch
          checked={importSidecars}
          onChange={setImportSidecars}
          label="Read sidecars on import"
        />
      </Field>
      <Field label="Write sidecars">
        <Switch
          checked={autoWriteSidecars}
          onChange={(on) => void toggleWrite(on)}
          label="Write sidecars automatically"
        />
      </Field>
      <Field label="Develop on import">
        <Select
          value={importDevelop}
          onChange={setImportDevelop}
          options={IMPORT_DEVELOP}
          className="flex-1"
        />
      </Field>
      {importDevelop === "preset" && (
        <Field>
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
            disabled={presets === null || !presetOptions.length}
            className="flex-1"
          />
        </Field>
      )}
      <Field label="Build previews">
        <Switch
          checked={previewOnImport}
          onChange={setPreviewOnImport}
          label="Build previews on import"
        />
      </Field>
      <Field label="Export folder">
        <Switch
          checked={rememberDestination}
          onChange={(on) => {
            setRememberDestination(on);
            if (!on) forgetDestination();
          }}
          label="Remember the last export folder"
        />
      </Field>
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
      await cacheClear();
      toast.show("Cache cleared", {
        detail: "Previews rebuild as you browse.",
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
    // With the label gone there is no field grid left to align to, so the pane
    // sits on its own left edge instead of indenting past a 116px gutter that
    // now holds nothing. The readout carries what the label used to say.
    <div className="flex flex-col gap-3 pt-1">
      <div className="flex items-center gap-2.5">
        <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-control">
          <div
            className="h-full rounded-full bg-accent/70 transition-[width] duration-[--duration-slow] ease-[--ease-out]"
            style={{
              width: `${Math.max(usedShare * 100, stats && stats.bytes ? 1 : 0)}%`,
            }}
          />
        </div>
        <Readout disabled={!stats}>
          {stats && ceiling > 0
            ? `${formatBytes(stats.bytes)} of ${formatBytes(ceiling)}`
            : "Measuring…"}
        </Readout>
      </div>
      <div>
        <Button onClick={() => void clear()} disabled={clearing || empty}>
          {clearing ? "Clearing…" : "Clear cache"}
        </Button>
      </div>

      <div className="pt-1">
        <Field label="Size limit">
          <Select
            value={String(cacheLimit)}
            onChange={(v) => setCacheLimit(Number(v))}
            options={CACHE_LIMITS}
            className="flex-1"
          />
        </Field>
        <Field label="Keep previews">
          <Select
            value={String(cacheMaxAgeDays)}
            onChange={(v) => setCacheMaxAgeDays(Number(v))}
            options={CACHE_AGES}
            className="flex-1"
          />
        </Field>
      </div>
    </div>
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
    // Held to the same right edge the field grid closes on — 116px of label
    // column, the gap, then the control measure — so the chords line up with
    // the selects and switches in every other pane instead of running out to
    // the dialog's own margin.
    <div className="flex max-w-[calc(116px+0.75rem+var(--field-measure))] flex-col gap-2">
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
          <h3 className="pb-1 text-mini font-medium text-label-tertiary">
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
                  className="grid grid-cols-[1fr_auto] items-center gap-x-3 py-[3px] [&+&]:hairline-t"
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-ui text-label">
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
                    aria-label={`${command.label}: ${chords.map(formatChord).join(" or ")}${
                      command.fixed ? " (fixed)" : ". Press to change."
                    }`}
                    className={cn(
                      "h-6 shrink-0 rounded-md px-2 text-mini tabular-nums",
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

/**
 * The one pane that is not a settings grid: the mark over the name, centred in
 * the frame with nothing else competing for the eye. The line of small print
 * sits on the floor of the pane rather than trailing the tagline, so it reads
 * as a footer and can be set legibly instead of being hidden by its own colour.
 */
function AboutPane() {
  const [credits, setCredits] = useState(false);

  return (
    <div className="flex min-h-full flex-col items-center text-center">
      <div className="my-auto flex flex-col items-center gap-4">
        <div className="flex flex-col items-center gap-2.5">
          <Logo size={40} />
          <div>
            <p className="font-display text-headline font-[590] text-label">
              esque
            </p>
            <p className="mt-1 text-ui leading-relaxed text-label-secondary">
              Non-destructive RAW editing in the browser.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Same weight as Acknowledgements on purpose: both are the pane's
              reading matter, and neither is the thing you came to Settings for. */}
          <Button onClick={openWhatsNew}>What's new…</Button>
          <Button onClick={() => setCredits(true)}>Acknowledgements…</Button>
        </div>
      </div>

      <p className="pt-2 pb-1 text-mini tabular-nums text-label-tertiary">
        Version {APP_VERSION} · AGPL-3.0
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
