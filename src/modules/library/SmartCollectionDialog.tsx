import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { cn } from '../../lib/cn'
import { Dialog } from '../../design/Dialog'
import { Button, IconButton, SegmentedControl, Select, TextField } from '../../design/Controls'
import { CloseIcon, PlusIcon } from '../../design/icons'
import { db } from '../../catalog/db'
import { applySmartRules } from '../../catalog/hooks'
import { createCollection, updateCollection } from '../../catalog/actions'
import { useCatalog } from '../../state/catalog'
import { useSmartEditor } from '../../state/smartEditor'
import { toast } from '../../design/toast'
import type { Collection, Photo, SmartRule, SmartRuleField, SmartRuleOp } from '../../core/types'

/** Shared so an unresolved query doesn't hand the match memo a new array each render. */
const NO_PHOTOS: Photo[] = []

/**
 * The rule editor behind a smart collection.
 *
 * A smart collection is a saved question about the catalog, so the dialog shows
 * the answer while it is being written: the count under the rules updates as
 * you type, and it is the only way to know a rule says what you meant before
 * committing it.
 */

// ---------------------------------------------------------------------------
// Field vocabulary
// ---------------------------------------------------------------------------

type ValueKind = 'text' | 'number' | 'date' | 'choice'

interface FieldSpec {
  label: string
  kind: ValueKind
  ops: SmartRuleOp[]
  choices?: Array<{ value: string; label: string }>
  /** Where a fresh rule of this field starts. */
  initial: string | number
  step?: number
}

const TEXT_OPS: SmartRuleOp[] = ['contains', 'notContains', 'is', 'isNot', 'startsWith', 'endsWith']
const NUM_OPS: SmartRuleOp[] = ['is', 'isNot', 'gte', 'lte', 'inRange']
const CHOICE_OPS: SmartRuleOp[] = ['is', 'isNot']

const FIELDS: Record<SmartRuleField, FieldSpec> = {
  rating: { label: 'Rating', kind: 'number', ops: NUM_OPS, initial: 3, step: 1 },
  flag: {
    label: 'Flag',
    kind: 'choice',
    ops: CHOICE_OPS,
    initial: 'pick',
    choices: [
      { value: 'pick', label: 'Picked' },
      { value: 'unflagged', label: 'Unflagged' },
      { value: 'reject', label: 'Rejected' },
    ],
  },
  label: {
    label: 'Colour Label',
    kind: 'choice',
    ops: CHOICE_OPS,
    initial: 'red',
    choices: [
      { value: 'red', label: 'Red' },
      { value: 'yellow', label: 'Yellow' },
      { value: 'green', label: 'Green' },
      { value: 'blue', label: 'Blue' },
      { value: 'purple', label: 'Purple' },
      { value: 'none', label: 'No label' },
    ],
  },
  filename: { label: 'File Name', kind: 'text', ops: TEXT_OPS, initial: '' },
  keyword: {
    label: 'Keyword',
    kind: 'text',
    ops: ['contains', 'notContains'],
    initial: '',
  },
  camera: { label: 'Camera', kind: 'text', ops: TEXT_OPS, initial: '' },
  lens: { label: 'Lens', kind: 'text', ops: TEXT_OPS, initial: '' },
  iso: { label: 'ISO', kind: 'number', ops: NUM_OPS, initial: 1600, step: 100 },
  aperture: { label: 'Aperture', kind: 'number', ops: NUM_OPS, initial: 2.8, step: 0.1 },
  focalLength: { label: 'Focal Length', kind: 'number', ops: NUM_OPS, initial: 50, step: 1 },
  captureTime: { label: 'Capture Date', kind: 'date', ops: ['gte', 'lte', 'inRange'], initial: 0 },
  edited: {
    label: 'Edit State',
    kind: 'choice',
    ops: ['is'],
    initial: 'true',
    choices: [
      { value: 'true', label: 'Edited' },
      { value: 'false', label: 'Untouched' },
    ],
  },
  fileType: {
    label: 'File Type',
    kind: 'choice',
    ops: ['is'],
    initial: 'raw',
    choices: [
      { value: 'raw', label: 'RAW' },
      { value: 'rendered', label: 'JPEG and friends' },
    ],
  },
}

