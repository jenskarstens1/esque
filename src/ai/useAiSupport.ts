import { useEffect, useState } from 'react'
import { aiSupport, aiSupportNow, type AiSupport } from './models'

/**
 * Whether this browser can run detection, resolved once per session.
 *
 * The probe asks the platform for a real GPU adapter, so it is asynchronous and
 * the first render has to cope with not knowing yet. `null` means exactly that
 * — undecided — and the UI treats it as neither supported nor refused: controls
 * stay disabled but say nothing discouraging, because claiming a browser cannot
 * do something and then discovering it can is the worse of the two mistakes.
 */
export function useAiSupport(): AiSupport | null {
  const [support, setSupport] = useState<AiSupport | null>(aiSupportNow)

  useEffect(() => {
    if (support) return
    let live = true
    void aiSupport().then((s) => {
      if (live) setSupport(s)
    })
    return () => {
      live = false
    }
  }, [support])

  return support
}
