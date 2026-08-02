import { useEffect, useState, type CSSProperties, type Ref } from 'react'
import { cn } from '../lib/cn'

/**
 * How long a tier is held underneath the sharper one that replaced it.
 *
 * `--duration-base` plus a frame of grace: a cross-fade whose two halves
 * disagree by even one frame shows the surround through the seam, which on a
 * photo reads as a flicker to black. Exported so anything dissolving *into* a
 * resolving photo — the Develop canvas — holds its own stand-in for the same
 * length rather than guessing at a second number.
 */
export const RESOLVE_MS = 260

interface Tier {
  key: number
  src: string
  /** Set once the browser has the pixels, which is when the layer may rise. */
  loaded: boolean
  /**
   * Whether this tier arrived after the element existed, and so has a rise to
   * perform. The first tier of a cache hit is simply already there.
   */
  animate: boolean
  /** Captured when the tier is queued; see the `softness` prop. */
  softness: number
}

let nextKey = 1

/**
 * A photo that resolves rather than appears.
 *
 * esque loads every photo in tiers — the grid thumbnail, then the standard
 * preview, then a render made for the size actually on screen. Pointing one
 * image element at each in turn tears the decoded frame down before the next
 * one exists, so the picture blinks out at the moment it is getting better.
 *
 * Instead each tier is its own layer, and a layer only rises once its pixels
 * have landed. The tier underneath holds at full strength until the one above
 * is opaque, so there is never a frame with nothing in it: the photo only ever
 * sharpens.
 *
 * A `src` that is already there on the first render came out of the session's
 * URL cache, so its pixels are decoded and on hand. Those mount opaque — a
 * cache hit should feel instant, not politely animated.
 */
export function ResolvingImage({
  src,
  alt,
  ref,
  className,
  style,
  imageClassName,
  softness = 0,
  loading,
  onNatural,
}: {
  src: string | null
  alt: string
  /** Onto the stack, for callers that transform it per frame. */
  ref?: Ref<HTMLDivElement>
  /** The stack. Sized by the caller; every layer fills it. */
  className?: string
  style?: CSSProperties
  /** Every pixel layer — object fit, interpolation, tint. */
  imageClassName?: string
  /**
   * Blur for the tier queued while this is set, in CSS pixels. A stand-in
   * render blown well past its own detail is mostly compression artefacts;
   * softening it says "not final" and lets the sharp tier arrive as a focus
   * pull. Held with its tier, so the replacement always comes in clean.
   */
  softness?: number
  loading?: 'eager' | 'lazy'
  /**
   * The pixel size of a tier as it lands. Every tier is the same photograph, so
   * even the thumbnail already carries its true shape — which is how a caller
   * can lay out a frame the picture actually fits instead of trusting a catalog
   * row that may describe the file before its orientation was applied.
   */
  onNatural?: (size: { width: number; height: number }) => void
}) {
  const [tiers, setTiers] = useState<Tier[]>(() =>
    src ? [{ key: 0, src, loaded: true, animate: false, softness }] : [],
  )

  useEffect(() => {
    setTiers((current) => {
      if (current[current.length - 1]?.src === src) return current
      if (!src) return current.length ? [] : current
      return [...current, { key: nextKey++, src, loaded: false, animate: true, softness }]
    })
    // `softness` describes the tier being queued and is captured with it, so a
    // later change must not re-run this and duplicate the layer.
  }, [src]) // eslint-disable-line react-hooks/exhaustive-deps

  // Once a tier is fully up, everything under it is only costing image memory.
  useEffect(() => {
    if (tiers.findLastIndex((t) => t.loaded) <= 0) return
    const timer = setTimeout(
      () =>
        setTiers((current) => {
          const top = current.findLastIndex((t) => t.loaded)
          return top > 0 ? current.slice(top) : current
        }),
      RESOLVE_MS,
    )
    return () => clearTimeout(timer)
  }, [tiers])
  const top = tiers.length - 1

  return (
    <div
      ref={ref}
      className={className}
      // Positioned inline rather than through a class so it cannot lose a
      // specificity coin-toss with a caller's own `absolute`; a caller that
      // needs the stack placed elsewhere overrides `position` through `style`.
      style={{ position: 'relative', ...style }}
    >
      {tiers.map((tier, i) => (
        <img
          key={tier.key}
          src={tier.src}
          // Only the layer in front is the photo; the ones behind it are the
          // same picture, less of it, on their way out.
          alt={i === top ? alt : ''}
          aria-hidden={i === top ? undefined : true}
          draggable={false}
          decoding="async"
          loading={loading}
          onLoad={(e) => {
            onNatural?.({
              width: e.currentTarget.naturalWidth,
              height: e.currentTarget.naturalHeight,
            })
            setTiers((current) =>
              current.map((t) => (t.key === tier.key && !t.loaded ? { ...t, loaded: true } : t)),
            )
          }}
          // A tier that cannot decode must not sit at zero opacity holding the
          // stack open; drop it and let the one underneath stay the photo.
          onError={() => setTiers((current) => current.filter((t) => t.key !== tier.key))}
          className={cn(
            'absolute inset-0 size-full',
            // A keyframe rather than a transition, and deliberately: a blob URL
            // can decode inside the same frame it was attached in, and a
            // transition with no painted start value is simply skipped. The
            // rise has to be guaranteed, because it is the only thing standing
            // between the two tiers.
            tier.loaded &&
              tier.animate &&
              'animate-[esq-resolve-in_var(--duration-base)_var(--ease-out)_both]',
            imageClassName,
          )}
          style={{
            opacity: tier.loaded ? 1 : 0,
            filter: tier.softness > 0 ? `blur(${tier.softness}px)` : undefined,
          }}
        />
      ))}
    </div>
  )
}
