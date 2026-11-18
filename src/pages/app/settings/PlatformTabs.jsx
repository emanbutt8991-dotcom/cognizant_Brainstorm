// Settings → Email Notifications, Language, and the compact Integrations summary.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { INTEGRATIONS, STATUS } from '../../../../shared/integrations.js'
import { Feedback, usePlatform } from '../../../components/app/PlatformKit.jsx'
import { BoundedList, Card, ConfirmModal, DataTable, Notice, SectionTabs, SelectInput, StatusPill, TextArea, TextInput, useToast } from '../../../components/app/kit.jsx'
import { Badge, Button, Icon } from '../../../components/ui.jsx'
import { LANGUAGES, formatDateTime, useTranslation } from '../../../i18n/index.js'
import { platform } from '../../../services/api.js'
import { useViewPrefs } from '../../../state/viewPrefs.js'
import { Switch } from './FeaturesTab.jsx'

// Badge colours for delivery results and SMTP status, and the usual port for each security mode.
const DELIVERY_TONE = { sent: 'emerald', failed: 'rose', skipped_duplicate: 'slate', skipped_rate_limit: 'amber' }
const SMTP_TONE = { not_configured: 'slate', configured_unverified: 'amber', verified: 'emerald', failed: 'rose' }
const DEFAULT_PORT = { ssl: 465, starttls: 587, none: 25 }

/** Settings → Email Notifications: alert preferences, workspace SMTP, and delivery history, as three tabs. */
export function EmailTab() {
  const { t } = useTranslation('email')
  const state = usePlatform(() => platform.emailSettings())
  const [tab, setTab] = useState(() => (typeof location !== 'undefined' && new URLSearchParams(location.search).get('section')) || 'preferences')
  const data = state.data
  if (!data) return <Feedback state={state} />
  // Banner saying where alerts go right now: workspace SMTP, the server's provider, or the mock outbox.
  const transportNote = data.transport.kind === 'smtp'
    ? <Notice tone="info">{t('transport.smtp', { host: data.smtp?.settings?.host ?? 'SMTP' })}</Notice>
    : data.transport.live ? <Notice tone="info">{t('transport.server', { kind: data.transport.kind })}</Notice> : <Notice tone="warn">{t('transport.mock')}</Notice>
  return (
    <div className="space-y-3">
      {transportNote}
      <SectionTabs idPrefix="email" label={t('common:settings.tabs.email')} active={tab} onChange={setTab} tabs={[
        { id: 'preferences', label: t('tabs.preferences'), content: <EmailPreferences data={data} reload={state.reload} /> },
        { id: 'smtp', label: <span className="inline-flex items-center gap-1.5">{t('tabs.smtp')}<StatusPill tone={SMTP_TONE[data.smtp?.state] ?? 'slate'}>{t(`smtp.state.${data.smtp?.state ?? 'not_configured'}`)}</StatusPill></span>, content: <SmtpSettings canEdit={data.canEdit} onChanged={state.reload} /> },
        { id: 'history', label: t('tabs.history'), count: data.deliveries.length, content: <DeliveryHistory deliveries={data.deliveries} /> },
      ]} />
    </div>
  )
}

