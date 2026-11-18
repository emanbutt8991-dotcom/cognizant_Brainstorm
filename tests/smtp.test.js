// Workspace SMTP: validation, SSRF guards, sealed credentials, real verification and sending
// against an in-process fake SMTP server (nothing leaves this machine), and the HTTP routes.
import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../server/app.js'
import { loadConfig } from '../server/config.js'
import { createVault } from '../server/crypto.js'
import { createEmailNotifier, createEmailTransport } from '../server/email.js'
import { createSmtpManager, isBlockedAddress, smtpErrorMessage, transportOptions, validateSmtpInput } from '../server/smtp.js'
import { createFileStore } from '../server/store.js'

const PASSWORD = 'hunter2-app-password'

/** A minimal SMTP server: EHLO, AUTH PLAIN, MAIL, RCPT, DATA, QUIT. No STARTTLS. */
function fakeSmtp({ user = 'alerts@acme.test', pass = PASSWORD } = {}) {
  const messages = []
  const server = net.createServer((socket) => {
    let buffer = ''
    let data = null
    let awaitingAuth = false
    let envelope = { from: null, to: [] }
    const reply = (line) => socket.write(`${line}\r\n`)
    const checkAuth = (b64) => {
      const [, u, p] = Buffer.from(b64, 'base64').toString('utf8').split('\u0000')
      reply(u === user && p === pass ? '235 2.7.0 Authentication successful' : '535 5.7.8 Authentication credentials invalid')
    }
    reply('220 fake.smtp.test ESMTP ready')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (data !== null) {
        const end = buffer.indexOf('\r\n.\r\n')
        if (end < 0) return
        data += buffer.slice(0, end)
        buffer = buffer.slice(end + 5)
        messages.push({ ...envelope, raw: data })
        data = null
        envelope = { from: null, to: [] }
        reply('250 2.0.0 OK queued as FAKE123')
      }
      let index
      while (data === null && (index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const cmd = line.toUpperCase()
        if (awaitingAuth) { awaitingAuth = false; checkAuth(line); continue }
        if (cmd.startsWith('EHLO')) { socket.write('250-fake.smtp.test\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n'); continue }
        if (cmd.startsWith('HELO')) { reply('250 fake.smtp.test'); continue }
        if (cmd.startsWith('AUTH PLAIN')) { const arg = line.split(' ')[2]; if (arg) checkAuth(arg); else { awaitingAuth = true; reply('334 ') } continue }
        if (cmd.startsWith('MAIL FROM')) { envelope.from = line; reply('250 2.1.0 OK'); continue }
        if (cmd.startsWith('RCPT TO')) { if (/reject/i.test(line)) reply('550 5.1.1 No such user'); else { envelope.to.push(line); reply('250 2.1.5 OK') } continue }
        if (cmd === 'DATA') { data = ''; reply('354 End data with <CR><LF>.<CR><LF>'); if (buffer.includes('\r\n.\r\n')) socket.emit('data', Buffer.from('')); break }
        if (cmd === 'RSET' || cmd === 'NOOP') { reply('250 OK'); continue }
        if (cmd === 'QUIT') { reply('221 Bye'); socket.end(); continue }
        reply('502 5.5.2 Command not recognized')
      }
    })
    socket.on('error', () => {})
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, messages })))
}

const DEV = { smtpAllowInsecure: true, smtpAllowPrivateHosts: true, emailAllowAnonymous: false, appBaseUrl: 'https://app.waymark.test', smtpTimeoutMs: 3000 }
const CO = 'co:11111111-2222-3333-4444-555555555555'
const CO2 = 'co:99999999-2222-3333-4444-555555555555'
const settingsFor = (port, extra = {}) => ({ host: '127.0.0.1', port, security: 'none', username: 'alerts@acme.test', password: PASSWORD, fromEmail: 'alerts@acme.test', fromName: 'Acme Alerts', ...extra })

