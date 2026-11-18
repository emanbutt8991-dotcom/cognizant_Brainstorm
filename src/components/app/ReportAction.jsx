/*
  "Generate report" for any page with a completed analysis.

  The page passes `build`, a function returning a report object in the shared shape
  (see src/services/pdf.js). This component adds nothing to the content: it brands,
  exports and optionally saves what the page built. Pages without meaningful,
  completed results should not render it (or pass `disabled`).
*/
import { useState } from 'react'
import { languageOf, useTranslation } from '../../i18n/index.js'
import { DEFAULT_DISCLAIMER, localizeReport, pdfUnsupportedText, reportToHtml, reportToPdf } from '../../services/pdf.js'
import { reportBranding, useBranding } from '../../state/branding.js'
import { useWorkspace } from '../../state/WorkspaceContext.jsx'
import { Button, Icon } from '../ui.jsx'
import { Modal, Notice, downloadFile, useToast } from './kit.jsx'

// Languages the built-in PDF fonts can draw. Others use the browser's print view instead.
const LATIN = ['en', 'es', 'fr']
// A file name from the report title: "Q3 Risk / Summary" becomes "q3-risk-summary".
const safeName = (title) => String(title ?? 'waymark-report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'waymark-report'

/** Opens the print-ready HTML in a new tab; downloads it if pop-ups are blocked. */
export function openPrintView(html, title) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
  const win = window.open(url, '_blank', 'noopener')
  if (!win) downloadFile(`${safeName(title)}.html`, html, 'text/html;charset=utf-8')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export default function ReportAction({ build, label, disabled = false, saveable = true, size = 'sm', variant = 'secondary', className = '' }) {
  const { t, i18n } = useTranslation()
  const { ws, saveRecord, limit, counts } = useWorkspace()
  const branding = useBranding()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState(null)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState(null)
  const lang = languageOf(i18n.language)
  const brand = reportBranding(branding.data, ws?.company)

  // Builds the report from the page's current results and opens the export dialog.
  const start = () => {
    setMessage(null)
    try {
      const built = build()
      if (!built?.sections?.length) {
        toast(t('report.failed'), 'error')
        return
      }
      setReport({ generatedAt: new Date().toISOString(), sources: [], disclaimer: DEFAULT_DISCLAIMER, isDemo: Boolean(ws?.company?.isDemo), ...built })
      setOpen(true)
    } catch (err) {
      console.error('[report]', err)
      toast(t('report.failed'), 'error')
    }
  }

  const latin = LATIN.includes(lang.code)
  // Fixed labels printed on every report (date line, footer, page numbers) in the interface language.
  const labels = {
    generated: t('report.generatedAt', { date: '' }).trim(), preparedFor: t('report.preparedFor', { company: '' }).trim(), sources: t('report.sourcesTitle'),
    demo: t('report.demo'), confidential: t('report.confidential'), fictional: t('report.demo'), page: t('report.page', { page: '{{page}}', pages: '{{pages}}', interpolation: { skipOnVariables: true } }), locale: lang.locale,
  }
  // Latin-script languages get a translated PDF. Hindi, Arabic and Chinese get an explicitly English PDF, or the print view in their language.
  const pdfReport = report && (latin ? localizeReport(report, t) : report)
  const unsupported = Boolean(pdfReport && pdfUnsupportedText(pdfReport))

  // Downloads a PDF file: translated for Latin languages, clearly labelled English otherwise.
  const pdf = async () => {
    setBusy('pdf')
    try {
      const blob = await reportToPdf(pdfReport, { branding: brand, labels: latin ? labels : {} })
      downloadFile(`${safeName(report.title)}.pdf`, blob, 'application/pdf')
      setMessage({ tone: 'good', text: t('report.ready') })
    } catch (err) {
      console.error('[report]', err)
      setMessage({ tone: 'error', text: t('report.failed') })
    } finally {
      setBusy('')
    }
  }

  // Opens the print view, which renders every script correctly (the user chooses "Save as PDF").
  const print = () => {
    openPrintView(reportToHtml(localizeReport(report, t), { branding: brand, lang: lang.code, dir: lang.dir, labels, locale: lang.locale }), report.title)
  }

  // Keeps a copy under Reports, within the plan's saved-report limit.
  const save = async () => {
    setBusy('save')
    try {
      if (counts.reports >= limit('reports')) throw new Error('This plan’s saved-report limit has been reached. Delete a saved report or change plan.')
      await saveRecord('reports', { ...report, id: crypto.randomUUID(), savedAt: new Date().toISOString() })
      setMessage({ tone: 'good', text: t('report.saved') })
    } catch (err) {
      setMessage({ tone: 'error', text: err.message })
    } finally {
      setBusy('')
    }
  }

  return (
    <>
      <Button size={size} variant={variant} disabled={disabled} onClick={start} className={className} data-tour="generate-report">
        <Icon name="file" className="h-4 w-4" /> {label ?? t('report.generate')}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={t('report.generate')} footer={<Button variant="secondary" onClick={() => setOpen(false)}>{t('actions.close')}</Button>}>
        {report && (
          <div className="space-y-3">
            <div>
              <p className="font-semibold text-navy">{report.title}</p>
              <p className="text-xs text-slate-500">{t('report.preparedFor', { company: brand.displayName })} · {report.sections.length} section(s){report.isDemo ? ` · ${t('report.demo')}` : ''}</p>
            </div>
            <ul className="max-h-40 list-disc space-y-0.5 overflow-y-auto ps-5 text-sm text-slate-600">
              {report.sections.map((s, i) => <li key={i}>{s.heading}</li>)}
            </ul>
            {!latin && <Notice tone="info">{t('report.pdfLatinOnly', { language: lang.native })}</Notice>}
            {unsupported && <Notice tone="warn">{t('report.unsupported')}</Notice>}
            {lang.code !== 'en' && <p className="text-xs text-slate-500">{t('report.bodyNote')}</p>}
            <div className="flex flex-wrap gap-2">
              {latin ? (
                <>
                  <Button size="sm" onClick={pdf} disabled={Boolean(busy)}><Icon name="download" className="h-4 w-4" /> {busy === 'pdf' ? t('report.generating') : t('report.pdf')}</Button>
                  <Button size="sm" variant="secondary" onClick={print} disabled={Boolean(busy)}><Icon name="printer" className="h-4 w-4" /> {t('report.print')}</Button>
                </>
              ) : (
                <>
                  <Button size="sm" onClick={print} disabled={Boolean(busy)}><Icon name="printer" className="h-4 w-4" /> {t('report.printPdf', { language: lang.native })}</Button>
                  <Button size="sm" variant="secondary" onClick={pdf} disabled={Boolean(busy)}><Icon name="download" className="h-4 w-4" /> {busy === 'pdf' ? t('report.generating') : t('report.pdfEnglish')}</Button>
                </>
              )}
              {saveable && <Button size="sm" variant="secondary" onClick={save} disabled={Boolean(busy)}>{busy === 'save' ? t('actions.saving') : t('report.saveToReports')}</Button>}
            </div>
            {message && <Notice tone={message.tone}>{message.text}</Notice>}
          </div>
        )}
      </Modal>
    </>
  )
}
