import { describe, it } from 'vitest'

const enabled = process.env.COPILOT_INTEGRATION === '1'

describe.skipIf(!enabled)('real GitHub Copilot integration', () => {
  it('is intentionally opt-in and requires an already authenticated official Copilot CLI', async () => {
    const { OfficialCopilotRuntime } = await import('../src/copilot-runtime.js')
    const runtime = new OfficialCopilotRuntime(process.cwd())
    try {
      const status = await runtime.getAuthStatus()
      if (!status.isAuthenticated) throw new Error('Run copilot login before COPILOT_INTEGRATION=1 pnpm test')
      const models = await runtime.listModels()
      if (models.length === 0) throw new Error('Authenticated account returned no enabled Copilot models')
    } finally {
      await runtime.stop()
    }
  })
})
