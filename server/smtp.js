/*
  Workspace SMTP: lets an owner or admin send Waymark email alerts through their own mail server.

  Storage. One record per tenant in `platform_settings` (id "smtp"), so it is tenant-scoped like
  everything else in server/store.js and lands in Supabase for signed-in companies. Host, port,
  security mode, username and sender details are kept in the clear because the settings screen
  shows them. The password is sealed with the credential vault (AES-256-GCM, server/crypto.js) and
  is never returned: the browser only learns whether one is saved.

  Safety.
  - Host: a DNS name or public IP. It is resolved before every connection, and private, loopback,
    link-local and other reserved addresses are refused, so the form cannot be used to probe the
    server's own network. The connection is then made to the address that passed the check, with
    TLS still validated against the hostname. SMTP_ALLOW_PRIVATE_HOSTS=true (or a host listed in
    EXTRA_ALLOWED_HOSTS) lifts this for a local development mail catcher.
  - Ports: 25, 465, 587 and 2525, unless private hosts are allowed for development.
  - TLS: SSL/TLS or STARTTLS, with certificate verification always on and TLS 1.2 minimum.
    "None" is accepted only when SMTP_ALLOW_INSECURE=true, which is meant for a trusted
    development mail catcher.
  - Timeouts on connect, greeting and socket. No connection pooling across tenants.
  - Errors are mapped to plain messages. Server replies and credentials are never logged.

  States are kept separate on purpose: saving is not verification, and a verified connection does
  not prove that a message reached an inbox. A test send reports what the SMTP server said
  (accepted or rejected recipients), and says that this is hand-off, not delivery.
*/
import { lookup as dnsLookup } from 'node:dns/promises'
import net from 'node:net'
import nodemailer from 'nodemailer'
import { EmailError, validateRecipients } from './email.js'

// Connection security modes the form offers, and the standard mail ports we allow.
export const SMTP_SECURITY = ['ssl', 'starttls', 'none']
export const SMTP_PORTS = [25, 465, 587, 2525]
// Limits: field lengths, and how many tests one workspace may run per 10 minutes.
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/
const NAME_MAX = 80
const PASSWORD_MAX = 512
const TEST_WINDOW_MS = 10 * 60_000
const TEST_LIMIT = 5
const VERIFY_LIMIT = 10

// Trims a form value, strips control characters (no header injection) and caps its length.
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max)

/** True for addresses an outbound connection must not reach: private, loopback, link-local, CGNAT, multicast, reserved. */
export function isBlockedAddress(ip) {
  const v = net.isIP(ip)
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  }
  if (v === 6) {
    const x = ip.toLowerCase()
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isBlockedAddress(mapped[1])
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || x.startsWith('64:ff9b:') || x.startsWith('2001:db8')
  }
  return true
}

// Development escape hatch: a local mail catcher may use a private host when the server allows it.
const devHost = (config, host) => config.smtpAllowPrivateHosts || (config.extraAllowedHosts ?? []).includes(host)

/**
 * Checks and normalizes what the settings form sent. `current` is the saved record, so an empty
 * password keeps the saved one. Returns { settings, password } where password is undefined when
 * unchanged and null when it should be removed.
 */
