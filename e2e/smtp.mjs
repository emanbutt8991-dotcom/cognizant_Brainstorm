/*
  SMTP settings, end to end in a real browser: configure, verify, send a test email, switch on,
  and check the password never comes back from the API. A local fake SMTP server receives the
  mail, so nothing leaves this machine.
  Usage: npm run build && node e2e/smtp.mjs
*/
import { existsSync } from 'node:fs'
import net from 'node:net'
import { chromium } from 'playwright-core'
import { createApp } from '../server/app.js'
import { loadConfig } from '../server/config.js'

const PORT = 8795
const BASE = `http://127.0.0.1:${PORT}`
// A throwaway password. The test fails if it ever shows up in an API response.
const PASSWORD = 'e2e-smtp-app-password-123'
const BROWSERS = [process.env.E2E_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean)

/**
 * Minimal SMTP: EHLO, AUTH PLAIN, MAIL, RCPT, DATA, QUIT. It accepts only the test login and
 * keeps every received message in `messages`, so the test can check what actually arrived.
 */
function fakeSmtp() {
  const messages = []
  const server = net.createServer((socket) => {
    let buffer = ''
    let data = null
    let envelope = []
    const reply = (l) => socket.write(`${l}\r\n`)
    reply('220 fake.smtp ESMTP')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        if (data !== null) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          messages.push({ to: envelope, raw: data + buffer.slice(0, end) })
          buffer = buffer.slice(end + 5); data = null; envelope = []
          reply('250 2.0.0 queued as E2E')
          continue
        }
        const i = buffer.indexOf('\r\n')
        if (i < 0) return
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 2)
        const cmd = line.toUpperCase()
        if (cmd.startsWith('EHLO')) socket.write('250-fake.smtp\r\n250 AUTH PLAIN\r\n')
        else if (cmd.startsWith('AUTH PLAIN')) {
          const [, user, pass] = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString().split('\u0000')
          reply(user === 'alerts@acme.test' && pass === PASSWORD ? '235 ok' : '535 invalid')
        } else if (cmd.startsWith('MAIL FROM')) reply('250 ok')
        else if (cmd.startsWith('RCPT TO')) { envelope.push(line); reply('250 ok') }
        else if (cmd === 'DATA') { data = ''; reply('354 go') }
        else if (cmd === 'QUIT') { reply('221 bye'); socket.end(); return }
        else reply('250 ok')
      }
    })
    socket.on('error', () => {})
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, messages })))
}

