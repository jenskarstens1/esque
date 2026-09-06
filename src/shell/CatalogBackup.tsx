import { useEffect, useRef, useState } from 'react'
import { Button, TextField } from '../design/Controls'
import { Dialog } from '../design/Dialog'
import { Field } from '../design/Field'
import { useImporter } from '../state/importer'
import { useExport } from '../state/exportStore'
import { useDetect } from '../ai/detect'
import { useDevelop } from '../develop/session'
import { db } from '../catalog/db'
import {
  archiveBlob, archiveDetectionCount, archiveFilename, createCatalogArchive,
} from '../catalog/archive'
import { MERGE_TABLES, mergeCatalogArchive, type MergeResult } from '../catalog/merge'
import { MAX_ARCHIVE_BYTES, parseCatalogArchive, type CatalogArchive } from '../catalog/schema'
import {
  commitReconnection, inspectFileReconnection, inspectFolderReconnection, missingSources,
  type MissingSources, type Reconnection,
} from '../catalog/reconnect'
import { formatBytes } from '../lib/math'
import type { CatalogFolder, Photo } from '../core/types'

const LABELS = {
  photos: 'Photos (including copies)', folders: 'Folders', collections: 'Collections',
  presets: 'User Develop presets', snapshots: 'Snapshots',
}
const taskRunning = () => useImporter.getState().active || useExport.getState().running ||
  Object.values(useDetect.getState().status).some((status) => status.phase === 'downloading' || status.phase === 'running')

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : 'An unexpected local storage error occurred.'

async function pickOrCancel<T>(picker: () => Promise<T>): Promise<T | null> {
  try {
    return await picker()
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null
    throw error
  }
}

