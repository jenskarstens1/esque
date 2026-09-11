import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

export interface Size {
  width: number
  height: number
}

/**
 * Tracks an element's content-box size via ResizeObserver.
 *
 * Measured in a *layout* effect, which is the difference between a module that
 * opens and one that flashes. Everything that sizes itself from here fits a
 * photograph to the frame, and an unmeasured frame has no fit: the fallback is
 * a scale of 1, which lays the photo out at its own pixel dimensions. Measured
 * after paint, a freshly mounted Library loupe or Develop canvas therefore
 * showed one frame of the photograph at full size — a sudden, enormous crop of
 * it — before the real size arrived and it snapped back to fit. Measuring
 * before the browser draws means the first frame anyone sees is the right one.
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
  useLayoutEffect(() => {
    const el = ref.current
    if (el === observed.current) return
    observed.current = el

    // A size that hasn't changed must not re-render: the ResizeObserver
    // announces itself once on observe, with the number the measurement below
    // already read.
    const apply = (next: Size) =>
      setSize((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      )

    observer.current?.disconnect()
    observer.current = null
    if (!el) {
      apply({ width: 0, height: 0 })
      return
    }

    const ro = new ResizeObserver(([entry]) => {
      const box = entry.contentBoxSize?.[0]
      apply(
        box
          ? { width: box.inlineSize, height: box.blockSize }
          : { width: entry.contentRect.width, height: entry.contentRect.height },
      )
    })
    ro.observe(el)
    observer.current = ro
    apply({ width: el.clientWidth, height: el.clientHeight })
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