describe('SMTP input validation', () => {
  const base = { host: 'smtp.example.com', port: 587, security: 'starttls', username: 'u@example.com', password: 'secret', fromEmail: 'alerts@example.com' }
  it('accepts a normal configuration and normalizes it', () => {
    const { settings, password } = validateSmtpInput({ ...base, host: 'SMTP.Example.com.', fromName: 'Ops <team>' })
    expect(settings).toMatchObject({ host: 'smtp.example.com', port: 587, security: 'starttls', fromName: 'Ops team', replyTo: null })
    expect(password).toBe('secret')
  })
  it.each([
    [{ host: '' }, /host is required/],
    [{ host: '10.0.0.4' }, /private or reserved/],
    [{ host: '169.254.169.254' }, /private or reserved/],
    [{ host: 'localhost' }, /hostname such as|Local and internal/],
    [{ host: 'mail.corp.internal' }, /Local and internal/],
    [{ host: 'smtp.example.com/x' }, /hostname/],
    [{ port: 8080 }, /port must be one of/],
    [{ port: 'abc' }, /whole number/],
    [{ security: 'none' }, /Unencrypted SMTP is turned off/],
    [{ security: 'tls-maybe' }, /Choose SSL\/TLS/],
    [{ fromEmail: 'not-an-email' }, /not a valid email/],
    [{ replyTo: 'bad@' }, /not a valid email/],
    [{ password: '' }, /Enter the SMTP password/],
    [{ password: 'a\r\nRCPT TO:<x@y.z>' }, /line breaks/],
  ])('rejects %j', (patch, message) => {
    expect(() => validateSmtpInput({ ...base, ...patch })).toThrow(message)
  })
  it('allows a development mail catcher only when explicitly enabled', () => {
    expect(() => validateSmtpInput({ ...base, host: '127.0.0.1', port: 1025, security: 'none' })).toThrow()
    expect(validateSmtpInput({ ...base, host: '127.0.0.1', port: 1025, security: 'none' }, { config: DEV }).settings.port).toBe(1025)
  })
  it('flags reserved addresses, including IPv4-mapped IPv6', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '224.0.0.1']) expect([ip, isBlockedAddress(ip)]).toEqual([ip, true])
    for (const ip of ['8.8.8.8', '172.32.0.1', '2607:f8b0::1']) expect([ip, isBlockedAddress(ip)]).toEqual([ip, false])
  })
  it('keeps certificate checks on for every secure mode', () => {
    for (const security of ['ssl', 'starttls']) {
      const o = transportOptions({ host: 'smtp.example.com', port: 465, security, username: '' }, { address: '203.0.113.9' })
      expect(o.tls.rejectUnauthorized).toBe(true)
      expect(o.tls.servername).toBe('smtp.example.com')
      expect(o.tls.minVersion).toBe('TLSv1.2')
      expect(o.host).toBe('203.0.113.9')
      expect(o.disableFileAccess && o.disableUrlAccess).toBe(true)
    }
    expect(transportOptions({ host: 'h.example.com', port: 465, security: 'ssl' }, {}).secure).toBe(true)
    expect(transportOptions({ host: 'h.example.com', port: 587, security: 'starttls' }, {}).requireTLS).toBe(true)
  })
  it('maps errors to safe messages', () => {
    expect(smtpErrorMessage({ code: 'EAUTH', message: `535 bad ${PASSWORD}` })).toBe('The SMTP server rejected the username or password.')
    expect(smtpErrorMessage({ code: 'ESOCKET', message: 'self-signed certificate' })).toMatch(/certificate/)
    expect(smtpErrorMessage({ code: 'ETIMEDOUT' })).toMatch(/did not respond/)
  })
})

