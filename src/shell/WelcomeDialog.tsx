import { useEffect, useState, type ReactNode } from 'react'
import { Dialog } from '../design/Dialog'
import { Button, SegmentedControl } from '../design/Controls'
import { Scroller } from '../design/Scroller'
import { GitHubIcon, Logo } from '../design/icons'
import { cn } from '../lib/cn'
import { usePhotoCount } from '../catalog/hooks'
import { useIsPhone } from '../lib/useViewport'
import { useImporter } from '../state/importer'
import {
  APP_VERSION,
  formatReleaseDate,
  groupChanges,
  KIND_LABELS,
  RELEASES,
  REPO_URL,
  type ChangeKind,
  type Release,
} from './changelog'

/**
 * The dialog someone meets before the app.
 *
 * It has one job on a first run and a different one after an update, so rather
 * than stacking both into a single scroll it has two faces and opens on the one
 * that was asked for: *About* for a stranger, *What's new* for someone who has
 * been here before and only wants to know what moved.
 *
 * Deliberately not a tour and not a feature list. `EmptyLibrary` already says
 * the one thing that has to happen next, so About says the three things that
 * are true of every session — where the files live, what an edit is, what does
 * the work — and then gets out of the way behind a button that starts an
 * import.
 *
 * Both faces read down the same left edge: a fixed column carrying a term on
 * one face and a release number on the other, against text in the second
 * column. It is the settings-row vocabulary the rest of the app uses, which is
 * why switching faces doesn't feel like changing dialogs.
 */

export type WelcomeFace = 'about' | 'news'

