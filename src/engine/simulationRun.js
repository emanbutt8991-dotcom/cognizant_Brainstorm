/*
  A Risk Simulator run is a snapshot. Everything the engine reads is captured when Run Simulation
  is pressed: the scenario type and parameters, the alternative-source settings, and the workspace
  model (which carries the cost per shortfall day, buffers and spend). Results are computed only
  from that snapshot, so later edits cannot silently change figures shown as an earlier run.

  When the current inputs differ from the snapshot, `staleness` says which group changed, and the
  screen marks the results as out of date until the user runs again. The engine (runScenario) and
  its formulas are unchanged.
*/
import { runScenario } from './simulator.js'

const copy = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)))
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Freezes the inputs of one run. `model` is kept by reference: the workspace rebuilds it on any edit. */
export function snapshotRun({ type, params, name, custom = false, alternative, altShare, model, at = new Date().toISOString() }) {
  return Object.freeze({
    type,
    params: Object.freeze(copy(params)),
    name,
    custom,
    alternative: Object.freeze(copy(alternative)),
    altShare: Number(altShare),
    model,
    at,
  })
}

/** The engine result for a snapshot. Pure: the same snapshot always gives the same figures. */
export function computeRun(snapshot) {
  if (!snapshot?.model?.suppliers?.length) return null
  return runScenario({ type: snapshot.type, params: copy(snapshot.params) }, snapshot.model, { alternative: copy(snapshot.alternative), altShare: snapshot.altShare })
}

/**
 * What changed since the snapshot.
 *   scenario     type, parameters, custom flag or name
 *   alternative  alternative source, volume moved or price difference
 *   data         workspace records (for example the cost per shortfall day)
 */
export function staleness(snapshot, current) {
  if (!snapshot) return { stale: false, reasons: [] }
  const reasons = []
  if (snapshot.type !== current.type || !same(snapshot.params, current.params) || Boolean(snapshot.custom) !== Boolean(current.custom) || (current.name != null && snapshot.name !== current.name)) reasons.push('scenario')
  if (!same(snapshot.alternative, current.alternative) || snapshot.altShare !== Number(current.altShare)) reasons.push('alternative')
  if (current.model && snapshot.model !== current.model) reasons.push('data')
  return { stale: reasons.length > 0, reasons }
}