export function CatalogBackup({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const importing = useImporter((state) => state.active)
  const exporting = useExport((state) => state.running)
  const detecting = useDetect((state) => Object.values(state.status).some((status) =>
    status.phase === 'downloading' || status.phase === 'running'))
  const coverageRevision = useDetect((state) => state.revision)
  const [working, setWorking] = useState<string | null>(null)
  const workingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ name: string; archive: CatalogArchive } | null>(null)
  const [result, setResult] = useState<MergeResult | null>(null)
  const [sources, setSources] = useState<MissingSources | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [connection, setConnection] = useState<Reconnection | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const disabled = !!working || importing || exporting || detecting
  const sourceSupported = typeof window.showOpenFilePicker === 'function'
  const folderSupported = typeof window.showDirectoryPicker === 'function'

  useEffect(() => {
    let live = true
    void missingSources().then((next) => {
      if (live) setSources(next)
    }).catch((failure: unknown) => {
      if (live) setError(`Could not read the catalog. ${messageOf(failure)} Reopen Settings to try again.`)
    })
    return () => { live = false }
  }, [coverageRevision])

  const refreshSources = async () => {
    try {
      const next = await missingSources()
      setSources(next)
      return next
    } catch (failure) {
      setError(`Could not refresh the source list. ${messageOf(failure)} Reopen Settings to try again.`)
      return null
    }
  }

  const run = async (label: string, failureLabel: string, action: () => Promise<void>) => {
    if (workingRef.current) return
    if (taskRunning()) {
      setError('Wait for the current import, export or mask detection to finish, then try again.')
      return
    }
    workingRef.current = true
    setWorking(label)
    onBusyChange(true)
    setError(null)
    setNotice(null)
    try {
      await action()
    } catch (failure) {
      setError(`${failureLabel} ${messageOf(failure)}`)
    } finally {
      workingRef.current = false
      setWorking(null)
      onBusyChange(false)
    }
  }

  const save = () => void run('Saving catalog backup…', 'Backup was not saved.', async () => {
    // The picker must run before any awaited DB work so it retains the click's
    // user activation. No original-file or remembered export handle is used.
    const filename = archiveFilename()
    const nativePicker = typeof window.showSaveFilePicker === 'function'
    const handle = nativePicker
      ? await pickOrCancel(() => window.showSaveFilePicker({
        id: 'esque-catalog-backup', suggestedName: filename,
        types: [{ description: 'esque catalog backup', accept: { 'application/json': ['.esque.json'] } }],
      }))
      : null
    if (nativePicker && !handle) return
    if (handle && !handle.name.toLowerCase().endsWith('.json')) {
      throw new Error('Use a .json filename for the catalog backup. Original photo files cannot be backup destinations.')
    }
    if (taskRunning()) throw new Error('A background task started. Let it finish and save again.')
    const archive = await createCatalogArchive()
    const blob = archiveBlob(archive)
    if (handle) {
      const writer = await handle.createWritable()
      try {
        await writer.write(blob)
        await writer.close()
      } catch (failure) {
        await writer.abort().catch(() => {})
        throw failure
      }
    } else {
      download(blob, filename)
    }
    setNotice(`${handle ? 'Saved' : 'Download started for'} ${archive.photos.length.toLocaleString()} photo records and their catalog data (${formatBytes(blob.size)}). Keep your original photos separately.`)
  })

  const readBackup = (file: File) => void run('Checking catalog backup…', 'Backup could not be opened. No records were restored.', async () => {
    setResult(null)
    if (file.size > MAX_ARCHIVE_BYTES) throw new Error('Choose a catalog JSON file no larger than 64 MB. Original photos are not part of this file.')
    const archive = parseCatalogArchive(await file.text())
    setPreview({ name: file.name, archive })
  })

  const restore = () => {
    if (!preview) return
    void run('Merging catalog records…', 'Restore failed; no backup records were added.', async () => {
      const restored = await mergeCatalogArchive(preview.archive)
      setResult(restored)
      setPreview(null)
      setNotice(null)
      const missing = await refreshSources()
      // New snapshots may belong to the open photo. Refresh that list without
      // loading a photo or replacing its working edits/history/selection.
      const photoId = useDevelop.getState().photoId
      if (photoId) {
        try {
          const snapshots = await db.snapshots.where('photoId').equals(photoId).toArray()
          if (useDevelop.getState().photoId === photoId) {
            useDevelop.setState({ snapshots: snapshots.sort((a, b) => b.createdAt - a.createdAt) })
          }
        } catch {
          setError('Restore completed. Reopen the photo to refresh its snapshot list.')
        }
      }
      if (restored.addedPhotoIds.length && missing?.originals.length) {
        setConnection(null)
        setReconnecting(true)
      }
    })
  }

  const chooseFolder = (folder: CatalogFolder) => void run('Checking original paths…', 'Folder was not connected.', async () => {
    const handle = await pickOrCancel(() => window.showDirectoryPicker({ id: 'esque-reconnect-originals', mode: 'read' }))
    if (handle) setConnection(await inspectFolderReconnection(folder.id, handle))
  })

  const chooseFile = (photo: Photo) => void run('Checking original file…', 'Original was not connected.', async () => {
    const handles = await pickOrCancel(() => window.showOpenFilePicker({ id: 'esque-reconnect-original', multiple: false }))
    if (handles?.[0]) setConnection(await inspectFileReconnection(photo.id, handles[0]))
  })

  const connect = () => {
    if (!connection) return
    void run('Connecting originals…', 'Originals were not connected.', async () => {
      await useDevelop.getState().flush()
      if (taskRunning()) throw new Error('A background task started. Let it finish and connect again.')
      const connected = await commitReconnection(connection)
      setConnection(null)
      setNotice(`Connected ${connected.originals.toLocaleString()} original${connected.originals === 1 ? '' : 's'} and ${connected.virtualCopies.toLocaleString()} virtual copies. Edits are unchanged. Reopen the photo in Develop if it was already on screen.`)
      await refreshSources()
    })
  }

  const canConnect = connection && (connection.kind === 'file' ||
    connection.entries.every((entry) => entry.status === 'matches'))
  const maskRecovery = sources && sources.detectedMasks > 0 ? (
    <p role="status" className="my-3 text-ui leading-relaxed text-label-secondary">
      <strong className="font-medium text-label">{sources.detectedMasks.toLocaleString()} detected-mask
        {' '}components have no loaded coverage.</strong>{' '}
      Open the reconnected photo in Develop: available referenced coverage loads automatically,
      without model downloads. For coverage still missing, select the component in Masking and use
      Detect (or Detect People) with its recorded model tier. Portable backups omit coverage and
      cache references. Until coverage is available, the look is incomplete. Re-detection can vary.
    </p>
  ) : null
  const status = (
    <>
      {working && <p role="status" className="my-2 text-ui text-label-secondary">{working}</p>}
      {error && <p role="alert" className="my-2 break-words text-ui text-red">{error}</p>}
      {notice && <p role="status" className="my-2 break-words text-ui text-label-secondary">{notice}</p>}
    </>
  )

  return (
    <section aria-labelledby="catalog-backup-heading" className="mt-4 border-t border-hairline pt-4 pb-1">
      <h3 id="catalog-backup-heading" className="mb-2 text-ui font-medium text-label">Catalog backup</h3>
      <p className="mb-3 text-ui leading-relaxed text-label-secondary">
        Keep your edits, metadata, virtual copies, collections, snapshots and user Develop presets.
        Original photos stay separate. Nothing is uploaded.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled} onClick={save}>Save backup…</Button>
        <Button disabled={disabled} onClick={() => input.current?.click()}>Restore backup…</Button>
      </div>
      <input
        ref={input}
        type="file"
        accept=".json,.esque.json,application/json"
        className="hidden"
        aria-label="Choose an esque catalog backup"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) readBackup(file)
        }}
      />
      <p className="mt-2 text-mini leading-relaxed text-label-secondary">
        Restore only merges: existing photos, edits and conflicting records are never overwritten.
        XMP sidecars are not a full catalog backup.
      </p>
      {!reconnecting && maskRecovery}
      <details className="mt-2 text-mini text-label-secondary">
        <summary className="cursor-pointer py-1 text-label focus-visible:outline-accent">Coverage and limits</summary>
        <p className="mt-1 leading-relaxed">
          Includes ratings, flags, labels, keywords, camera metadata, complete saved edit settings
          (including drawn masks and retouching), stacks and collection set IDs.
          Not included: originals, filesystem permissions, previews, AI coverage pixels/model downloads,
          session-only undo history, interface preferences or export presets.
          Develop automatically loads available referenced coverage. For restored components with
          no coverage reference, use Detect in Develop → Masking after reconnecting originals.
          Restored snapshots and presets with detected masks need the same recovery when applied.
          Sky/Object detections are rejected because this build cannot regenerate their coverage.
          Presets built into esque are already supplied by the app. JSON backups are limited to 64 MB
          and 100,000 records per table.
        </p>
      </details>
      {(importing || exporting || detecting) && (
        <p role="status" className="mt-2 text-ui text-label-secondary">Finish the current import, export or mask detection before backing up or restoring.</p>
      )}
      {!reconnecting && !preview && status}
      {result && <RestoreReport result={result} />}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          disabled={disabled}
          onClick={() => {
            setReconnecting(true)
            setConnection(null)
            setError(null)
            void refreshSources()
          }}
        >
          Reconnect originals…
        </Button>
        {sources && (
          <span className="text-mini tabular-nums text-label-secondary">
            {sources.originals.length.toLocaleString()} without a connection
          </span>
        )}
      </div>

      <Dialog
        open={!!preview}
        onClose={() => { if (!working) setPreview(null) }}
        dismissable={!working}
        title="Restore catalog backup"
        width={520}
        footer={<>
          <Button disabled={!!working} onClick={() => setPreview(null)}>Cancel</Button>
          <Button variant="primary" disabled={disabled} onClick={restore}>Merge into catalog</Button>
        </>}
      >
        {preview && <>
          <p className="break-words text-ui text-label">{preview.name}</p>
          <p className="mt-1 text-mini text-label-secondary">
            Version {preview.archive.version} · {new Date(preview.archive.createdAt).toLocaleString()}
          </p>
          <dl className="my-4 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-ui tabular-nums">
            {MERGE_TABLES.map((table) => <Row key={table} label={LABELS[table]} count={preview.archive[table].length} />)}
            <Row label="Collection set IDs" count={preview.archive.collectionSetIds.length} />
          </dl>
          <p className="text-ui leading-relaxed text-label-secondary">
            Existing records always win. Conflicts are skipped and reported; collections with
            unresolved members are skipped whole. No photos, edits or source connections are replaced.
            Restore the original photo files separately, then reconnect them here.
          </p>
          {!!archiveDetectionCount(preview.archive) && (
            <p className="mt-2 text-ui text-label-secondary">
              {archiveDetectionCount(preview.archive).toLocaleString()} detected-mask settings need coverage recovery after reconnection.
              {' '}Their coverage pixels are not included: the restored look will be incomplete until
              coverage is available. Existing referenced coverage loads automatically in Develop,
              but this portable file omits those cache references. Use Detect in Develop → Masking
              for restored components still missing coverage, keeping the recorded model tier.
              Re-detection can vary. Restored snapshots and presets need the same step when applied.
            </p>
          )}
          {status}
        </>}
      </Dialog>

      <Dialog
        open={reconnecting}
        title="Reconnect originals"
        width={580}
        onClose={() => { if (!working) setReconnecting(false) }}
        dismissable={!working}
        footer={connection ? <>
          <Button disabled={!!working} onClick={() => { setConnection(null); setError(null) }}>Back</Button>
          <Button variant="primary" disabled={disabled || !canConnect} onClick={connect}>
            {connection.kind === 'folder' ? 'Connect this folder' : 'Connect this original'}
          </Button>
        </> : <Button variant="primary" disabled={!!working} onClick={() => setReconnecting(false)}>Done</Button>}
      >
        {connection ? <ConnectionReview connection={connection} /> : <>
          {result && <p role="status" className="mb-3 text-ui tabular-nums text-label">
            Catalog records: {MERGE_TABLES.reduce((sum, table) => sum + result.counts[table].added, 0).toLocaleString()} added,{' '}
            {MERGE_TABLES.reduce((sum, table) => sum + result.counts[table].skipped, 0).toLocaleString()} skipped
            {' '}({result.conflicts.length.toLocaleString()} conflicts). Existing edits were kept.
          </p>}
          <p className="mb-3 text-ui leading-relaxed text-label-secondary">
            Choose the original folder root, or select one original file. We check exact relative paths,
            filenames, byte sizes and modification dates, then ask you to confirm.
            We never search by basename or replace an existing connection.
          </p>
          {!sourceSupported && <p role="alert" className="mb-3 text-ui text-label-secondary">
            Use Chrome or Edge to reconnect originals. This browser cannot keep file access handles.
          </p>}
          {sources ? sources.originals.length ? (
            <SourceBrowser
              sources={sources}
              disabled={disabled}
              fileSupported={sourceSupported}
              folderSupported={folderSupported}
              onFolder={chooseFolder}
              onFile={chooseFile}
            />
          ) : <p className="text-ui text-label">No originals are missing a source connection.</p>
            : <p role={error ? undefined : 'status'} className="text-ui text-label-secondary">
              {error ? 'The source list is unavailable. Reopen this guide to retry.' : 'Reading source connections…'}
            </p>}
          <p className="mt-3 text-mini leading-relaxed text-label-secondary">
            Keep the backed-up originals unchanged. A partial folder cannot be connected as a whole;
            reconnect available files individually instead. Existing connections that need renewed
            permission are handled by Reconnect in the Library folder menu.
          </p>
        </>}
        {maskRecovery}
        {status}
      </Dialog>
    </section>
  )
}