export function WelcomeDialog({
  open,
  onClose,
  face: initial = 'about',
}: {
  open: boolean
  onClose: () => void
  /** Which face leads. Re-applied each time the dialog is opened. */
  face?: WelcomeFace
}) {
  const [face, setFace] = useState<WelcomeFace>(initial)
  const phone = useIsPhone()
  const photoCount = usePhotoCount()
  const importing = useImporter((s) => s.active)
  const run = useImporter((s) => s.run)

  // The face is a property of *why* the dialog opened, so a reopen resets it
  // rather than resuming wherever the last visit was left.
  useEffect(() => {
    if (open) setFace(initial)
  }, [open, initial])

  /*
   * An empty catalog is the one state where this dialog stands between someone
   * and the whole point of the app, so About offers the way in itself. What's
   * new does not: someone reading release notes came to read them, and a
   * primary button that opens a folder picker under them is a trapdoor.
   *
   * The picker is opened from the click, before anything awaits, so the gesture
   * still counts; closing first means the chooser doesn't come up over a modal.
   */
  const canImport = face === 'about' && photoCount === 0 && !importing
  const startImport = () => {
    onClose()
    void run()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="esque"
      // The same lockup as the title bar: this dialog is the app introducing
      // itself, so the name it gives arrives with the mark it wears.
      titleIcon={<Logo size={18} className="shrink-0" />}
      width={520}
      height={600}
      scrollable={false}
      dividers={false}
      bodyClassName="flex-col items-stretch"
      footer={
        <>
          <span className="mr-auto truncate text-mini tabular-nums text-label-secondary">
            Version {APP_VERSION}
          </span>
          {canImport ? (
            <>
              <Button onClick={onClose}>Not now</Button>
              <Button variant="primary" onClick={startImport}>
                Import photos…
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          )}
        </>
      }
    >
      <div className="shrink-0 px-5 pb-3">
        <SegmentedControl<WelcomeFace>
          value={face}
          onChange={setFace}
          options={[
            { value: 'about', label: 'About' },
            { value: 'news', label: "What's new" },
          ]}
          className="w-[184px]"
        />
      </div>

      {/* Keyed so the pane genuinely remounts: the scroll position belongs to
          the face, and coming back to About should not land mid-paragraph. */}
      <Scroller
        key={face}
        frameClassName="min-h-0 flex-1"
        className="px-5 pb-2"
        edgeFade
        role="tabpanel"
        aria-label={face === 'about' ? 'About esque' : "What's new"}
      >
        <div className="animate-[faceIn_var(--duration-base)_var(--ease-out)]">
          {face === 'about' ? <AboutFace phone={phone} /> : <NewsFace phone={phone} />}
        </div>
      </Scroller>

      <style>{`@keyframes faceIn{from{opacity:0;translate:0 4px}to{opacity:1;translate:0 0}}`}</style>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// The shared grid
// ---------------------------------------------------------------------------

/**
 * A term against its text, in the fixed column both faces share.
 *
 * On a phone the column is gone — 112px out of ~300 leaves a measure of about
 * twenty characters, which is a stack of ragged fragments rather than a
 * sentence — so the term sits above its text instead.
 */
function Row({
  term,
  phone,
  children,
  className,
}: {
  term: ReactNode
  phone: boolean
  children: ReactNode
  className?: string
}) {
  if (phone)
    return (
      <div className={cn('flex flex-col gap-1', className)}>
        {term}
        {children}
      </div>
    )
  return (
    <div className={cn('grid grid-cols-[112px_1fr] items-start gap-x-3', className)}>
      {term}
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** The left column's plain form: a short label sitting on the text's first line. */
function Term({ children }: { children: ReactNode }) {
  return <span className="text-ui font-medium text-label">{children}</span>
}

function Prose({ children }: { children: ReactNode }) {
  return <p className="text-ui leading-relaxed text-label-secondary">{children}</p>
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

/* The three questions a photo editor reached through a browser has to answer. */
const FACTS: Array<[string, string]> = [
  [
    'Files',
    'Photos stay in the folder you choose, under their own names. Nothing is uploaded, and the catalog and its previews are kept in this browser.',
  ],
  [
    'Edits',
    'Originals are never changed. Adjustments are saved separately, so any step can be undone, kept as a preset, or opened in Lightroom through XMP.',
  ],
  [
    'Rendering',
    'RAW files are decoded by LibRaw compiled to WebAssembly, and edits render on your GPU through WebGPU.',
  ],
]

function AboutFace({ phone }: { phone: boolean }) {
  return (
    <div className="flex flex-col gap-3.5">
      <Prose>
        A free, open-source photo editor that runs in your browser. An alternative to Lightroom for
        organising and editing your photos.
      </Prose>
      {FACTS.map(([term, text]) => (
        <Row key={term} term={<Term>{term}</Term>} phone={phone}>
          <Prose>{text}</Prose>
        </Row>
      ))}

      {/*
       * The small print earns both the rule and the smaller setting: it is
       * about the project rather than about the app, and it is the part someone
       * is allowed to stop reading. Size carries that, not colour — these are
       * still whole sentences and they have to stay legible.
       */}
      <div className="hairline-t flex flex-col gap-2.5 pt-3.5">
        <SmallRow term="Early days" phone={phone}>
          esque is still in development and things change between releases. Every one is listed
          under What's new.
        </SmallRow>

        <SmallRow term="Requirements" phone={phone}>
          Chrome, Edge or another Chromium browser. Folder access and WebGPU are not available
          elsewhere yet.
        </SmallRow>

        <SmallRow term="Licence" phone={phone}>
          Free software under the AGPL-3.0. Anyone serving a copy over a network has to offer its
          source to the people using it.
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className={cn(
              'esq-tap mt-1.5 flex w-fit items-center gap-1.5 font-medium text-accent',
              'transition-colors duration-[--duration-fast] ease-[--ease-out] hover:text-accent-hover',
            )}
          >
            <GitHubIcon size={12} />
            Source on GitHub
          </a>
        </SmallRow>
      </div>
    </div>
  )
}

function SmallRow({
  term,
  phone,
  children,
}: {
  term: string
  phone: boolean
  children: ReactNode
}) {
  return (
    <Row
      phone={phone}
      term={<span className="text-mini font-medium text-label">{term}</span>}
    >
      <p className="text-mini leading-[1.55] text-label-secondary">{children}</p>
    </Row>
  )
}

// ---------------------------------------------------------------------------
// What's new
// ---------------------------------------------------------------------------

/**
 * The one place in this app where colour carries meaning rather than sitting on
 * a photo: three kinds of change, told apart at a glance while scanning. The
 * muted label swatches, not the vivid system colours — a changelog should not
 * out-saturate the photograph behind it.
 */
const KIND_INK: Record<ChangeKind, string> = {
  added: 'text-label-green',
  improved: 'text-label-blue',
  fixed: 'text-label-yellow',
}

function NewsFace({ phone }: { phone: boolean }) {
  return (
    <div className="flex flex-col">
      {RELEASES.map((release, i) => (
        <Row
          key={release.version}
          term={<ReleasePlate release={release} phone={phone} />}
          phone={phone}
          // Releases run down one page rather than in separate boxes, so the
          // rule between them is the only thing that has to say "next one".
          className={cn(i > 0 && 'hairline-t mt-5 pt-5')}
        >
          <p className="text-ui leading-relaxed text-balance text-label">{release.summary}</p>

          <div className="mt-3.5 flex flex-col gap-3.5">
            {groupChanges(release).map(([kind, changes]) => (
              <section key={kind}>
                <h3
                  className={cn(
                    'text-micro font-semibold tracking-[0.06em] uppercase',
                    KIND_INK[kind],
                  )}
                >
                  {KIND_LABELS[kind]}
                </h3>
                <ul className="mt-1.5 flex flex-col gap-2">
                  {changes.map((change) => (
                    <li key={change.term} className="text-ui leading-relaxed text-label-secondary">
                      <span className="font-medium text-label">{change.term}</span>
                      {': '}
                      {change.text}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </Row>
      ))}
    </div>
  )
}

/**
 * The version, set as the thing it is: the number this release is known by.
 * Stacked in the column on a desktop; on a phone, where the column has been
 * given up, the date tucks in beside it rather than costing a second line.
 */
function ReleasePlate({ release, phone }: { release: Release; phone: boolean }) {
  return (
    <div className={cn('flex', phone ? 'items-baseline gap-x-2' : 'flex-col gap-0.5')}>
      <span className="font-display text-title font-[590] tabular-nums text-label">
        {release.version}
      </span>
      <span className="text-mini whitespace-nowrap text-label-secondary">
        {formatReleaseDate(release.date)}
      </span>
    </div>
  )
}