describe('SMTP manager', () => {
  let fake
  beforeAll(async () => { fake = await fakeSmtp() })
  afterAll(() => fake.server.close())
  const make = (config = DEV, extra = {}) => {
    const store = createFileStore()
    const vault = createVault('test-secret')
    return { store, vault, smtp: createSmtpManager({ config, store, vault, ...extra }) }
  }

  it('seals the password and never returns it', async () => {
    const { store, smtp } = make()
    const view = await smtp.save(CO, settingsFor(fake.port), 'user:1')
    expect(view.state).toBe('configured_unverified')
    expect(view.hasPassword).toBe(true)
    expect(JSON.stringify(view)).not.toContain(PASSWORD)
    const raw = await store.get(CO, 'platform_settings', 'smtp')
    expect(raw.sealedPassword).toMatch(/^v1\./)
    expect(JSON.stringify(raw)).not.toContain(PASSWORD)
    // A blank password on a later save keeps the saved one.
    const again = await smtp.save(CO, { ...settingsFor(fake.port), password: '', fromName: 'Renamed' }, 'user:1')
    expect(again.hasPassword).toBe(true)
    expect(again.settings.fromName).toBe('Renamed')
  })

  it('refuses to store a password without a persistent key', async () => {
    const store = createFileStore()
    const smtp = createSmtpManager({ config: DEV, store, vault: createVault('') })
    await expect(smtp.save(CO, settingsFor(fake.port), 'u')).rejects.toThrow(/INTEGRATIONS_ENCRYPTION_KEY/)
  })

  it('verifies a real connection and reports failures honestly', async () => {
    const { smtp } = make()
    await smtp.save(CO, settingsFor(fake.port), 'user:1')
    await expect(smtp.setEnabled(CO, true, 'user:1')).rejects.toThrow(/Test the connection/)
    const ok = await smtp.verify(CO)
    expect(ok.ok).toBe(true)
    expect(ok.smtp.state).toBe('verified')
    expect(ok.smtp.lastVerifiedAt).toBeTruthy()
    expect(fake.messages).toHaveLength(0) // verification sends nothing

    await smtp.save(CO, { ...settingsFor(fake.port), password: 'wrong-password' }, 'user:1')
    const bad = await smtp.verify(CO)
    expect(bad.ok).toBe(false)
    expect(bad.smtp.state).toBe('failed')
    expect(bad.message).toBe('The SMTP server rejected the username or password.')
    expect(JSON.stringify(bad)).not.toContain('wrong-password')
  })

  it('reports a missing STARTTLS instead of falling back to plain text', async () => {
    const { smtp } = make()
    await smtp.save(CO, settingsFor(fake.port, { security: 'starttls' }), 'u')
    const result = await smtp.verify(CO)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/STARTTLS|connection|security/i)
  })

  it('a configuration change needs a new verification and switches SMTP off', async () => {
    const { smtp } = make()
    await smtp.save(CO, settingsFor(fake.port), 'u')
    await smtp.verify(CO)
    expect((await smtp.setEnabled(CO, true, 'u')).enabled).toBe(true)
    const changed = await smtp.save(CO, { ...settingsFor(fake.port), password: '', fromEmail: 'other@acme.test' }, 'u')
    expect(changed.state).toBe('configured_unverified')
    expect(changed.enabled).toBe(false)
  })

  it('refuses hosts that resolve to private addresses', async () => {
    const { smtp } = make({ ...DEV, smtpAllowPrivateHosts: false }, { lookup: async () => [{ address: '10.0.0.5', family: 4 }] })
    await smtp.save(CO, { ...settingsFor(587), host: 'smtp.evil.example', security: 'starttls' }, 'u')
    const result = await smtp.verify(CO)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/private or reserved/)
  })

  it('keeps tenants apart and blocks anonymous workspaces by default', async () => {
    const { smtp } = make()
    await smtp.save(CO, settingsFor(fake.port), 'u')
    expect((await smtp.get(CO2)).state).toBe('not_configured')
    await expect(smtp.save('ws:abcdefghijklmnopqrstuvwxyz', settingsFor(fake.port), 'u')).rejects.toThrow(/signed-in company/)
  })

  it('rate-limits connection tests', async () => {
    const { smtp } = make({ ...DEV }, { createTransport: () => ({ verify: async () => true, close() {} }) })
    await smtp.save(CO, settingsFor(fake.port), 'u')
    for (let i = 0; i < 10; i++) await smtp.verify(CO)
    await expect(smtp.verify(CO)).rejects.toThrow(/Too many/)
  })
})