function Row({ label, count }: { label: string; count: number }) {
  return <><dt className="text-label-secondary">{label}</dt><dd className="text-right text-label">{count.toLocaleString()}</dd></>
}

function RestoreReport({ result }: { result: MergeResult }) {
  const added = MERGE_TABLES.reduce((sum, table) => sum + result.counts[table].added, 0)
  return (
    <section aria-label="Restore result" className="mt-4">
      <p role="status" className="text-ui font-medium text-label">
        {added ? 'Catalog merge complete' : 'No catalog records added'}
      </p>
      <table className="mt-2 w-full text-mini tabular-nums">
        <thead><tr className="text-label-secondary">
          <th scope="col" className="pb-1 text-left font-normal">Records</th>
          <th scope="col" className="px-2 pb-1 text-right font-normal">Added</th>
          <th scope="col" className="pb-1 text-right font-normal">Skipped</th>
        </tr></thead>
        <tbody>{MERGE_TABLES.map((table) => <tr key={table}>
          <th scope="row" className="py-0.5 text-left font-normal text-label-secondary">{LABELS[table]}</th>
          <td className="px-2 text-right text-label">{result.counts[table].added.toLocaleString()}</td>
          <td className="text-right text-label">{result.counts[table].skipped.toLocaleString()}</td>
        </tr>)}</tbody>
      </table>
      <p className="mt-1 text-mini text-label-secondary">
        {result.virtualCopiesAdded.toLocaleString()} virtual copies and {result.collectionSetsAdded.toLocaleString()} collection set IDs added.
        Skipped includes {result.conflicts.length.toLocaleString()} conflicts; existing records were kept.
      </p>
      {!!result.conflicts.length && <details className="mt-2 text-mini text-label-secondary">
        <summary className="cursor-pointer py-1 text-label focus-visible:outline-accent">Review skipped conflicts</summary>
        <ul className="my-2 space-y-2">
          {result.conflicts.slice(0, 20).map((conflict) => <li key={`${conflict.table}:${conflict.id}`} className="break-words">
            <span className="font-medium text-label">{conflict.name}</span> · {conflict.reason}
          </li>)}
        </ul>
        {result.conflicts.length > 20 && <p>Showing 20 of {result.conflicts.length.toLocaleString()} conflicts. Save the report for all entries.</p>}
        <Button size="sm" onClick={() => download(
          new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }),
          'esque-catalog-merge-report.json',
        )}>Save full merge report</Button>
      </details>}
    </section>
  )
}