function EmailPreferences({ data, reload }) {
  const { t } = useTranslation('email')
  const toast = useToast()
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    setForm({ enabled: data.preferences.enabled, recipients: data.preferences.recipients.join('\n'), categories: data.preferences.categories, minLevel: data.preferences.minLevel })
  }, [data])
  if (!form) return null
  const canEdit = data.canEdit

  const save = async (e) => {
    e.preventDefault()
    setBusy('save'); setError('')
    try {
      await platform.saveEmailSettings({ ...form, recipients: form.recipients.split(/[\s,;]+/).filter(Boolean) })
      await reload()
      toast(t('prefs.saved'))
    } catch (err) { setError(err.message) } finally { setBusy('') }
  }
  const test = async () => {
    setBusy('test'); setError('')
    try {
      const { delivery } = await platform.testEmail()
      toast(delivery.mock ? t('prefs.testMock') : t('prefs.testSent'))
    } catch (err) { setError(err.message) } finally { setBusy(''); reload() }
  }

  return (
    <div className="space-y-3">
      {!canEdit && <Notice tone="info">{t('prefs.adminOnly')}</Notice>}
      <Card title={t('prefs.title')} subtitle={t('prefs.subtitle')}>
        <form onSubmit={save} className="space-y-3">
          <label className="flex items-center justify-between gap-3">
            <span><span className="block text-sm font-semibold text-navy">{t('prefs.send')}</span><span className="block text-xs text-slate-500">{t('prefs.sendHelp')}</span></span>
            <Switch label={t('prefs.send')} checked={form.enabled} disabled={!canEdit} onChange={(enabled) => setForm((f) => ({ ...f, enabled }))} />
          </label>
          <div className="grid gap-3 lg:grid-cols-2">
            <TextArea label={t('prefs.recipients')} hint={t('prefs.recipientsHint')} rows={3} value={form.recipients} disabled={!canEdit} onChange={(recipients) => setForm((f) => ({ ...f, recipients }))} dir="ltr" />
            <SelectInput label={t('prefs.minLevel')} placeholder={null} value={form.minLevel} disabled={!canEdit} onChange={(minLevel) => setForm((f) => ({ ...f, minLevel }))} options={[{ value: 'low', label: t('prefs.levelLow') }, { value: 'medium', label: t('prefs.levelMedium') }, { value: 'high', label: t('prefs.levelHigh') }]} />
          </div>
          <fieldset>
            <legend className="text-sm font-semibold text-navy">{t('prefs.categories')}</legend>
            <div className="mt-1 grid gap-x-4 sm:grid-cols-2 xl:grid-cols-3">
              {data.categories.map((c) => (
                <label key={c.id} className="flex min-h-9 cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" disabled={!canEdit} checked={form.categories[c.id] !== false} onChange={(e) => setForm((f) => ({ ...f, categories: { ...f.categories, [c.id]: e.target.checked } }))} />{c.label}
                </label>
              ))}
            </div>
          </fieldset>
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!canEdit || Boolean(busy)}>{busy === 'save' ? t('smtp.saving') : t('prefs.save')}</Button>
            <Button type="button" variant="secondary" disabled={!canEdit || Boolean(busy) || !data.preferences.recipients.length} onClick={test}><Icon name="mail" className="h-4 w-4" /> {busy === 'test' ? t('prefs.sending') : t('prefs.test')}</Button>
          </div>
          <p className="text-xs text-slate-500">{t('prefs.footnote')}</p>
        </form>
      </Card>
    </div>
  )
}

const emptySmtp = { host: '', port: '587', security: 'starttls', username: '', password: '', fromEmail: '', fromName: '', replyTo: '', clearPassword: false }

/**
 * Workspace SMTP. The saved password never comes back from the server: the form only knows
 * whether one exists. Saving, testing the connection, switching on and sending a test email
 * are separate steps with separate results.
 */