const OP_LABELS: Record<SmartRuleOp, string> = {
  is: 'is',
  isNot: 'is not',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  endsWith: 'ends with',
  gte: 'is at least',
  lte: 'is at most',
  inRange: 'is between',
}

const FIELD_ORDER: SmartRuleField[] = [
  'rating',
  'flag',
  'label',
  'keyword',
  'filename',
  'camera',
  'lens',
  'iso',
  'aperture',
  'focalLength',
  'captureTime',
  'edited',
  'fileType',
]

const newRule = (field: SmartRuleField = 'rating'): SmartRule => {
  const spec = FIELDS[field]
  return {
    field,
    op: spec.ops[0],
    value: field === 'captureTime' ? startOfToday() : spec.initial,
    ...(field === 'captureTime' ? { value2: startOfToday() } : {}),
  }
}

function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** `<input type="date">` speaks local YYYY-MM-DD; the rule stores epoch ms. */
const toDateInput = (ms: number) => {
  const d = new Date(ms || Date.now())
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const fromDateInput = (s: string, endOfDay = false) => {
  const [y, m, d] = s.split('-').map(Number)
  if (!y || !m || !d) return 0
  return new Date(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0).getTime()
}

// ---------------------------------------------------------------------------

/**
 * Mounted for the whole session, but the editor proper only exists while it is
 * open — the live count behind it reads the entire photo table, which is not a
 * query to leave running behind a closed dialog.
 */
export function SmartCollectionDialog() {
  const target = useSmartEditor((s) => s.target)
  if (!target) return null
  return <Editor target={target} />
}

function Editor({ target }: { target: Collection | 'new' }) {
  const close = useSmartEditor((s) => s.close)
  const setSource = useCatalog((s) => s.setSource)

  const existing = target === 'new' ? null : target
  const [name, setName] = useState(existing?.name ?? 'Smart Collection')
  const [match, setMatch] = useState<'all' | 'any'>(existing?.match ?? 'all')
  const [rules, setRules] = useState<SmartRule[]>(() =>
    existing?.rules.length ? existing.rules.map((r) => ({ ...r })) : [newRule()],
  )

  const photos = useLiveQuery(() => db.photos.toArray(), []) ?? NO_PHOTOS
  const matches = useMemo(
    () => applySmartRules(photos, { rules: rules.filter(isUsable), match }).length,
    [photos, rules, match],
  )

  const patch = (i: number, changes: Partial<SmartRule>) =>
    setRules((rs) => rs.map((r, n) => (n === i ? { ...r, ...changes } : r)))

  async function save() {
    const usable = rules.filter(isUsable)
    const clean = name.trim() || 'Smart Collection'
    if (existing) {
      await updateCollection(existing.id, { name: clean, rules: usable, match, smart: true })
      setSource({ kind: 'collection', id: existing.id })
    } else {
      const id = await createCollection(clean, [], { rules: usable, match })
      setSource({ kind: 'collection', id })
    }
    toast.show(`Saved “${clean}”`, {
      detail: `${matches.toLocaleString()} photo${matches === 1 ? '' : 's'} match`,
    })
    close()
  }

  return (
    <Dialog
      open
      onClose={close}
      title={existing ? 'Edit Smart Collection' : 'New Smart Collection'}
      description="Photos join and leave on their own as the catalog changes."
      width={620}
      footer={
        <>
          <span className="mr-auto text-mini tnum text-label-tertiary">
            {rules.some(isUsable)
              ? `${matches.toLocaleString()} photo${matches === 1 ? '' : 's'} match`
              : 'Every photo matches'}
          </span>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            {existing ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 pt-1 pb-2">
        <div className="flex items-center gap-3">
          <TextField
            value={name}
            onChange={setName}
            placeholder="Smart Collection"
            aria-label="Collection name"
            className="min-w-0 flex-1"
          />
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-mini text-label-tertiary">Match</span>
            <SegmentedControl
              size="sm"
              value={match}
              onChange={setMatch}
              options={[
                { value: 'all', label: 'All' },
                { value: 'any', label: 'Any' },
              ]}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          {rules.map((rule, i) => (
            <RuleRow
              key={i}
              rule={rule}
              conjunction={i === 0 ? undefined : match === 'all' ? 'and' : 'or'}
              onChange={(changes) => patch(i, changes)}
              onRemove={
                rules.length > 1 ? () => setRules((rs) => rs.filter((_, n) => n !== i)) : undefined
              }
            />
          ))}
          <div>
            <Button
              size="sm"
              variant="ghost"
              icon={<PlusIcon size={11} />}
              className="-ml-2"
              onClick={() => setRules((rs) => [...rs, newRule()])}
            >
              Add rule
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

/** A rule with nothing typed into it would match everything, so it is dropped. */
function isUsable(r: SmartRule): boolean {
  if (FIELDS[r.field].kind !== 'text') return true
  return String(r.value ?? '').trim().length > 0
}

function RuleRow({
  rule,
  conjunction,
  onChange,
  onRemove,
}: {
  rule: SmartRule
  conjunction?: 'and' | 'or'
  onChange: (changes: Partial<SmartRule>) => void
  onRemove?: () => void
}) {
  const spec = FIELDS[rule.field]
  const range = rule.op === 'inRange'

  return (
    <div className="flex items-center gap-2">
      <span className="w-7 shrink-0 text-right text-micro text-label-quaternary">
        {conjunction}
      </span>

      <Select
        size="sm"
        value={rule.field}
        options={FIELD_ORDER.map((f) => ({ value: f, label: FIELDS[f].label }))}
        onChange={(field) => onChange(newRule(field))}
        className="w-[124px]"
      />

      <Select
        size="sm"
        value={rule.op}
        options={spec.ops.map((o) => ({ value: o, label: OP_LABELS[o] }))}
        onChange={(op) =>
          onChange({
            op,
            // Leaving a stale second bound behind would quietly widen a range
            // the next time one is chosen. Only numbers and dates offer
            // `inRange`, so the opening bound is always a number.
            value2: op === 'inRange' ? (rule.value2 ?? Number(rule.value)) : undefined,
          })
        }
        className="w-[124px]"
      />

      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <RuleValue
          spec={spec}
          value={rule.value}
          onChange={(value) => onChange({ value })}
        />
        {range && (
          <>
            <span className="shrink-0 text-mini text-label-quaternary">and</span>
            <RuleValue
              spec={spec}
              endOfDay
              value={rule.value2 ?? rule.value}
              onChange={(value2) => onChange({ value2 })}
            />
          </>
        )}
      </div>

      <span className={cn('shrink-0', !onRemove && 'invisible')}>
        <IconButton size="sm" label="Remove rule" onClick={onRemove}>
          <CloseIcon size={11} />
        </IconButton>
      </span>
    </div>
  )
}

function RuleValue({
  spec,
  value,
  onChange,
  endOfDay,
}: {
  spec: FieldSpec
  value: string | number | boolean | undefined
  onChange: (v: string | number) => void
  /** The closing bound of a date range means the end of that day, not its start. */
  endOfDay?: boolean
}) {
  if (spec.kind === 'choice')
    return (
      <Select
        size="sm"
        value={String(value)}
        options={spec.choices!}
        onChange={onChange}
        className="min-w-0 flex-1"
      />
    )

  if (spec.kind === 'date')
    return (
      <input
        type="date"
        data-size="sm"
        value={toDateInput(Number(value))}
        onChange={(e) => onChange(fromDateInput(e.target.value, endOfDay))}
        className="esq-field min-w-0 flex-1 font-mono"
      />
    )

  if (spec.kind === 'number')
    return (
      <TextField
        size="sm"
        numeric
        value={String(value ?? '')}
        onChange={(v) => onChange(Number(v))}
        className="min-w-0 flex-1"
        aria-label="Value"
      />
    )

  return (
    <TextField
      size="sm"
      value={String(value ?? '')}
      onChange={onChange}
      placeholder="Type a word"
      className="min-w-0 flex-1"
      aria-label="Value"
    />
  )
}
