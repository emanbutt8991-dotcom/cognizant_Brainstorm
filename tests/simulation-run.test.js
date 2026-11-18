// Risk Simulator consistency: results come only from the inputs captured when Run Simulation was pressed.
import { describe, expect, it } from 'vitest'
import { DEMO_COMPANIES } from '../src/data/demoCompanies.js'
import { FX_SNAPSHOT } from '../src/data/fxSnapshot.js'
import { buildModel } from '../src/engine/model.js'
import { computeRun, snapshotRun, staleness } from '../src/engine/simulationRun.js'
import { defaultParams, runScenario } from '../src/engine/simulator.js'

const fx = FX_SNAPSHOT
const setup = () => {
  const ws = DEMO_COMPANIES[0].build()
  const model = buildModel(ws, { fx })
  return { ws, model }
}
const ALT = { name: 'Alternative source', leadTimeDays: 21, premiumPct: 8, source: 'Planning assumption' }

describe('simulation run snapshots', () => {
  it('gives exactly the engine result for the captured inputs', () => {
    const { model } = setup()
    const params = defaultParams('supplier_delay', model)
    const snap = snapshotRun({ type: 'supplier_delay', params, name: 'Delay', alternative: ALT, altShare: 40, model })
    const direct = runScenario({ type: 'supplier_delay', params }, model, { alternative: ALT, altShare: 40 })
    expect(computeRun(snap)).toEqual(direct)
  })

  it('is not affected by edits to the form after the run', () => {
    const { model } = setup()
    const params = defaultParams('freight_price', model)
    const alternative = { ...ALT }
    const snap = snapshotRun({ type: 'freight_price', params, name: 'Freight', alternative, altShare: 40, model })
    const before = computeRun(snap)
    params.freightPct = 90 // the live form object changes
    alternative.premiumPct = 35
    expect(computeRun(snap)).toEqual(before)
    expect(Object.isFrozen(snap.params)).toBe(true)
  })

  it('keeps the alternative-source settings that were used (the reported defect)', () => {
    const { model } = setup()
    const params = defaultParams('supplier_shutdown', model)
    const snap = snapshotRun({ type: 'supplier_shutdown', params, name: 'Shutdown', alternative: ALT, altShare: 40, model })
    const shown = computeRun(snap)
    // Previously the page recomputed with the live slider values; a different volume changes the result.
    const withNewSlider = runScenario({ type: 'supplier_shutdown', params }, model, { alternative: ALT, altShare: 100 })
    expect(withNewSlider.strategies).not.toEqual(shown.strategies)
    expect(computeRun(snap).strategies).toEqual(shown.strategies)
    expect(staleness(snap, { type: 'supplier_shutdown', params, name: 'Shutdown', alternative: ALT, altShare: 100, model })).toEqual({ stale: true, reasons: ['alternative'] })
  })

  it('keeps the cost per shortfall day that was used, and reports the data change', () => {
    const { ws, model } = setup()
    const params = defaultParams('supplier_delay', model)
    const snap = snapshotRun({ type: 'supplier_delay', params, name: 'Delay', alternative: ALT, altShare: 40, model })
    const shown = computeRun(snap)
    const edited = buildModel({ ...ws, company: { ...ws.company, operations: { ...ws.company.operations, dailyShortfallCost: 0 } } }, { fx })
    expect(runScenario({ type: 'supplier_delay', params }, edited, { alternative: ALT, altShare: 40 }).shortageCost).toBe(0)
    expect(computeRun(snap)).toEqual(shown)
    expect(staleness(snap, { type: 'supplier_delay', params, name: 'Delay', alternative: ALT, altShare: 40, model: edited }).reasons).toEqual(['data'])
  })

  it('reports no change for identical inputs and names each changed group', () => {
    const { model } = setup()
    const params = defaultParams('tariff', model)
    const snap = snapshotRun({ type: 'tariff', params, name: 'Tariff', alternative: ALT, altShare: 40, model })
    const same = { type: 'tariff', params: { ...params }, name: 'Tariff', alternative: { ...ALT }, altShare: 40, model }
    expect(staleness(snap, same)).toEqual({ stale: false, reasons: [] })
    expect(staleness(snap, { ...same, params: { ...params, ratePct: 25 } }).reasons).toEqual(['scenario'])
    expect(staleness(snap, { ...same, type: 'freight_price' }).reasons).toEqual(['scenario'])
    expect(staleness(snap, { ...same, params: { ...params, ratePct: 25 }, altShare: 60 }).reasons).toEqual(['scenario', 'alternative'])
    expect(staleness(null, same)).toEqual({ stale: false, reasons: [] })
  })

  it('returns nothing for a workspace without suppliers', () => {
    const { ws } = setup()
    const empty = buildModel({ ...ws, suppliers: [], shipments: [] }, { fx })
    expect(computeRun(snapshotRun({ type: 'tariff', params: { countryCode: 'VN', ratePct: 10 }, name: 'x', alternative: ALT, altShare: 40, model: empty }))).toBeNull()
  })
})
