import { ResolvingImage } from '../../design/ResolvingImage'
import { healOrientation } from '../../catalog/aspect'
import { dynamicRangeStyle } from '../../core/hdr'
import { photoHdr, useUI } from '../../state/ui'
import { cn } from '../../lib/cn'
import type { Photo } from '../../core/types'

/**
 * A thumbnail that fills the box it is given.
 *
 * The grid and the filmstrip both shape their cells before a single pixel is
 * decoded — the catalog knows every photo's dimensions long before its
 * thumbnail is read — so the picture is never letterboxed into a frame that
 * disagrees with it. The plate underneath is the exact footprint the image
 * will take, which is what keeps a folder's rhythm of portraits, squares and
 * panoramas readable while it loads and unchanged once it lands.
 */
export function ThumbImage({
  photo,
  url,
  className,
  dim,
}: {
  photo: Photo
  url: string | null
  className?: string
  /** Rejected photos sit back without leaving the wall. */
  dim?: boolean
}) {
  const hdr = useUI(photoHdr(photo.id))
  return (
    <div
      className={cn('absolute inset-0 overflow-hidden bg-wash-subtle', className)}
      // The grid is where a wall of HDR frames would otherwise fight each
      // other for attention, so each tile answers for its own photo rather
      // than inheriting one verdict from the document.
      style={dynamicRangeStyle(hdr)}
    >
      <ResolvingImage
        src={url}
        alt={photo.filename}
        loading="lazy"
        className="size-full"
        // The cell was planned from the catalog row, so a row that describes
        // the file before its orientation was applied plans the wrong shape.
        // The thumbnail knows better, and the grid re-plans once it says so.
        onNatural={(size) => healOrientation(photo, size)}
        imageClassName={cn(
          'object-cover transition-opacity duration-[--duration-fast] ease-[--ease-out]',
          dim && 'opacity-35',
        )}
      />
    </div>
  )
}
