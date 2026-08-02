import { useMemo, useRef } from 'react'
import { cn } from '../../lib/cn'
import { BINS, useHistogram } from './useHistogram'

const W = 256
const H = 100

function pathFor(bins: Uint32Array, max: number): string {
  // A light 3-tap smoothing keeps posterised JPEG histograms from looking spiky.
  const v = (i: number) => {
    const a = bins[Math.max(0, i - 1)]
    const c = bins[Math.min(BINS - 1, i + 1)]
    return (a + bins[i] * 2 + c) / 4
  }
  let d = `M 0 ${H}`
  for (let i = 0; i < BINS; i++) {
    const x = (i / (BINS - 1)) * W
    // Slight gamma on the counts so quiet tails stay legible next to a spike.
    const y = H - Math.min(1, Math.pow(v(i) / max, 0.62)) * H
    d += ` L ${x.toFixed(2)} ${y.toFixed(2)}`
  }
  return `${d} L ${W} ${H} Z`
}

export function Histogram({
  url,
  hasPhoto,
  height = 84,
  showClipping = true,
  className,
}: {
  url: string | null
  /** Separates "nothing selected" from "selected, but no preview decoded yet". */
  hasPhoto: boolean
  height?: number
  showClipping?: boolean
  className?: string
}) {
  const data = useHistogram(url)
  const paths = useMemo(
    () =>
      data
        ? {
            r: pathFor(data.r, data.max),
            g: pathFor(data.g, data.max),
            b: pathFor(data.b, data.max),
            l: pathFor(data.l, data.max),
          }
        : null,
    [data],
  )
  const ref = useRef<SVGSVGElement>(null)

  return (
    <div className={cn('relative px-3 pt-1 pb-2', className)}>
      <div
        className="relative overflow-hidden rounded-md bg-black/45 shadow-[inset_0_0_0_0.5px_var(--color-hairline)]"
        style={{ height }}
      >
        {/* Quarter-tone guides, barely there. */}
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgb(255 255 255 / 0.055) 0.5px, transparent 0.5px)',
            backgroundSize: '25% 100%',
            backgroundPosition: '25% 0',
          }}
        />
        {paths ? (
          <svg
            ref={ref}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="absolute inset-0 size-full"
          >
            <g style={{ mixBlendMode: 'screen' }}>
              <path d={paths.l} fill="rgb(255 255 255 / 0.16)" />
              <path d={paths.r} fill="var(--color-hist-r)" opacity={0.62} />
              <path d={paths.g} fill="var(--color-hist-g)" opacity={0.62} />
              <path d={paths.b} fill="var(--color-hist-b)" opacity={0.62} />
            </g>
          </svg>
        ) : (
          <div className="absolute inset-0 grid place-items-center text-micro text-label-quaternary">
            {hasPhoto ? '' : 'No photo selected'}
          </div>
        )}

        {showClipping && data && (
          <>
            <ClipDot side="left" active={data.clipShadow > 0.0005} title="Shadow clipping" />
            <ClipDot side="right" active={data.clipHighlight > 0.0005} title="Highlight clipping" />
          </>
        )}
      </div>
    </div>
  )
}

function ClipDot({
  side,
  active,
  title,
}: {
  side: 'left' | 'right'
  active: boolean
  title: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'absolute top-1 size-1.5 rounded-full transition-colors duration-[--duration-base]',
        side === 'left' ? 'left-1.5' : 'right-1.5',
        active ? 'bg-white' : 'bg-white/12',
      )}
    />
  )
}
