import { useEffect } from 'react'
import { Viewport } from './Viewport'
import { useCatalog } from '../../state/catalog'
import { useDevelop } from '../../develop/session'
import { usePhoto, usePhotos } from '../../catalog/hooks'
import { loadProxy, peekProxy } from '../../develop/proxy'

export function DevelopModule() {
  const primaryId = useCatalog((s) => s.primaryId)
  const photo = usePhoto(primaryId)
  const load = useDevelop((s) => s.load)
  const photos = usePhotos()

  useEffect(() => {
    void load(photo ?? null)
  }, [photo, load])

  // Warm one neighbour at a time after the selected photo is ready. The working
  // RAW tier is now bounded and persisted, so this turns forward/back navigation
  // into a cache hit without competing with the photo still being developed.
  useEffect(() => {
    if (!primaryId || !photos.length) return
    const i = photos.findIndex((p) => p.id === primaryId)
    if (i === -1) return
    const controllers: AbortController[] = []
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const warm = async () => {
      // A neighbour must never compete with the photo the viewport is still
      // decoding. Check the shared cache rather than guessing at a delay.
      if (!peekProxy(primaryId)) {
        timer = setTimeout(() => void warm(), 300)
        return
      }
      for (const offset of [1, -1]) {
        if (cancelled) break
        const next = photos[i + offset]
        if (next) {
          const controller = new AbortController()
          controllers.push(controller)
          await loadProxy(next.id, undefined, controller.signal).catch(() => null)
        }
      }
    }
    timer = setTimeout(() => void warm(), 700)
    return () => {
      cancelled = true
      clearTimeout(timer)
      controllers.forEach((controller) => controller.abort())
    }
  }, [primaryId, photos])

  return <Viewport photo={photo ?? null} />
}
