/**
 * Guards the one label vocabulary a panel or dialog body is allowed to use.
 *
 * Tracked-caps eyebrows belong to panel titles, menu group headers and the
 * readout tags on graphs — places where the text is a heading. Inside a body,
 * a caption that names a control or a group of them reads as a heading for
 * everything below it, which is exactly the confusion this check exists to
 * stop. Use `FieldLabel`, `SelectField` or `ControlField` instead.
 *
 * Only non-interactive elements are flagged: a button whose whole body is a
 * tracked-caps word is a tag, not a caption. Where an eyebrow is genuinely
 * right, put `label-ok` in a comment on the line above.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src/modules', 'src/shell', 'src/design']
const CAPTION = /<(div|span|p|h[1-6])\b[^>]*className=(?:"([^"]*)"|\{[^}]*?'([^']*)')/gs

function files(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...files(path))
    else if (entry.name.endsWith('.tsx')) out.push(path)
  }
  return out
}

const failures = []
for (const root of ROOTS) {
  for (const file of files(root)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(CAPTION)) {
      const classes = match[2] ?? match[3] ?? ''
      if (!classes.includes('uppercase') || !classes.includes('text-micro')) continue
      const before = source.slice(0, match.index)
      const line = before.split('\n').length
      const previous = before.split('\n').slice(-3).join('\n')
      if (previous.includes('label-ok')) continue
      failures.push(
        `${file}:${line} tracked-caps eyebrow on a <${match[1]}>. ` +
          'Use FieldLabel / SelectField / ControlField for a caption inside a body.',
      )
    }
  }
}

if (failures.length) {
  console.error(`labelcheck: ${failures.length} problem(s)\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('labelcheck: ok')
