/**
 * Search metadata, crawler-readable HTML and editor startup on a production build.
 *
 * npm run build && npm run preview -- --host 127.0.0.1 --port 4173
 * node tools/seocheck.mjs [origin] [canonical]
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBrowser } from './lib/playwright.mjs'
import { dismissWelcome } from './lib/welcome.mjs'

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:4173/')
const canonical = new URL(process.argv[3] ?? 'https://esque.dev/').href
const screenshots = process.env.ESQUE_SEO_SCREENSHOTS
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]
if (screenshots) await mkdir(screenshots, { recursive: true })

async function get(path, contentType) {
  const response = await fetch(new URL(path, origin))
  assert.equal(response.status, 200, `${path} must return 200`)
  assert.ok(response.headers.get('content-type')?.includes(contentType), `${path} content type`)
  return response
}

const html = await get('/', 'text/html')
assert.equal(html.headers.get('cross-origin-opener-policy'), 'same-origin')
assert.equal(html.headers.get('cross-origin-embedder-policy'), 'require-corp')
const robots = await (await get('/robots.txt', 'text/plain')).text()
assert.match(robots, /^User-agent: \*$/m)
assert.match(robots, /^Allow: \/$/m)
assert.doesNotMatch(robots, /^Disallow: \/(?:\*|assets\/)?$/m)
assert.ok(robots.includes(`Sitemap: ${new URL('sitemap.xml', canonical).href}`))
const sitemap = await (await get('/sitemap.xml', 'xml')).text()

const browser = await launchBrowser('chromium')
try {
  const crawler = await browser.newContext({ javaScriptEnabled: false })
  const page = await crawler.newPage()
  await page.goto(origin.href, { waitUntil: 'networkidle' })

  const metadata = await page.evaluate(() => {
    const one = (selector, attribute) => {
      const elements = document.querySelectorAll(selector)
      if (elements.length !== 1) throw new Error(`Expected one ${selector}, got ${elements.length}`)
      return attribute ? elements[0].getAttribute(attribute) : elements[0].textContent
    }
    const meta = (name) => one(`meta[name="${name}"], meta[property="${name}"]`, 'content')
    return {
      lang: document.documentElement.lang,
      title: one('title'),
      description: meta('description'),
      canonical: one('link[rel="canonical"]', 'href'),
      robots: meta('robots'),
      og: Object.fromEntries(
        ['type', 'site_name', 'title', 'description', 'url', 'image', 'image:type',
          'image:width', 'image:height', 'image:alt'].map((key) => [key, meta(`og:${key}`)]),
      ),
      twitter: Object.fromEntries(
        ['card', 'title', 'description', 'image', 'image:alt'].map((key) => [key, meta(`twitter:${key}`)]),
      ),
      schema: JSON.parse(one('script[type="application/ld+json"]')),
    }
  })
  assert.equal(metadata.lang, 'en')
  assert.match(metadata.title, /esque.*Photo Editor/i)
  assert.ok(metadata.title.length <= 65)
  assert.match(metadata.description, /Lightroom alternative/)
  assert.ok(metadata.description.length >= 80 && metadata.description.length <= 160)
  assert.equal(metadata.canonical, canonical)
  assert.match(metadata.robots, /\bindex\b/)
  assert.doesNotMatch(metadata.robots, /noindex|nofollow/)
  assert.match(metadata.robots, /max-image-preview:large/)
  assert.equal(metadata.og.type, 'website')
  assert.equal(metadata.og.site_name, 'esque')
  assert.equal(metadata.og.url, canonical)
  assert.equal(metadata.twitter.card, 'summary_large_image')
  for (const social of [metadata.og, metadata.twitter]) {
    assert.equal(social.title, metadata.title)
    assert.equal(social.description, metadata.description)
    assert.ok(social['image:alt'])
  }
  assert.equal(metadata.og.image, new URL('social-preview.jpg', canonical).href)
  assert.equal(metadata.twitter.image, metadata.og.image)
  assert.equal(metadata.twitter['image:alt'], metadata.og['image:alt'])
  assert.equal(metadata.og['image:type'], 'image/jpeg')

  const preview = await get(new URL(metadata.og.image).pathname, 'image/jpeg')
  assert.ok((await preview.arrayBuffer()).byteLength < 5_000_000)
  const dimensions = await page.evaluate(async (path) => {
    const image = new Image()
    image.src = path
    await image.decode()
    return [image.naturalWidth, image.naturalHeight]
  }, new URL(metadata.og.image).pathname)
  assert.deepEqual(dimensions, [1200, 630])
  assert.deepEqual(dimensions.map(String), [metadata.og['image:width'], metadata.og['image:height']])

  assert.equal(metadata.schema['@context'], 'https://schema.org')
  const website = metadata.schema['@graph'].find((item) => item['@type'] === 'WebSite')
  const app = metadata.schema['@graph'].find((item) => item['@type'] === 'WebApplication')
  assert.equal(website?.url, canonical)
  assert.equal(app?.url, canonical)
  assert.equal(app?.name, 'esque')
  assert.equal(app?.description, metadata.description)
  assert.equal(app?.isAccessibleForFree, true)
  assert.equal(app?.offers.price, '0')
  assert.match(app?.license, /agpl-3\.0/)
  assert.match(app?.browserRequirements, /JavaScript.*WebGPU/)
  assert.equal(app?.screenshot, metadata.og.image)

  const urls = await page.evaluate((xml) => {
    const document = new DOMParser().parseFromString(xml, 'application/xml')
    if (document.querySelector('parsererror')) throw new Error('Invalid sitemap XML')
    if (document.documentElement.namespaceURI !== 'http://www.sitemaps.org/schemas/sitemap/0.9')
      throw new Error('Invalid sitemap namespace')
    return [...document.querySelectorAll('url > loc')].map((loc) => loc.textContent)
  }, sitemap)
  assert.deepEqual(urls, [canonical])

  for (const { name, width, height } of viewports) {
    await page.setViewportSize({ width, height })
    assert.equal(await page.getByRole('main').count(), 1)
    assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1)
    assert.ok(await page.getByRole('heading', { name: /photo editor/i }).isVisible())
    const noScript = page.locator('noscript p')
    assert.equal(await noScript.textContent(), 'Enable JavaScript to open the photo editor.')
    assert.ok(await noScript.isVisible())
    assert.ok(await page.evaluate(() => {
      const intro = document.getElementById('app-intro')
      return intro.scrollWidth <= intro.clientWidth && intro.clientWidth <= window.innerWidth
    }), `${name}: startup content must fit the viewport`)
    const source = page.getByRole('link', { name: 'Source code and documentation' })
    await source.scrollIntoViewIfNeeded()
    assert.ok(await source.isVisible())
    if (screenshots)
      await page.screenshot({ path: join(screenshots, `seo-nojs-${name}.png`), animations: 'disabled' })
  }
  await crawler.close()

  const context = await browser.newContext()
  const editor = await context.newPage()
  const errors = []
  editor.on('pageerror', (error) => errors.push(error.message))
  await editor.goto(origin.href, { waitUntil: 'networkidle' })
  await editor.getByRole('dialog', { name: 'esque', exact: true }).waitFor()
  assert.equal(await editor.locator('#app-intro').count(), 0, 'React must replace the startup content')
  assert.ok(await editor.getByText(/A free, open-source photo editor/).isVisible())
  assert.equal(await editor.title(), metadata.title)
  for (const { name, width, height } of viewports) {
    await editor.setViewportSize({ width, height })
    assert.ok(await editor.getByRole('dialog', { name: 'esque', exact: true }).isVisible())
    if (screenshots)
      await editor.screenshot({ path: join(screenshots, `seo-editor-${name}.png`), animations: 'disabled' })
  }
  assert.ok(await dismissWelcome(editor), 'The welcome dialog must remain dismissible')
  assert.ok(await editor.getByRole('main').getByRole('button', { name: 'Choose Folder', exact: true }).isVisible())
  assert.ok(await editor.getByRole('main').getByRole('button', { name: 'Choose Photos', exact: true }).isVisible())
  assert.deepEqual(errors, [], 'Editor startup must not throw')
  await context.close()
  console.log('SEO metadata, sitemap, robots, social image, no-JavaScript content and editor startup passed.')
} finally {
  await browser.close()
}