function SourceBrowser({
  sources, disabled, fileSupported, folderSupported, onFolder, onFile,
}: {
  sources: MissingSources
  disabled: boolean
  fileSupported: boolean
  folderSupported: boolean
  onFolder: (folder: CatalogFolder) => void
  onFile: (photo: Photo) => void
}) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const query = search.trim().toLowerCase()
  const folders = sources.folders.filter(({ folder }) => folder.name.toLowerCase().includes(query))
  const originals = sources.originals.filter((photo) =>
    `${sources.folderNames.get(photo.folderId) ?? ''} ${photo.filename} ${photo.relPath}`.toLowerCase().includes(query))
  const rows = [
    ...folders.map((group) => ({
      key: `folder:${group.folder.id}`, title: group.folder.name,
      detail: `Folder · ${group.originals.length.toLocaleString()} unconnected originals`,
      button: 'Choose folder…', supported: folderSupported, act: () => onFolder(group.folder),
    })),
    ...originals.map((photo) => ({
      key: photo.id, title: `${sources.folderNames.get(photo.folderId) ?? 'Missing folder'} / ${photo.relPath}`,
      detail: `${formatBytes(photo.fileSize)} · ${new Date(photo.modifiedAt).toLocaleString()}`,
      button: 'Choose original…', supported: fileSupported, act: () => onFile(photo),
    })),
  ]
  const pages = Math.max(1, Math.ceil(rows.length / 20))
  const current = Math.min(page, pages - 1)
  return <>
    <Field label="Find a source">
      <TextField value={search} disabled={disabled} onChange={(value) => { setSearch(value); setPage(0) }} aria-label="Find a missing source" className="min-w-0 flex-1" />
    </Field>
    <ul className="mt-2 divide-y divide-hairline">
      {rows.slice(current * 20, (current + 1) * 20).map((row) => <li key={row.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
        <div className="min-w-0 flex-1 basis-[180px]">
          <p className="break-words text-ui text-label">{row.title}</p>
          <p className="text-mini text-label-secondary">{row.detail}</p>
        </div>
        <Button size="sm" disabled={disabled || !row.supported} onClick={row.act}>{row.button}</Button>
      </li>)}
    </ul>
    {!rows.length && <p role="status" className="py-3 text-ui text-label-secondary">No missing sources match this search.</p>}
    {pages > 1 && <div className="mt-2 flex items-center justify-between gap-2">
      <Button size="sm" disabled={disabled || current === 0} onClick={() => setPage(current - 1)}>Previous</Button>
      <span className="text-mini tabular-nums text-label-secondary">{current + 1} / {pages}</span>
      <Button size="sm" disabled={disabled || current === pages - 1} onClick={() => setPage(current + 1)}>Next</Button>
    </div>}
  </>
}

