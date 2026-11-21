// `orca plugin check` renders the panel once per scenario, with the worker on a fresh host.
import { defineCheck } from 'orca/testing'

const meta = () => ({ createdAt: Date.now() - 86_400_000, updatedAt: Date.now() - 86_400_000, lastUsedAt: null, short: false })

export default defineCheck({
  empty: { results: { 'secrets.protection': { status: 'os-keyring' } } },
  stored: {
    results: { 'secrets.protection': { status: 'os-keyring' } },
    secrets: { 'secret:STRIPE_API_KEY': 'sk_test_0123456789', 'secret:NPM_TOKEN': 'npm_0123456789' },
    storage: { index: { STRIPE_API_KEY: meta(), NPM_TOKEN: { ...meta(), lastUsedAt: Date.now() - 300_000 } } }
  },
  noKeyStore: { results: { 'secrets.protection': { status: 'unavailable' } } }
})
