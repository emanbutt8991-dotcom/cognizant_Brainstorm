// Unit tests: every tests/*.test.js file runs in Node. `npm test` also runs the scripts/ checks.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 30_000,
  },
})
