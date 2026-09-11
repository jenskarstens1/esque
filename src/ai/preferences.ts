import { create } from 'zustand'
import type { SegmentModel } from './models'

/** Consent is for this artifact, not future replacements with the same name. */
export const consentKey = (model: SegmentModel) =>
  `${model.local}|${model.remote}|${model.bytes}|${model.sha256}`

interface AiPreferences {
  downloads: Record<string, string>
  error: string | null
}

const STORAGE_KEY = 'esque.ai'

function readPreferences(): AiPreferences {
  if (typeof localStorage === 'undefined') return { downloads: {}, error: null }
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (!saved || typeof saved !== 'object' || !('downloads' in saved) ||
        !saved.downloads || typeof saved.downloads !== 'object') return { downloads: {}, error: null }
    return {
      downloads: Object.fromEntries(
        Object.entries(saved.downloads).filter((entry): entry is [string, string] =>
          typeof entry[1] === 'string'),
      ),
      error: null,
    }
  } catch (cause) {
    return {
      downloads: {},
      error: `AI download permissions could not be read; downloads are blocked. ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
}

export const useAiPreferences = create<AiPreferences>(readPreferences)

export function modelDownloadAllowed(model: SegmentModel): boolean {
  return useAiPreferences.getState().downloads[model.id] === consentKey(model)
}

export function setModelConsent(model: SegmentModel, allowed: boolean): void {
  const downloads = { ...useAiPreferences.getState().downloads }
  if (allowed) downloads[model.id] = consentKey(model)
  else delete downloads[model.id]
  // Revocation takes effect even if storage fails; approval must persist first.
  if (!allowed) useAiPreferences.setState({ downloads })
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ downloads }))
  useAiPreferences.setState({ downloads, error: null })
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      useAiPreferences.setState(readPreferences())
    }
  })
}