function SmtpSettings({ canEdit, onChanged }) {
  const { t } = useTranslation('email')
  const toast = useToast()
  const state = usePlatform(() => (canEdit ? platform.smtp() : Promise.resolve(null)), [canEdit])
  const [form, setForm] = useState(emptySmtp)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState(null)
  const [testTo, setTestTo] = useState('')
  const [confirmSend, setConfirmSend] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const smtp = state.data?.smtp
  // Fill the form from the saved configuration only when that configuration changes, so a failed
  // save or a status refresh never wipes what the administrator has typed.
  const savedKey = smtp ? JSON.stringify([smtp.settings, smtp.updatedAt]) : null
  useEffect(() => {
    if (!smtp) return
    const s = smtp.settings
    setForm(s ? { host: s.host, port: String(s.port), security: s.security, username: s.username ?? '', password: '', fromEmail: s.fromEmail, fromName: s.fromName ?? '', replyTo: s.replyTo ?? '', clearPassword: false } : emptySmtp)
  }, [savedKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!canEdit) return <Notice tone="info">{t('smtp.viewerNote')}</Notice>
  if (!smtp) return <Feedback state={state} />
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }))
  // Shared wrapper for every button: shows a busy state, reports errors, then refreshes the status.
  const run = async (kind, action) => {
    setBusy(kind); setMessage(null)
    try { await action() } catch (err) { setMessage({ tone: 'error', text: err.message }) } finally { setBusy('') }
    await state.reload()
    onChanged?.()
  }
  // Save: an empty password field keeps the saved password. The password is cleared from the form afterwards.
  const save = (e) => {
    e.preventDefault()
    return run('save', async () => {
      const body = { ...form, port: Number(form.port) }
      if (!body.password) delete body.password
      await platform.saveSmtp(body)
      setForm((f) => ({ ...f, password: '', clearPassword: false }))
      setMessage({ tone: 'success', text: t('smtp.saved') })
    })
  }
  // Test Connection: sign in to the server without sending anything.
  const verify = () => run('verify', async () => {
    const result = await platform.verifySmtp()
    setMessage({ tone: 'success', text: result.message })
  })
  const toggle = (enabled) => run('toggle', async () => {
    await platform.setSmtpEnabled(enabled)
    toast(enabled ? t('smtp.enabledToast') : t('smtp.disabledToast'))
  })
  // Send Test Email: one real message to one address, after the confirmation box is ticked.
  const sendTest = (e) => {
    e.preventDefault()
    return run('test', async () => {
      const { delivery } = await platform.testSmtp(testTo)
      setMessage({ tone: 'success', text: delivery.detail })
      setConfirmSend(false)
    })
  }
  const remove = () => run('remove', async () => {
    await platform.removeSmtp()
    setConfirmRemove(false)
    toast(t('smtp.removed'))
  })

  const configured = smtp.state !== 'not_configured'
  const fieldsDisabled = !smtp.allowed || Boolean(busy)
  const when = (iso) => (iso ? formatDateTime(iso) : t('smtp.never'))
  const securityOptions = [{ value: 'ssl', label: t('smtp.ssl') }, { value: 'starttls', label: t('smtp.starttls') }]
  if (smtp.policy.allowInsecure || form.security === 'none') securityOptions.push({ value: 'none', label: t('smtp.none') })
  // Picking a security mode also switches a standard port to the matching one (465 / 587); custom ports are kept.
  const changeSecurity = (security) => setForm((f) => ({ ...f, security, port: Object.values(DEFAULT_PORT).includes(Number(f.port)) ? String(DEFAULT_PORT[security]) : f.port }))

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <Card title={t('smtp.title')} subtitle={t('smtp.subtitle')} aside={<StatusPill tone={SMTP_TONE[smtp.state]}>{t(`smtp.state.${smtp.state}`)}</StatusPill>}>
        {!smtp.allowed && <Notice tone="warn" className="mb-3">{t('smtp.notAllowed')}</Notice>}
        {smtp.credentialStorage === 'temporary' && <Notice tone="warn" className="mb-3">{t('smtp.tempStorage')}</Notice>}
        {smtp.passwordReadable === false && <Notice tone="error" className="mb-3">{t('smtp.passwordUnreadable')}</Notice>}
        <form onSubmit={save} className="space-y-4" autoComplete="off" data-testid="smtp-form">
          <fieldset className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
            <legend className="mb-1 text-xs font-bold tracking-wide text-slate-500 uppercase">{t('smtp.server')}</legend>
            <TextInput label={t('smtp.host')} hint={t('smtp.hostHint')} value={form.host} onChange={set('host')} disabled={fieldsDisabled} required maxLength={253} dir="ltr" spellCheck={false} autoCapitalize="none" />
            <TextInput label={t('smtp.port')} value={form.port} onChange={set('port')} disabled={fieldsDisabled} required inputMode="numeric" pattern="[0-9]{1,5}" dir="ltr" />
            <SelectInput className="sm:col-span-2" label={t('smtp.security')} placeholder={null} value={form.security} disabled={fieldsDisabled} onChange={changeSecurity} options={securityOptions} />
          </fieldset>
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-1 text-xs font-bold tracking-wide text-slate-500 uppercase">{t('smtp.auth')}</legend>
            <TextInput label={t('smtp.username')} optional value={form.username} onChange={set('username')} disabled={fieldsDisabled} autoComplete="off" dir="ltr" spellCheck={false} autoCapitalize="none" maxLength={254} />
            <TextInput label={t('smtp.password')} type="password" value={form.password} onChange={set('password')} disabled={fieldsDisabled || form.clearPassword} autoComplete="new-password" dir="ltr" maxLength={512}
              hint={smtp.hasPassword ? t('smtp.passwordSaved') : undefined} placeholder={smtp.hasPassword ? '••••••••' : ''} />
            {smtp.hasPassword && (
              <label className="flex items-center gap-2 text-sm text-slate-600 sm:col-span-2">
                <input type="checkbox" checked={form.clearPassword} disabled={fieldsDisabled} onChange={(e) => setForm((f) => ({ ...f, clearPassword: e.target.checked, password: '' }))} />{t('smtp.clearPassword')}
              </label>
            )}
          </fieldset>
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-1 text-xs font-bold tracking-wide text-slate-500 uppercase">{t('smtp.sender')}</legend>
            <TextInput label={t('smtp.fromEmail')} type="email" value={form.fromEmail} onChange={set('fromEmail')} disabled={fieldsDisabled} required dir="ltr" maxLength={254} />
            <TextInput label={t('smtp.fromName')} optional value={form.fromName} onChange={set('fromName')} disabled={fieldsDisabled} maxLength={80} />
            <TextInput className="sm:col-span-2" label={t('smtp.replyTo')} optional type="email" value={form.replyTo} onChange={set('replyTo')} disabled={fieldsDisabled} dir="ltr" maxLength={254} />
          </fieldset>
          {message && <Notice tone={message.tone === 'success' ? 'good' : 'error'}>{message.text}</Notice>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={fieldsDisabled}>{busy === 'save' ? t('smtp.saving') : t('smtp.save')}</Button>
            <Button type="button" variant="secondary" disabled={fieldsDisabled || !configured} onClick={verify}>{busy === 'verify' ? t('smtp.verifying') : t('smtp.verify')}</Button>
            {configured && <Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={() => setConfirmRemove(true)}>{t('smtp.remove')}</Button>}
          </div>
          <p className="text-xs text-slate-500">{t('smtp.verifyNote')}</p>
        </form>
      </Card>

      <div className="space-y-3">
        <Card title={t('smtp.status')}>
          <label className="flex items-center justify-between gap-3">
            <span><span className="block text-sm font-semibold text-navy">{t('smtp.enable')}</span><span className="block text-xs text-slate-500">{t('smtp.enableHelp')}</span></span>
            <Switch label={t('smtp.enable')} checked={smtp.enabled} disabled={!smtp.allowed || Boolean(busy) || (!smtp.enabled && smtp.state !== 'verified')} onChange={toggle} />
          </label>
          <dl className="mt-3 space-y-1.5 text-sm" data-testid="smtp-status">
            <StatusRow label={t('smtp.lastVerified')} value={when(smtp.lastVerifiedAt)} />
            {smtp.lastVerification && <StatusRow label={t('smtp.lastCheck')} value={`${smtp.lastVerification.ok ? '✓' : '✕'} ${formatDateTime(smtp.lastVerification.at)}`} detail={smtp.lastVerification.ok ? null : smtp.lastVerification.message} />}
            <StatusRow label={t('smtp.lastDelivery')} value={smtp.lastDelivery ? `${smtp.lastDelivery.status === 'accepted' ? t('smtp.accepted') : t('smtp.failedShort')} · ${formatDateTime(smtp.lastDelivery.at)}` : t('smtp.noneYet')} />
            <StatusRow label={t('smtp.lastError')} value={smtp.lastDeliveryError ? formatDateTime(smtp.lastDeliveryError.at) : t('smtp.noneYet')} detail={smtp.lastDeliveryError?.message} />
          </dl>
          {smtp.hasPassword && <p className="mt-3 text-xs text-slate-500">{t('smtp.stored')}{smtp.passwordUpdatedAt ? ` · ${t('smtp.updated', { date: formatDateTime(smtp.passwordUpdatedAt) })}` : ''}</p>}
        </Card>
        <Card title={t('smtp.testTitle')} subtitle={t('smtp.testHelp')}>
          <form onSubmit={sendTest} className="space-y-2">
            <TextInput label={t('smtp.testTo')} type="email" value={testTo} onChange={setTestTo} disabled={!smtp.allowed || !configured || Boolean(busy)} required dir="ltr" maxLength={254} hint={configured ? undefined : t('smtp.testNeedsConfig')} />
            <label className="flex items-start gap-2 text-sm text-slate-600">
              <input type="checkbox" className="mt-1" checked={confirmSend} disabled={!configured} onChange={(e) => setConfirmSend(e.target.checked)} />{t('smtp.testConfirm')}
            </label>
            <Button type="submit" variant="secondary" disabled={!smtp.allowed || !configured || !confirmSend || !testTo || Boolean(busy)}><Icon name="mail" className="h-4 w-4" /> {busy === 'test' ? t('smtp.testSending') : t('smtp.testSend')}</Button>
          </form>
        </Card>
      </div>
      <ConfirmModal open={confirmRemove} title={t('smtp.remove')} confirmLabel={t('smtp.remove')} onConfirm={remove} onClose={() => setConfirmRemove(false)}>{t('smtp.removeConfirm')}</ConfirmModal>
    </div>
  )
}

