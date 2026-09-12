export type StorageProtection = 'persistent' | 'best-effort' | 'unsupported'

export async function storageProtection(): Promise<StorageProtection> {
  if (typeof navigator.storage?.persisted !== 'function') return 'unsupported'
  return await navigator.storage.persisted() ? 'persistent' : 'best-effort'
}

let pending: Promise<StorageProtection> | null = null

/** The browser decides; a denied request never means the cache is ephemeral. */
export function requestStorageProtection(): Promise<StorageProtection> {
  pending ??= (async () => {
    const current = await storageProtection()
    if (current !== 'best-effort') return current
    if (typeof navigator.storage.persist !== 'function') return 'unsupported'
    return await navigator.storage.persist() ? 'persistent' : 'best-effort'
  })().finally(() => { pending = null })
  return pending
}
