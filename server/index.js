/*
  Starts the Waymark API (default http://localhost:8787).
  Reads secrets from a local .env if there is one, then prints which optional services are set up,
  so it is easy to see at a glance what is live and what is using a fallback.
*/
import { existsSync } from 'node:fs'
import { createApp } from './app.js'
import { loadConfig } from './config.js'

// Load .env (git-ignored) into process.env before reading the configuration.
if (existsSync('.env')) process.loadEnvFile('.env')

const config = loadConfig()
createApp(config).listen(config.port, () => {
  console.log(`Waymark API on http://localhost:${config.port}`)
  console.log(`  Climatiq: ${config.climatiqKey ? 'configured' : 'not configured (estimate-only fallback)'}`)
  console.log(`  Supabase: ${config.supabaseUrl ? 'configured' : 'not configured (local mode)'}`)
  console.log(`  AI explanations: ${config.anthropicKey ? 'configured' : 'not configured (rule-based)'}`)
  console.log(`  AI assistant (Delay Assist, Trade Analyst): ${config.llmApiKey || config.llmFallbackApiKey || config.anthropicKey ? 'configured' : 'not configured (rules and templates)'}`)
})