function StatusRow({ label, value, detail }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-navy tabular-nums">{value}</dd>
      {detail && <dd className="w-full text-xs text-rose-700">{detail}</dd>}
    </div>
  )
}

function DeliveryHistory({ deliveries }) {
  const { t } = useTranslation('email')
  return (
    <Card title={t('history.title')} subtitle={t('history.subtitle')}>
      {deliveries.length ? (
        <BoundedList maxHeight="28rem" label={t('history.title')}>
          <ul className="divide-y divide-slate-100 text-sm">
            {deliveries.map((d) => (
              <li key={d.id} className="py-2">
                <p className="flex flex-wrap items-center gap-1.5">
                  <StatusPill tone={DELIVERY_TONE[d.status] ?? 'slate'}>{t(`history.status.${d.status}`, { defaultValue: d.status.replace(/_/g, ' ') })}</StatusPill>
                  {d.mock && <Badge tone="amber">{t('history.mock')}</Badge>}
                  {d.transport && <span className="text-xs text-slate-500" dir="ltr">{t('history.via', { kind: d.transport })}</span>}
                </p>
                <p className="mt-0.5 text-navy">{d.headline}</p>
                <p className="text-xs text-slate-500">{formatDateTime(d.at)}{d.destination ? ` · ${d.destination}` : ''}{d.detail ? ` · ${d.detail}` : ''}</p>
              </li>
            ))}
          </ul>
        </BoundedList>
      ) : <p className="text-sm text-slate-500">{t('history.empty')}</p>}
    </Card>
  )
}

