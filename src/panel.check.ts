// `orca plugin check` renders the panel once per scenario, with the worker on a fresh host.
import { defineCheck } from 'orca/testing'

const meta = (exported: boolean) => ({ createdAt: Date.now() - 86_400_000, updatedAt: Date.now() - 86_400_000, lastUsedAt: null, exported, short: false })

export default defineCheck({
  empty: { results: { 'secrets.protection': { status: 'os-keyring' } } },
  stored: {
    results: { 'secrets.protection': { status: 'os-keyring' } },
    secrets: { 'secret:STRIPE_API_KEY': 'sk_test_0123456789', 'secret:NPM_TOKEN': 'npm_0123456789' },
    storage: { index: { STRIPE_API_KEY: meta(false), NPM_TOKEN: meta(true) } }
  },
  noKeyStore: { results: { 'secrets.protection': { status: 'unavailable' } } }
})
