// Workspace feature visibility is stored on the server per tenant, validated, and readable by members.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../server/app.js'
import { loadConfig } from '../server/config.js'

let server, base
beforeAll(async () => {
  const app = createApp({ ...loadConfig({}), dataDir: '', rateLimitPerMinute: 10000 })
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  base = `http://127.0.0.1:${server.address().port}/api/settings`
})
afterAll(() => server.close())

const as = (key) => ({ 'Content-Type': 'application/json', 'X-Waymark-Workspace': key })
const A = 'workspace-settings-test-key-aaaaaaaa'
const B = 'workspace-settings-test-key-bbbbbbbb'

describe('workspace feature visibility', () => {
  it('saves known-shaped flags, ignores junk, and keeps tenants apart', async () => {
    const saved = await fetch(base, { method: 'PUT', headers: as(A), body: JSON.stringify({ features: { finance: false, analyst: true, 'bad key': true, inventory: 'yes' } }) })
    expect(saved.status).toBe(200)
    const a = await (await fetch(base, { headers: as(A) })).json()
    expect(a.settings.features).toEqual({ finance: false, analyst: true })
    expect(a.settings.featuresUpdatedAt).toBeTruthy()
    expect(a.canEdit).toBe(true)
    const b = await (await fetch(base, { headers: as(B) })).json()
    expect(b.settings.features).toEqual({})
  })

  it('merges later changes instead of replacing the map', async () => {
    await fetch(base, { method: 'PUT', headers: as(A), body: JSON.stringify({ features: { map: false } }) })
    const a = await (await fetch(base, { headers: as(A) })).json()
    expect(a.settings.features).toEqual({ finance: false, analyst: true, map: false })
  })

  it('needs a workspace', async () => {
    expect((await fetch(base)).status).toBe(400)
  })
})