export function LanguageTab() {
  const { t } = useTranslation()
  const { prefs, setLanguage } = useViewPrefs()
  const toast = useToast()
  return (
    <Card title={t('language.title')} subtitle={t('language.help')}>
      <fieldset>
        <legend className="sr-only">{t('language.title')}</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {LANGUAGES.map((l) => (
            <label key={l.code} lang={l.code} dir={l.dir} className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 ${prefs.language === l.code ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
              <input type="radio" name="language" value={l.code} checked={prefs.language === l.code} onChange={() => { setLanguage(l.code); toast(t('language.saved', { lng: l.code, name: l.native })) }} />
              <span><span className="block text-sm font-semibold text-navy">{l.native}</span><span className="block text-xs text-slate-500" lang="en" dir="ltr">{l.label}{l.dir === 'rtl' ? ' · RTL' : ''}</span></span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="mt-3 text-xs text-slate-500">{t('language.rtl')} {t('language.dataNote')}</p>
    </Card>
  )
}

const PROVIDERS = INTEGRATIONS.filter((i) => !i.llm)

export function IntegrationsSummary() {
  const state = usePlatform(() => platform.integrations())
  const rows = PROVIDERS.map((def) => ({ def, view: state.data?.integrations.find((i) => i.id === def.id) }))
  const connected = rows.filter((r) => r.view?.status === 'connected' && r.def.auth !== 'builtin').length
  return (
    <Card title="Connection status" subtitle="Verified by the server. Credentials are managed only on the Integrations page." aside={<Link to="/app/integrations" className="inline-flex h-9 items-center gap-1 rounded-xl bg-brand-700 px-3 text-sm font-semibold text-white">Open Integrations <Icon name="arrowRight" className="h-4 w-4 rtl:rotate-180" /></Link>}>
      {!state.data ? <Feedback state={state} /> : (
        <>
          <p className="mb-2 text-sm text-slate-600">{connected} external provider(s) connected.</p>
          <DataTable caption="Integration status" rowKey={(r) => r.def.id} rows={rows} columns={[
            { key: 'name', label: 'Provider', render: (r) => <span className="font-semibold text-navy">{r.def.name}</span> },
            { key: 'cat', label: 'Category', render: (r) => <span className="text-slate-600">{r.def.category}</span> },
            { key: 'status', label: 'Status', render: (r) => <StatusPill tone={STATUS[r.view?.status]?.tone ?? 'slate'}>{r.view?.statusLabel ?? STATUS[r.view?.status]?.label ?? 'Not connected'}</StatusPill> },
            { key: 'sync', label: 'Last sync', render: (r) => <span className="text-xs text-slate-500">{r.view?.lastSyncAt ? formatDateTime(r.view.lastSyncAt) : '—'}</span> },
            { key: 'manage', label: '', render: () => <Link to="/app/integrations" className="text-sm font-semibold text-brand-800 hover:underline">Manage</Link> },
          ]} />
        </>
      )}
    </Card>
  )
}
