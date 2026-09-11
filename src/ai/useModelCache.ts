import { useEffect, useState } from 'react'
import { modelCacheInfo, useModelDownloads } from './modelCache'
import type { SegmentModel } from './models'

export function useModelCache(model: SegmentModel) {
  const revision = useModelDownloads((s) => s.revision)
  const [info, setInfo] = useState<{ cached: boolean | null; bytes: number }>({ cached: null, bytes: 0 })
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const refresh = () => {
      setInfo({ cached: null, bytes: 0 })
      setError(null)
      void modelCacheInfo(model).then((value) => {
        if (live) setInfo(value)
      }).catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : 'Could not read model storage.')
      })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      live = false
      window.removeEventListener('focus', refresh)
    }
  }, [model, revision])
  return { ...info, error }
}
