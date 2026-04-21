import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['components/**/__tests__/**/*.test.{ts,tsx}', 'app/**/__tests__/**/*.test.{ts,tsx}'],
    // Legacy node:test-based tests under components/tuning/__tests__ predate
    // this harness; they run via `tsx --test` independently. Excluded here so
    // vitest doesn't flag them as missing-suite failures.
    exclude: ['**/node_modules/**', 'components/tuning/__tests__/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
})