function ConnectionReview({ connection }: { connection: Reconnection }) {
  if (connection.kind === 'file') return <>
    <p className="break-words text-ui font-medium text-label">{connection.photo.filename}</p>
    <p className="mt-2 text-ui leading-relaxed text-label-secondary">
      The selected file has the same filename, byte size and modification date.
      Confirm that it is the original you backed up; these checks are not a content hash.
      This connects one original and its {connection.copies.toLocaleString()} virtual copies without changing any edits.
    </p>
    <p className="mt-2 text-mini text-label-secondary">
      Individually connected files can be edited and exported. Writing neighbouring XMP sidecars
      still needs a connected folder root.
    </p>
  </>
  const matched = connection.entries.filter((entry) => entry.status === 'matches').length
  const failures = connection.entries.filter((entry) => entry.status !== 'matches')
  return <>
    <p className="break-words text-ui font-medium text-label">{connection.folder.name} → {connection.handle.name}</p>
    <p className="mt-2 text-ui tabular-nums text-label-secondary">
      {matched.toLocaleString()} / {connection.entries.length.toLocaleString()} exact relative paths, filenames, sizes and dates match.
    </p>
    {failures.length ? <>
      <p role="alert" className="mt-2 text-ui text-label-secondary">
        Nothing is connected yet. Go back and choose the correct root folder, or reconnect available
        originals individually. Different or missing files are never accepted silently.
      </p>
      <ul className="mt-3 space-y-2 text-mini">
        {failures.slice(0, 20).map((entry) => <li key={entry.photo.id} className="break-words text-label-secondary">
          <span className="text-label">{entry.photo.relPath}</span> · {entry.detail}
        </li>)}
      </ul>
      {failures.length > 20 && <p className="mt-2 text-mini text-label-secondary">Showing the first 20 of {failures.length.toLocaleString()} unmatched paths.</p>}
    </> : <p className="mt-2 text-ui leading-relaxed text-label-secondary">
      Confirm this is the folder you backed up. These checks are not a content hash.
      Only its missing source connection is added; existing handles and edits are kept.
    </p>}
  </>
}
