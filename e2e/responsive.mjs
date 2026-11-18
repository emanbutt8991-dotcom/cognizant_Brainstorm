/*
  Responsive and RTL smoke test for the signed-in workspace.
  Opens the Maple Trail demo and visits every primary page at eight widths (375–1920 px), then in Arabic.
  Also measures the Command Center cards (height, columns, clipping), the SMTP form on a phone,
  and the mobile navigation drawer.
  Fails on page errors, a missing page heading, or horizontal page overflow.
  Usage: npm run build && node e2e/responsive.mjs   (E2E_SHOTS=dir to save screenshots)
*/
import { existsSync, mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { createApp } from '../server/app.js'
import { loadConfig } from '../server/config.js'

const PORT = 8798
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = process.env.E2E_SHOTS
const BROWSERS = [process.env.E2E_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean)
// Phone, large phone, tablet, small laptop, laptops and a full-HD desktop.
const WIDTHS = [375, 430, 768, 1024, 1280, 1366, 1440, 1920]
// Every primary workspace page, plus the settings tabs with the most form fields.
const PAGES = ['/app', '/app/map', '/app/shipments', '/app/simulator', '/app/agent', '/app/activity', '/app/approvals', '/app/analyst', '/app/inventory', '/app/finance', '/app/integrations', '/app/reports', '/app/settings?tab=features', '/app/settings?tab=products', '/app/settings?tab=email', '/app/settings?tab=branding', '/app/settings?tab=language']

// Serve the production build through the real API (in memory, no saved data), then open a headless browser.
if (!existsSync('dist/index.html')) throw new Error('dist/ is missing. Run npm run build first.')
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const server =createApp({ ...loadConfig({}), dataDir: '', rateLimitPerMinute: 10000 }).listen(PORT, '127.0.0.1')
const browser = await chromium.launch({ executablePath: BROWSERS.find((b) => existsSync(b)), headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const failures = []
const errors = []
let checks = 0

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  // Fixed exchange rates and an empty news feed, so results do not depend on outside services.
  await page.route('**/api/fx', (r) => r.fulfill({ json: { rates: { CAD: 1, USD: 1.36, EUR: 1.48, CNY: 0.19 }, source: 'E2E fixture', asOf: '2026-11-16', live: true } }))
  await page.route('**/api/news**', (r) => r.fulfill({ json: { articles: [], source: 'E2E fixture' } }))
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`))

  // Open the Maple Trail demo on the Pro plan, so every page is unlocked.
  await page.goto(`${BASE}/demo`)
  await page.getByRole('button', { name: 'Pro' }).click()
  await page.getByRole('button', { name: 'Open Maple Trail Home Goods' }).click()
  await page.waitForURL('**/app')

  // One check: open a page at a width, wait for its heading, then measure any sideways scroll.
  const visit = async (path, width, label) => {
    await page.setViewportSize({ width, height: width < 800 ? 820 : 900 })
    await page.goto(BASE + path)
    try {
      await page.locator('main h1').first().waitFor({ timeout: 15000 })
    } catch {
      checks++
      failures.push(`${label} ${path} @${width}px rendered no page heading${errors.length ? ` (last page error: ${errors.at(-1).slice(0, 160)})` : ''}`)
      return
    }
    await page.waitForTimeout(250)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    checks++
    if (overflow > 1) failures.push(`${label} ${path} @${width}px overflows by ${overflow}px`)
    if (SHOTS && [375, 1440].includes(width)) await page.screenshot({ path: `${SHOTS}/${label}-${width}${path.replace(/[/?=&]+/g, '_')}.png` })
  }

  for (const width of WIDTHS) for (const path of PAGES) await visit(path, width, 'en')

  // Command Center metric cards: compact, readable, never clipped, and the expected columns per width.
  // Height limits leave room for wrapped labels on narrow cards; targets at laptop widths are ~95-120 px and ~125-155 px.
  const COLUMNS = { 375: [2, 1], 430: [2, 1], 768: [3, 2], 1024: [3, 2], 1280: [6, 4], 1366: [6, 4], 1440: [6, 4], 1920: [6, 4] }
  const cardReport = []
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(BASE + '/app')
    await page.locator('[data-kpi-grid="finance"]').waitFor({ timeout: 15000 })
    await page.waitForTimeout(200)
    const m = await page.evaluate(() => Object.fromEntries(['network', 'finance'].map((id) => {
      const grid = document.querySelector(`[data-kpi-grid="${id}"]`)
      const cards = [...grid.querySelectorAll('[data-kpi]')]
      return [id, {
        cols: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
        heights: cards.map((c) => Math.round(c.getBoundingClientRect().height)),
        clipped: cards.filter((c) => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1).length,
        valueFont: Math.round(parseFloat(getComputedStyle(cards[0].querySelector('.font-display')).fontSize)),
        count: cards.length,
      }]
    })))
    checks++
    const [netCols, finCols] = COLUMNS[width]
    const maxNet = Math.max(...m.network.heights), maxFin = Math.max(...m.finance.heights)
    cardReport.push(`${width}px network ${m.network.cols}col max ${maxNet}px · finance ${m.finance.cols}col max ${maxFin}px`)
    if (m.network.count !== 6 || m.finance.count !== 4) failures.push(`Command Center @${width}px shows ${m.network.count}+${m.finance.count} metric cards, expected 6+4`)
    if (m.network.cols !== netCols || m.finance.cols !== finCols) failures.push(`Command Center @${width}px has ${m.network.cols}/${m.finance.cols} columns, expected ${netCols}/${finCols}`)
    if (m.network.clipped || m.finance.clipped) failures.push(`Command Center @${width}px clips content in ${m.network.clipped + m.finance.clipped} card(s)`)
    if (maxNet > (width >= 1280 ? 120 : 130)) failures.push(`Network card @${width}px is ${maxNet}px tall`)
    if (maxFin > (width >= 1280 ? 155 : 170)) failures.push(`Spend card @${width}px is ${maxFin}px tall`)
    if (m.network.valueFont < 22) failures.push(`Metric value font @${width}px is ${m.network.valueFont}px`)
  }
  console.log(`Command Center cards:\n  ${cardReport.join('\n  ')}`)

  // SMTP settings form fits on a phone.
  await page.setViewportSize({ width: 375, height: 820 })
  await page.goto(BASE + '/app/settings?tab=email')
  await page.getByRole('tab', { name: /SMTP configuration/ }).click()
  await page.locator('[data-testid="smtp-form"]').waitFor({ timeout: 15000 })
  checks++
  const smtpOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  if (smtpOverflow > 1) failures.push(`SMTP settings @375px overflows by ${smtpOverflow}px`)

  // Navigation: categories follow the URL, and the mobile drawer lists every category.
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${BASE}/app/finance`)
  const active = await page.locator('nav[aria-label="Feature categories"] [aria-current="true"]').innerText()
  if (!/Business/.test(active)) failures.push(`Deep link to /app/finance activated "${active}", expected Business`)
  await page.setViewportSize({ width: 375, height: 820 })
  await page.getByRole('button', { name: 'Open navigation menu' }).click()
  for (const name of ['Intelligence', 'Solutions', 'Business']) if (!(await page.getByRole('dialog').getByText(name, { exact: true }).count())) failures.push(`Mobile menu is missing ${name}`)
  await page.keyboard.press('Escape')

  // Arabic: right-to-left document, translated navigation, no overflow.
  await page.evaluate(() => { const k = 'waymark.viewPrefs.v1'; const p = JSON.parse(localStorage.getItem(k) ?? '{}'); localStorage.setItem(k, JSON.stringify({ ...p, language: 'ar' })) })
  for (const width of [375, 1440]) for (const path of ['/app', '/app/simulator', '/app/settings?tab=features', '/app/approvals', '/app/activity', '/app/settings?tab=email']) await visit(path, width, 'ar')
  // Arabic: metric labels are translated and cards start from the right edge.
  await page.goto(BASE + '/app')
  await page.locator('[data-kpi-grid="network"]').waitFor()
  checks++
  const rtl = await page.evaluate(() => { const g = document.querySelector('[data-kpi-grid="network"]'); const [a, b] = g.querySelectorAll('[data-kpi]'); return { label: a.textContent, firstRight: a.getBoundingClientRect().right, secondRight: b.getBoundingClientRect().right } })
  if (!/إجمالي الموردين/.test(rtl.label)) failures.push('Arabic Command Center metric label is not translated')
  if (!(rtl.firstRight > rtl.secondRight)) failures.push('Arabic Command Center cards do not flow right-to-left')
  const dir = await page.evaluate(() => document.documentElement.dir)
  if (dir !== 'rtl') failures.push(`Arabic did not set dir=rtl (got ${dir})`)
  if (!(await page.getByText('الأعمال', { exact: true }).count())) failures.push('Arabic navigation text (Business category) is missing')
} finally {
  await browser.close()
  server.close()
}

// Summary: exit code 1 if anything failed, so CI and npm scripts notice.
console.log(`${checks} page/width checks run.`)
if (errors.length) console.log(`Page errors:\n  ${[...new Set(errors)].join('\n  ')}`)
if (failures.length) console.log(`Failures:\n  ${failures.join('\n  ')}`)
process.exit(errors.length || failures.length ? 1 : 0)
