// Interface translations: every namespace is complete in all six languages, placeholders survive
// translation, and every literal key used by a screen exists (so no raw keys reach the UI).
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const RES = path.resolve('src/i18n/resources')
const LANGS = ['ar', 'en', 'es', 'fr', 'hi', 'zh-CN']
const namespaces = Object.fromEntries(await Promise.all(readdirSync(RES).filter((f) => f.endsWith('.js')).map(async (f) => [f.replace(/\.js$/, ''), (await import(/* @vite-ignore */ pathToFileURL(path.join(RES, f)).href)).default])))
const flat = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]))
const placeholders = (s) => (String(s).match(/{{\w+}}/g) ?? []).sort()

describe('translation resources', () => {
  it('has the new namespaces', () => {
    expect(Object.keys(namespaces)).toEqual(expect.arrayContaining(['common', 'email', 'pages']))
  })
  for (const [ns, langs] of Object.entries(namespaces)) {
    it(`${ns}: same keys, non-empty values and placeholders in all six languages`, () => {
      expect(Object.keys(langs).sort()).toEqual(LANGS)
      const en = Object.fromEntries(flat(langs.en))
      for (const lang of LANGS) {
        const entries = flat(langs[lang])
        expect([lang, entries.map(([k]) => k).sort()]).toEqual([lang, Object.keys(en).sort()])
        for (const [k, v] of entries) {
          expect([lang, k, typeof v === 'string' && v.trim().length > 0]).toEqual([lang, k, true])
          expect([lang, k, placeholders(v)]).toEqual([lang, k, placeholders(en[k])])
        }
      }
    })
  }
  it('actually translates the page chrome (not English copies)', () => {
    for (const ns of ['email', 'pages']) {
      const en = Object.fromEntries(flat(namespaces[ns].en))
      for (const lang of ['ar', 'hi', 'zh-CN']) {
        const same = flat(namespaces[ns][lang]).filter(([k, v]) => v === en[k] && /[a-z]{4}/.test(v) && !/^[A-Z0-9/ .()–-]+$/.test(v))
        expect([ns, lang, same.map(([k]) => k)]).toEqual([ns, lang, []])
      }
    }
  })
})

describe('keys used by screens', () => {
  const files = []
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).forEach((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : /\.jsx?$/.test(d.name) && files.push(path.join(dir, d.name))))
  walk(path.resolve('src/pages'))
  walk(path.resolve('src/components'))
  const has = (ns, key) => flat(namespaces[ns]?.en ?? {}).some(([k]) => k === key || k.startsWith(`${key}.`))

  it('every literal t()/tp()/tr() key exists in a namespace the file loads', () => {
    const missing = []
    let checked = 0
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      if (!/useTranslation\(/.test(src)) continue
      const loaded = new Set(['common', ...[...src.matchAll(/useTranslation\('([\w-]+)'\)/g)].map((m) => m[1])])
      for (const m of src.matchAll(/\b(?:t|tp|tr)\('([\w.:-]+)'/g)) {
        const [ns, key] = m[1].includes(':') ? m[1].split(':') : [null, m[1]]
        checked++
        const ok = ns ? has(ns, key) : [...loaded].some((n) => has(n, key))
        if (!ok) missing.push(`${path.relative(process.cwd(), file)}: ${m[1]}`)
      }
    }
    expect(missing).toEqual([])
    expect(checked).toBeGreaterThan(250)
  })
})