export function validateSmtpInput(input = {}, { config = {}, current = null } = {}) {
  const host = clean(input.host, 253).toLowerCase().replace(/\.$/, '')
  if (!host) throw new EmailError('SMTP host is required.')
  const dev = devHost(config, host)
  if (net.isIP(host)) {
    if (isBlockedAddress(host) && !dev) throw new EmailError('That SMTP host is a private or reserved address. Use the mail server’s public hostname.')
  } else if (!HOSTNAME_RE.test(host) && !(dev && /^[a-z0-9.-]{1,253}$/.test(host))) {
    throw new EmailError('SMTP host must be a hostname such as smtp.example.com.')
  }
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/.test(host) && !dev) throw new EmailError('Local and internal hostnames are not allowed for SMTP.')

  const port = Number(input.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new EmailError('SMTP port must be a whole number between 1 and 65535.')
  if (!SMTP_PORTS.includes(port) && !dev) throw new EmailError(`SMTP port must be one of ${SMTP_PORTS.join(', ')}.`)

  const security = String(input.security ?? '')
  if (!SMTP_SECURITY.includes(security)) throw new EmailError('Choose SSL/TLS, STARTTLS or None for the connection security.')
  if (security === 'none' && !config.smtpAllowInsecure) throw new EmailError('Unencrypted SMTP is turned off on this server. Choose SSL/TLS or STARTTLS. (A trusted development setup can allow it with SMTP_ALLOW_INSECURE=true.)')

  const username = clean(input.username, 254)
  const [fromEmail] = validateRecipients([input.fromEmail ?? ''])
  if (!fromEmail) throw new EmailError('Sender email address is required.')
  const fromName = clean(input.fromName, NAME_MAX).replace(/["<>]/g, '')
  let replyTo = null
  if (clean(input.replyTo, 254)) [replyTo] = validateRecipients([input.replyTo])

  let password
  if (input.clearPassword === true) password = null
  else if (typeof input.password === 'string' && input.password.length) {
    if (input.password.length > PASSWORD_MAX) throw new EmailError('The SMTP password is too long.')
    if (/[\r\n]/.test(input.password)) throw new EmailError('The SMTP password cannot contain line breaks.')
    password = input.password
  }
  const willHavePassword = password === undefined ? Boolean(current?.sealedPassword) : Boolean(password)
  if (username && !willHavePassword) throw new EmailError('Enter the SMTP password or app password for this username.')
  if (!username && willHavePassword) throw new EmailError('Enter the SMTP username that goes with the password.')

  return { settings: { host, port, security, username, fromEmail, fromName, replyTo }, password }
}

/** Nodemailer options for one connection to an already-checked address. */
export function transportOptions(settings, { address, password, timeoutMs = 10_000 }) {
  const tls = { servername: net.isIP(settings.host) ? undefined : settings.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' }
  return {
    host: address ?? settings.host,
    port: settings.port,
    secure: settings.security === 'ssl',
    requireTLS: settings.security === 'starttls',
    ignoreTLS: settings.security === 'none',
    tls,
    name: 'waymark',
    auth: settings.username ? { user: settings.username, pass: password ?? '' } : undefined,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs * 2,
    dnsTimeout: timeoutMs,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  }
}

/** Turns a Nodemailer or network error into a message that is safe to show and store. */
export function smtpErrorMessage(err) {
  const code = err?.code ?? ''
  const text = `${err?.message ?? ''}`
  if (code === 'EAUTH') return 'The SMTP server rejected the username or password.'
  if (code === 'ENOAUTH') return 'The SMTP server needs a username and password.'
  if (code === 'EDNS' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'The SMTP host name could not be resolved.'
  if (code === 'ETIMEDOUT' || /timeout/i.test(text)) return 'The SMTP server did not respond in time. Check the host, port and firewall.'
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(text)) return 'The SMTP server refused the connection on that port.'
  if (/certificate|self[- ]signed|CERT_|unable to verify/i.test(text)) return 'The SMTP server’s TLS certificate could not be verified.'
  if (/STARTTLS/i.test(text) || code === 'ETLS') return 'The SMTP server does not offer STARTTLS on this port. Try SSL/TLS on port 465, or check the security setting.'
  if (/wrong version number|ssl3_get_record|packet length/i.test(text)) return 'The security mode does not match the port. Port 465 normally uses SSL/TLS; 587 and 25 use STARTTLS.'
  if (code === 'EENVELOPE') return 'The SMTP server rejected the sender or recipient address.'
  if (code === 'EMESSAGE' || code === 'EPROTOCOL') return 'The SMTP server rejected the message.'
  if (code === 'ECONNECTION' || code === 'ESOCKET' || code === 'ECONNRESET') return 'The connection to the SMTP server failed.'
  return 'The SMTP server could not be used.'
}

/**
 * @param store  tenant-scoped store
 * @param vault  from createVault
 * @param createTransport  injectable for tests (defaults to nodemailer.createTransport)
 * @param lookup  injectable DNS lookup (defaults to dns.lookup with all addresses)
 */
export function createSmtpManager({ config = {}, store, vault, createTransport = nodemailer.createTransport, lookup = (host) => dnsLookup(host, { all: true, verbatim: true }) }) {
  const timeoutMs = Math.min(30_000, Math.max(2_000, config.smtpTimeoutMs ?? 10_000))
  const attempts = new Map() // recent test timestamps, keyed by "tenant:kind"

  // The saved SMTP record for a workspace, and whether this workspace may use SMTP at all.
  const record = (tenant) => store.get(tenant, 'platform_settings', 'smtp')
  const allowedFor = (tenant) => tenant.startsWith('co:') || Boolean(config.emailAllowAnonymous)

  /** A small per-tenant budget for connection tests and test sends, on top of the global rate limiter. */
  function take(tenant, kind, limit) {
    const key = `${tenant}:${kind}`
    const now = Date.now()
    const recent = (attempts.get(key) ?? []).filter((t) => now - t < TEST_WINDOW_MS)
    if (recent.length >= limit) throw new EmailError(`Too many SMTP ${kind === 'send' ? 'test emails' : 'connection tests'}. Try again in a few minutes.`, 429)
    recent.push(now)
    if (attempts.size > 5000) attempts.clear()
    attempts.set(key, recent)
  }

  /**
   * The status badge. A test result only counts for the configuration it was run against
   * (configVersion), so editing the settings drops back to "configured, not verified".
   */
  function stateOf(saved) {
    if (!saved?.settings) return 'not_configured'
    if (saved.verification?.ok === true && saved.verification.configVersion === saved.configVersion) return 'verified'
    if (saved.verification?.ok === false && saved.verification.configVersion === saved.configVersion) return 'failed'
    return 'configured_unverified'
  }

  /** What the browser may see. The password, sealed or not, is never included. */
  function view(saved, tenant) {
    const s = saved?.settings ?? null
    const passwordReadable = saved?.sealedPassword ? vault.open(saved.sealedPassword) !== null : null
    return {
      state: stateOf(saved),
      enabled: Boolean(saved?.enabled),
      settings: s,
      hasPassword: Boolean(saved?.sealedPassword),
      passwordReadable,
      passwordUpdatedAt: saved?.passwordUpdatedAt ?? null,
      lastVerifiedAt: saved?.lastVerifiedAt ?? null,
      lastVerification: saved?.verification ? { ok: saved.verification.ok, at: saved.verification.at, message: saved.verification.message } : null,
      lastDelivery: saved?.lastDelivery ?? null,
      lastDeliveryError: saved?.lastDeliveryError ?? null,
      updatedAt: saved?.updatedAt ?? null,
      updatedBy: saved?.updatedBy ?? null,
      allowed: allowedFor(tenant),
      credentialStorage: vault.persistent ? 'persistent' : 'temporary',
      policy: { ports: SMTP_PORTS, allowInsecure: Boolean(config.smtpAllowInsecure), allowPrivateHosts: Boolean(config.smtpAllowPrivateHosts) },
    }
  }

  async function get(tenant) {
    return view(await record(tenant), tenant)
  }

  function assertAllowed(tenant) {
    if (!allowedFor(tenant)) throw new EmailError('SMTP is available to signed-in company workspaces. For a local single-user install, set EMAIL_ALLOW_ANONYMOUS=true on the server.', 403)
  }

  /** Validates and stores the form. The password is sealed; any real change switches SMTP off until re-tested. */
  async function save(tenant, input, actor) {
    assertAllowed(tenant)
    const current = await record(tenant)
    const { settings, password } = validateSmtpInput(input, { config, current })
    if (password && !vault.persistent) throw new EmailError('The server has no persistent encryption key, so an SMTP password cannot be stored safely. Set INTEGRATIONS_ENCRYPTION_KEY (or give the server a writable WAYMARK_DATA_DIR) and try again.', 409)
    const next = { ...(current ?? {}), id: 'smtp' }
    const changed = !current?.settings || JSON.stringify(current.settings) !== JSON.stringify(settings) || password !== undefined
    next.settings = settings
    if (password === null) { delete next.sealedPassword; next.passwordUpdatedAt = new Date().toISOString() }
    else if (password !== undefined) { next.sealedPassword = vault.seal(password); next.passwordUpdatedAt = new Date().toISOString() }
    if (changed) next.configVersion = (current?.configVersion ?? 0) + 1
    // A changed configuration has to be verified again before it is used.
    if (changed && typeof input.enabled !== 'boolean') next.enabled = false
    if (typeof input.enabled === 'boolean') {
      if (input.enabled && stateOf(next) !== 'verified') throw new EmailError('Test the connection successfully before turning SMTP on.', 409)
      next.enabled = input.enabled
    }
    next.updatedBy = actor
    next.updatedAt = new Date().toISOString()
    await store.put(tenant, 'platform_settings', next)
    return view(next, tenant)
  }

  /** The on/off switch. Turning on is only allowed after a successful connection test. */
  async function setEnabled(tenant, enabled, actor) {
    assertAllowed(tenant)
    const current = await record(tenant)
    if (!current?.settings) throw new EmailError('Save an SMTP configuration first.', 409)
    if (enabled && stateOf(current) !== 'verified') throw new EmailError('Test the connection successfully before turning SMTP on.', 409)
    const next = { ...current, enabled: Boolean(enabled), updatedBy: actor, updatedAt: new Date().toISOString() }
    await store.put(tenant, 'platform_settings', next)
    return view(next, tenant)
  }

  /** Deletes the configuration and sealed password. Alerts fall back to the server's default provider. */
  async function remove(tenant) {
    await store.remove(tenant, 'platform_settings', 'smtp')
    return view(null, tenant)
  }

  /** Resolves the host and refuses reserved addresses. Returns the address to connect to. */
  async function resolve(settings) {
    if (devHost(config, settings.host)) return settings.host
    if (net.isIP(settings.host)) {
      if (isBlockedAddress(settings.host)) throw new EmailError('That SMTP host is a private or reserved address.')
      return settings.host
    }
    let found
    let timer
    try {
      found = await Promise.race([lookup(settings.host), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('dns timeout'), { code: 'ETIMEDOUT' })), timeoutMs) })])
    } catch (err) {
      throw new EmailError(err?.code === 'ETIMEDOUT' ? 'Looking up the SMTP host timed out.' : 'The SMTP host name could not be resolved.', 502)
    } finally {
      clearTimeout(timer)
    }
    const list = (Array.isArray(found) ? found : [found]).map((a) => (typeof a === 'string' ? a : a?.address)).filter(Boolean)
    if (!list.length) throw new EmailError('The SMTP host name could not be resolved.', 502)
    if (list.some(isBlockedAddress)) throw new EmailError('The SMTP host resolves to a private or reserved address, which is not allowed.')
    return list[0]
  }

  /** Opens a transport for a saved configuration, or throws a clear error. */
  async function open(tenant) {
    const saved = await record(tenant)
    if (!saved?.settings) throw new EmailError('SMTP is not configured.', 409)
    let password
    if (saved.settings.username) {
      password = saved.sealedPassword ? vault.open(saved.sealedPassword) : null
      if (password === null) throw new EmailError('The saved SMTP password cannot be read (the server encryption key changed). Enter the password again.', 409)
    }
    const address = await resolve(saved.settings)
    return { saved, transport: createTransport(transportOptions(saved.settings, { address, password, timeoutMs })) }
  }

  // Merges status fields (last test, last delivery) into the saved record.
  async function update(tenant, patch) {
    const saved = await record(tenant)
    if (!saved) return null
    return store.put(tenant, 'platform_settings', { ...saved, ...patch })
  }

  /** Connects, negotiates TLS and authenticates. Nothing is sent. */
  async function verify(tenant) {
    assertAllowed(tenant)
    take(tenant, 'verify', VERIFY_LIMIT)
    const at = new Date().toISOString()
    let saved
    try {
      const opened = await open(tenant)
      saved = opened.saved
      try {
        await opened.transport.verify()
      } finally {
        opened.transport.close?.()
      }
    } catch (err) {
      const message = err instanceof EmailError ? err.message : smtpErrorMessage(err)
      saved ??= await record(tenant)
      if (saved) await update(tenant, { verification: { ok: false, at, message, code: err?.code ?? null, configVersion: saved.configVersion } })
      console.warn('[smtp] verification failed:', err?.code ?? 'error')
      return { ok: false, message, smtp: await get(tenant) }
    }
    await update(tenant, { verification: { ok: true, at, message: 'Connected, secured and authenticated.', configVersion: saved.configVersion }, lastVerifiedAt: at })
    return { ok: true, message: 'Connection verified: the server accepted the connection, security settings and sign-in. No email was sent.', smtp: await get(tenant) }
  }

  /** Sends one rendered message through the tenant's SMTP server. Throws EmailError on failure. */
  async function send(tenant, { to, subject, html, text }) {
    assertAllowed(tenant)
    const { saved, transport } = await open(tenant)
    const s = saved.settings
    const from = s.fromName ? { name: s.fromName, address: s.fromEmail } : s.fromEmail
    try {
      const info = await transport.sendMail({ from, to, subject, html, text, replyTo: s.replyTo ?? undefined, headers: { 'X-Waymark-Notification': '1' } })
      const accepted = (info.accepted ?? []).map(String)
      const rejected = (info.rejected ?? []).map(String)
      if (!accepted.length) throw Object.assign(new Error('rejected'), { code: 'EENVELOPE' })
      await update(tenant, { lastDelivery: { at: new Date().toISOString(), status: 'accepted', accepted: accepted.length, rejected: rejected.length } })
      return { reference: info.messageId ?? null, accepted, rejected }
    } catch (err) {
      const message = smtpErrorMessage(err)
      await update(tenant, { lastDelivery: { at: new Date().toISOString(), status: 'failed' }, lastDeliveryError: { at: new Date().toISOString(), message } })
      console.warn('[smtp] send failed:', err?.code ?? 'error')
      throw new EmailError(message, 502)
    } finally {
      transport.close?.()
    }
  }

  /** True when this tenant's alerts should go through its SMTP server. */
  async function activeFor(tenant) {
    if (!allowedFor(tenant)) return false
    const saved = await record(tenant)
    return Boolean(saved?.enabled && saved.settings)
  }

  return { get, save, setEnabled, remove, verify, send, activeFor, allowedFor, take: (tenant) => take(tenant, 'send', TEST_LIMIT), stateOf }
}
