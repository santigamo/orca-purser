// `orca plugin check` renders the panel once per scenario, with the worker on a fresh host.
import { defineCheck } from 'orca/testing'

const day = 86_400_000
const meta = (name: string, project: { key: string; name: string } | null = null, lastUsedAt: number | null = null) => ({
  name,
  project,
  createdAt: Date.now() - day,
  updatedAt: Date.now() - day,
  lastUsedAt,
  short: false
})
const clientA = { key: '/work/client-a', name: 'client-a' }
const keyring = { 'secrets.protection': { status: 'os-keyring' } }

export default defineCheck({
  empty: { results: keyring },
  stored: {
    results: keyring,
    secrets: {
      'secret:NPM_TOKEN': 'npm_0123456789',
      'secret:STRIPE_API_KEY': 'sk_test_0123456789',
      'secret:p:a:STRIPE_API_KEY': 'sk_test_client_a'
    },
    storage: {
      index: {
        NPM_TOKEN: meta('NPM_TOKEN', null, Date.now() - 300_000),
        STRIPE_API_KEY: meta('STRIPE_API_KEY'),
        'p:a:STRIPE_API_KEY': meta('STRIPE_API_KEY', clientA)
      }
    }
  },
  noKeyStore: { results: { 'secrets.protection': { status: 'unavailable' } } }
})
