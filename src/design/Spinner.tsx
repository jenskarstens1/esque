/**
 * The system-style indeterminate spinner: twelve tapering spokes fading in
 * sequence. Rendered with CSS so it costs nothing and never drops a frame.
 */
export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  const spokes = Array.from({ length: 12 }, (_, i) => i)
  return (
    <span
      className={className}
      role="progressbar"
      aria-label="Working"
      style={{
        width: size,
        height: size,
        display: 'inline-block',
        position: 'relative',
        flex: 'none',
      }}
    >
      {spokes.map((i) => (
        <span
          key={i}
          style={{
            position: 'absolute',
            inset: 0,
            transform: `rotate(${i * 30}deg)`,
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 0,
              left: '50%',
              width: Math.max(1, size * 0.09),
              height: size * 0.28,
              marginLeft: -Math.max(1, size * 0.09) / 2,
              borderRadius: 999,
              background: 'currentColor',
              opacity: 0.16,
              animation: `esq-spoke 1s linear ${(i / 12).toFixed(3)}s infinite`,
            }}
          />
        </span>
      ))}
    </span>
  )
}