// `check` records a failure and carries on, so one run reports every problem it finds.
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }
if (!existsSync('dist/index.html')) throw new Error('dist/ is missing. Run npm run build first.')
const smtp = await fakeSmtp()
// Development switches: a local mail catcher on a private address, without TLS. Never use these in production.
const app = createApp({ ...loadConfig({}), dataDir: '', encryptionKey: 'e2e-vault-key', rateLimitPerMinute: 10000, emailAllowAnonymous: true, smtpAllowPrivateHosts: true, smtpAllowInsecure: true })
const server = app.listen(PORT, '127.0.0.1')
const browser = await chromium.launch({ executablePath: BROWSERS.find((b) => existsSync(b)), headless: true })
const leaks = []
let page
try {
  page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage()
  page.setDefaultTimeout(15000)
  await page.route('**/api/fx', (r) => r.fulfill({ json: { rates: { CAD: 1, USD: 1.36 }, source: 'E2E fixture', asOf: '2026-11-16', live: true } }))
  // Watch every API response for the password (it must go in, never come back out).
  page.on('response', async (res) => {
    if (!res.url().includes('/api/')) return
    const body = await res.text().catch(() => '')
    if (body.includes(PASSWORD)) leaks.push(res.url())
  })
  // Open the demo workspace, then Settings → Email Notifications → SMTP configuration.
  await page.goto(`${BASE}/demo`)
  await page.getByRole('button', { name: 'Pro' }).click()
  await page.getByRole('button', { name: 'Open Maple Trail Home Goods' }).click()
  await page.waitForURL('**/app')

  await page.goto(`${BASE}/app/settings?tab=email`)
  await page.getByRole('tab', { name: /SMTP configuration/ }).click()
  const form = page.locator('[data-testid="smtp-form"]')
  await form.waitFor()
  check((await page.getByText('Not configured').count()) > 0, 'Initial state should be Not configured')

  // Validation error is shown, and nothing is saved.
  await form.getByLabel('SMTP host').fill('not a host')
  await form.getByLabel('Port').fill('587')
  await form.getByLabel('Sender email address').fill('alerts@acme.test')
  await form.getByRole('button', { name: 'Save configuration' }).click()
  await page.getByText('SMTP host must be a hostname such as smtp.example.com.').waitFor()
  check((await page.getByText('Not configured').count()) > 0, 'An invalid configuration must not be saved')

  // Real configuration for the local catcher.
  await form.getByLabel('SMTP host').fill('127.0.0.1')
  await form.getByLabel('Port').fill(String(smtp.port))
  await form.getByLabel('Security').selectOption('none')
  await form.getByLabel(/Username/).fill('alerts@acme.test')
  await form.getByLabel('Password or app password').fill(PASSWORD)
  await form.getByLabel(/Sender display name/).fill('Acme Alerts')
  await form.getByRole('button', { name: 'Save configuration' }).click()
  await page.getByText('SMTP configuration saved.', { exact: false }).waitFor()
  check(await form.getByLabel('Password or app password').inputValue() === '', 'Password field should be cleared after saving')
  await page.getByText('A password is saved. Leave blank to keep it.').waitFor()
  await page.getByText('Configured — not verified').first().waitFor()
  check(await page.getByRole('switch', { name: 'Use SMTP for email alerts' }).isDisabled(), 'SMTP cannot be switched on before a successful test')

  // Genuine verification over the socket; nothing is sent.
  await form.getByRole('button', { name: 'Test connection' }).click()
  await page.getByText('Connection verified', { exact: false }).waitFor()
  await page.getByText('Verified', { exact: true }).first().waitFor()
  check(smtp.messages.length === 0, 'Connection test must not send email')

  // Test email requires an explicit confirmation.
  const send = page.getByRole('button', { name: 'Send test email' }).last()
  await page.getByLabel('Recipient').fill('ops@acme.test')
  check(await send.isDisabled(), 'Send test email should wait for confirmation')
  await page.getByLabel('I want to send a real test email to this address.').check()
  await send.click()
  await page.getByText('not delivery to an inbox', { exact: false }).first().waitFor()
  check(smtp.messages.length === 1, `Expected 1 message at the SMTP server, got ${smtp.messages.length}`)
  check(/Waymark/.test(smtp.messages[0]?.raw ?? '') && /text\/html/.test(smtp.messages[0]?.raw ?? ''), 'Test email should be the branded HTML+text template')

  // Switch on: the notice and transport now say SMTP.
  // The switch only flips once the server confirms, so the test clicks it rather than "checking" it.
  await page.getByRole('switch', { name: 'Use SMTP for email alerts' }).click()
  await page.getByText('Alerts are sent through your SMTP server', { exact: false }).waitFor()

  // Delivery history lists the SMTP send.
  await page.getByRole('tab', { name: /Delivery history/ }).click()
  await page.getByText('via smtp', { exact: false }).first().waitFor()

  // Phone width: no sideways scroll on the SMTP tab.
  await page.setViewportSize({ width: 375, height: 820 })
  await page.getByRole('tab', { name: /SMTP configuration/ }).click()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  check(overflow <= 1, `SMTP tab overflows by ${overflow}px at 375px`)

  // Arabic: the SMTP tab is translated and right-to-left.
  await page.evaluate(() => { const k = 'waymark.viewPrefs.v1'; const p = JSON.parse(localStorage.getItem(k) ?? '{}'); localStorage.setItem(k, JSON.stringify({ ...p, language: 'ar' })) })
  await page.reload()
  await page.getByRole('tab', { name: /إعداد SMTP/ }).click()
  await page.getByText('خادم SMTP', { exact: true }).first().waitFor()
  check(await page.evaluate(() => document.documentElement.dir) === 'rtl', 'Arabic should be right-to-left')
} catch (err) {
  if (process.env.E2E_SHOTS) await page?.screenshot({ path: `${process.env.E2E_SHOTS}/smtp-fail.png`, fullPage: true }).catch(() => {})
  failures.push(`Run stopped: ${err.message.split('\n').slice(0, 4).join(' ')}`)
} finally {
  await browser.close()
  server.close()
  smtp.server.close()
}
// Summary: exit code 1 if anything failed.
if (leaks.length) failures.push(`The SMTP password appeared in API responses: ${leaks.join(', ')}`)
console.log(failures.length ? `SMTP E2E failed:\n  ${failures.join('\n  ')}` : 'SMTP E2E passed: configure, verify, confirmed test send, switch on, history, mobile and Arabic.')
process.exit(failures.length ? 1 : 0)
