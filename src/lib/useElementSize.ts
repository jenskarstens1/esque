import { useEffect, useRef, useState, type RefObject } from 'react'

export interface Size {
  width: number
  height: number
}

/**
 * Tracks an element's content-box size via ResizeObserver.
 *
 * The effect deliberately has no dependency array. A ref object is stable, so
 * watching it would attach the observer exactly once — and a caller that
 * renders something else first (a list showing an empty state until its rows
 * arrive) has a null ref on that pass and would then be measured as 0×0 for
 * the rest of its life. Comparing the node instead re-attaches the moment the
 * element appears, or is swapped, and does nothing on every other render.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  const observed = useRef<HTMLElement | null>(null)
  const observer = useRef<ResizeObserver | null>(null)

  // No dependency array on purpose: the node comparison below is the guard, so
  // this settles after one pass instead of looping on its own state write.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = ref.current
    if (el === observed.current) return
    observed.current = el

    observer.current?.disconnect()
    observer.current = null
    if (!el) {
      setSize({ width: 0, height: 0 })
      return
    }

    const ro = new ResizeObserver(([entry]) => {
      const box = entry.contentBoxSize?.[0]
      setSize(
        box
          ? { width: box.inlineSize, height: box.blockSize }
          : { width: entry.contentRect.width, height: entry.contentRect.height },
      )
    })
    ro.observe(el)
    observer.current = ro
    setSize({ width: el.clientWidth, height: el.clientHeight })
  })

  useEffect(
    () => () => {
      observer.current?.disconnect()
      observer.current = null
      observed.current = null
    },
    [],
  )

  return size
}
