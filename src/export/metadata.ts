/**
 * XMP for exported files.
 *
 * EXIF covers the camera; XMP covers everything the catalog adds on top —
 * title, caption, keywords, rating, creator and rights. Lightroom writes both,
 * and so does esque, because a keyword that survives an export is the whole
 * reason to have typed it.
 *
 * This packet deliberately carries no `crs:` develop settings: the pixels of a
 * JPEG or TIFF are already developed, and a reader that found Camera Raw
 * settings there would apply the look a second time. The DNG path is the
 * exception, and it uses the sidecar writer instead.
 */
import type { Photo } from '../core/types'
import { policyFlags } from './exif'
import type { ExportSettings } from './types'

const escapeXml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** Hierarchical keywords use Lightroom's `Parent|Child` separator. */
const isPersonKeyword = (keyword: string) => {
  const root = keyword.split('|')[0].trim().toLowerCase()
  return root === 'people' || root === 'person' || root === 'faces'
}

export const leafKeyword = (keyword: string) => {
  const parts = keyword.split('|')
  return parts[parts.length - 1].trim()
}

export function exportKeywords(photo: Photo, settings: ExportSettings): string[] {
  if (!settings.writeKeywords) return []
  const flags = policyFlags(settings.metadata)
  if (!flags.descriptive) return []
  return photo.keywords.filter((k) => !(settings.removePersonInfo && isPersonKeyword(k)))
}

const alt = (tag: string, value: string) =>
  `   <${tag}><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(value)}</rdf:li></rdf:Alt></${tag}>`

const bag = (tag: string, values: string[]) =>
  `   <${tag}><rdf:Bag>${values
    .map((v) => `<rdf:li>${escapeXml(v)}</rdf:li>`)
    .join('')}</rdf:Bag></${tag}>`

const seq = (tag: string, values: string[]) =>
  `   <${tag}><rdf:Seq>${values
    .map((v) => `<rdf:li>${escapeXml(v)}</rdf:li>`)
    .join('')}</rdf:Seq></${tag}>`

/**
 * Builds the XMP packet for a rendered export, or null when the metadata
 * policy leaves nothing worth writing.
 */
export function buildXmp(
  photo: Photo,
  settings: ExportSettings,
  software: string,
): string | null {
  const flags = policyFlags(settings.metadata)
  if (settings.metadata === 'none') return null

  const attrs = [`xmp:CreatorTool="${escapeXml(software)}"`]
  const elements: string[] = []

  if (flags.descriptive) {
    if (photo.title) elements.push(alt('dc:title', photo.title))
    if (photo.caption) elements.push(alt('dc:description', photo.caption))
    if (photo.rating) attrs.push(`xmp:Rating="${photo.rating}"`)
    if (photo.label && photo.label !== 'none') {
      attrs.push(`xmp:Label="${escapeXml(photo.label)}"`)
    }
  }

  if (flags.contact && photo.meta.artist) {
    elements.push(seq('dc:creator', [photo.meta.artist]))
  }
  if (flags.copyright && photo.meta.copyright) {
    elements.push(alt('dc:rights', photo.meta.copyright))
  }

  const keywords = exportKeywords(photo, settings)
  if (keywords.length) {
    elements.push(bag('dc:subject', keywords.map(leafKeyword)))
    if (keywords.some((k) => k.includes('|'))) {
      elements.push(bag('lr:hierarchicalSubject', keywords))
    }
  }

  if (!elements.length && attrs.length === 1) return null

  return `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="esque">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:lr="http://ns.adobe.com/lightroom/1.0/"
   ${attrs.join('\n   ')}>
${elements.join('\n')}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
}