describe('email notifier over SMTP', () => {
  let fake
  beforeAll(async () => { fake = await fakeSmtp() })
  afterAll(() => fake.server.close())

  const setup = async () => {
    const store = createFileStore()
    const vault = createVault('test-secret')
    const smtp = createSmtpManager({ config: DEV, store, vault })
    const email = createEmailNotifier({ config: DEV, store, transport: createEmailTransport({ emailTransport: 'mock' }), smtp, brandingOf: async () => ({ displayName: 'Acme Imports' }) })
    await email.savePreferences(CO, { enabled: true, recipients: ['ops@acme.test'] }, 'u')
    return { store, smtp, email }
  }

  it('sends a branded test email to one typed recipient and reports hand-off, not inbox delivery', async () => {
    const { smtp, email } = await setup()
    await smtp.save(CO, settingsFor(fake.port, { replyTo: 'help@acme.test' }), 'u')
    const before = fake.messages.length
    const delivery = await email.sendSmtpTest(CO, { actor: 'user:1', to: 'Tester@Acme.test' })
    expect(delivery.status).toBe('sent')
    expect(delivery.transport).toBe('smtp')
    expect(delivery.detail).toMatch(/not delivery to an inbox/)
    expect(delivery.destination).toBe('t***@acme.test')
    const msg = fake.messages[before]
    expect(msg.to.join()).toContain('tester@acme.test')
    expect(msg.raw).toMatch(/Subject: \[Test\] Waymark SMTP test/)
    expect(msg.raw).toContain('text/plain')
    expect(msg.raw).toContain('text/html')
    expect(msg.raw).toMatch(/Reply-To: help@acme\.test/)
    expect(msg.raw).toMatch(/From: Acme Alerts <alerts@acme\.test>/)
    await expect(email.sendSmtpTest(CO, { actor: 'u', to: 'bad address' })).rejects.toThrow(/not a valid email/)
  })

  it('records a rejected recipient as a failure', async () => {
    const { smtp, email } = await setup()
    await smtp.save(CO, settingsFor(fake.port), 'u')
    const delivery = await email.sendSmtpTest(CO, { actor: 'u', to: 'reject@acme.test' })
    expect(delivery.status).toBe('failed')
    expect((await smtp.get(CO)).lastDeliveryError.message).toMatch(/rejected/)
  })

  it('routes alerts through SMTP only when switched on, and keeps duplicate suppression', async () => {
    const { store, smtp, email } = await setup()
    const message = { category: 'delay', label: 'Delay', headline: 'MT-1 is delayed', facts: [['Risk', 'High']] }
    const first = await email.deliver(CO, { message, dedupeKey: 'alert:1' })
    expect(first.transport).toBe('mock') // saved but not enabled: server transport is unchanged
    expect(first.mock).toBe(true)

    await smtp.save(CO, settingsFor(fake.port), 'u')
    await smtp.verify(CO)
    await smtp.setEnabled(CO, true, 'u')
    expect((await email.transportFor(CO)).kind).toBe('smtp')
    const before = fake.messages.length
    const sent = await email.deliver(CO, { message, dedupeKey: 'alert:2' })
    expect(sent).toMatchObject({ status: 'sent', transport: 'smtp', mock: false })
    expect(fake.messages.length).toBe(before + 1)
    expect(fake.messages.at(-1).raw).toContain('Waymark')
    const dup = await email.deliver(CO, { message, dedupeKey: 'alert:2' })
    expect(dup.status).toBe('skipped_duplicate')
    expect((await store.list(CO2, 'notification_deliveries'))).toHaveLength(0)
    expect((await email.transportFor(CO2)).kind).toBe('mock')
  })
})

describe('SMTP routes', () => {
  let fake, server, base
  const headers = { 'Content-Type': 'application/json', 'X-Waymark-Workspace': 'smtp-route-test-workspace-key-0001' }
  beforeAll(async () => {
    fake = await fakeSmtp()
    const app = createApp({ ...loadConfig({}), dataDir: '', encryptionKey: 'route-test-key', ...DEV, emailAllowAnonymous: true })
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    base = `http://127.0.0.1:${server.address().port}/api/notifications/email`
  })
  afterAll(() => { server.close(); fake.server.close() })
  const call = (path, method = 'GET', body) => fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }))

  it('saves, verifies and tests without ever returning the password', async () => {
    const saved = await call('/smtp', 'PUT', settingsFor(fake.port))
    expect(saved.status).toBe(200)
    expect(JSON.stringify(saved.body)).not.toContain(PASSWORD)
    expect(saved.body.smtp.state).toBe('configured_unverified')

    const verified = await call('/smtp/verify', 'POST')
    expect(verified.status).toBe(200)
    expect(verified.body.smtp.state).toBe('verified')

    const unconfirmed = await call('/smtp/test', 'POST', { to: 'ops@acme.test' })
    expect(unconfirmed.status).toBe(400)
    const tested = await call('/smtp/test', 'POST', { to: 'ops@acme.test', confirm: true })
    expect(tested.status).toBe(200)
    expect(tested.body.delivery.status).toBe('sent')

    const overview = await call('')
    expect(JSON.stringify(overview.body)).not.toContain(PASSWORD)
    expect(overview.body.smtp.hasPassword).toBe(true)
    expect(overview.body.transport.kind).toBe('mock') // not switched on yet

    const bad = await call('/smtp', 'PUT', { ...settingsFor(fake.port), port: 'x' })
    expect(bad.status).toBe(400)
    expect(bad.body.message).toMatch(/port/)
  })
})
