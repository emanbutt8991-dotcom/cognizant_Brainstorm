// Report exports: translated headings and labels, honest handling of scripts the PDF fonts cannot draw,
// and a real PDF from the shared builder.
import { describe, expect, it } from 'vitest'
import i18n from 'i18next'
import common from '../src/i18n/resources/common.js'
import { DEFAULT_DISCLAIMER, localizeReport, pdfUnsupportedText, reportToHtml, reportToPdf } from '../src/services/pdf.js'

const report = {
  title: 'Risk simulation: Supplier delay',
  generatedAt: '2026-11-17T12:00:00.000Z',
  isDemo: true,
  context: { heading: 'Scenario (inputs used for this run)', lines: ['Supplier: Saigon Riverline Metalworks', 'Delay: 21 days'] },
  sections: [
    { heading: 'Executive summary', paragraphs: ['A 21-day delay adds about $48,000.'] },
    { heading: 'Analysis results', table: { head: ['Measure', 'Value'], rows: [['Total added cost', '$48,000'], ['CO₂e change', '+1.2 t']] } },
    { heading: 'Recommendations', bullets: ['Build safety stock → 30 days'] },
    { heading: 'Assumptions and limitations', bullets: ['Deterministic model'] },
  ],
  sources: [{ label: 'Company records', detail: 'Fictional demo data' }],
  disclaimer: DEFAULT_DISCLAIMER,
}

const tFor = async (lng) => {
  const inst = i18n.createInstance()
  await inst.init({ lng, fallbackLng: 'en', resources: Object.fromEntries(Object.entries(common).map(([k, v]) => [k, { common: v }])), defaultNS: 'common', interpolation: { escapeValue: false } })
  return inst.t.bind(inst)
}

describe('report localization', () => {
  it('translates standard headings and the disclaimer, and leaves content alone', async () => {
    const t = await tFor('fr')
    const out = localizeReport(report, t)
    expect(out.sections.map((s) => s.heading)).toEqual([common.fr.report.sections.summary, common.fr.report.analysis, common.fr.report.sections.recommendations, common.fr.report.sections.assumptions])
    expect(out.disclaimer).toBe(common.fr.report.disclaimer)
    expect(out.context.heading).toBe('Scenario (inputs used for this run)') // page-specific heading kept as written
    expect(out.sections[1].table).toEqual(report.sections[1].table)
    expect(report.sections[0].heading).toBe('Executive summary') // input not mutated
  })

  it('renders Arabic print HTML right-to-left with translated labels', async () => {
    const t = await tFor('ar')
    const html = reportToHtml(localizeReport(report, t), { lang: 'ar', dir: 'rtl', labels: { sources: common.ar.report.sourcesTitle }, locale: 'ar' })
    expect(html).toContain('<html lang="ar" dir="rtl">')
    expect(html).toContain(common.ar.report.sections.summary)
    expect(html).toContain(common.ar.report.sourcesTitle)
    expect(html).toContain('<bdi>$48,000</bdi>') // figures keep their own direction
  })

  it('detects text the Latin-1 PDF fonts would drop', async () => {
    expect(pdfUnsupportedText(report)).toBe(false) // CO₂, arrows and curly quotes are simplified, not dropped
    expect(pdfUnsupportedText({ ...report, sections: [{ heading: 'Suppliers', bullets: ['上海 Metals'] }] })).toBe(true)
    const hi = await tFor('hi')
    expect(pdfUnsupportedText(localizeReport(report, hi))).toBe(true) // so Hindi is not sent to the Latin PDF
  })

  it('builds a real PDF with translated Latin-script labels', async () => {
    const t = await tFor('es')
    const blob = await reportToPdf(localizeReport(report, t), { labels: { generated: 'Generado', preparedFor: 'Preparado para', sources: common.es.report.sourcesTitle, page: common.es.report.page, locale: 'es' } })
    const bytes = Buffer.from(await blob.arrayBuffer())
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF')
    expect(bytes.length).toBeGreaterThan(3000)
  })
})
