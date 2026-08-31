import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/index.js'

describe('Cordis plugin lifecycle', () => {
  it('does not wait for the optional authorization service', () => {
    expect(inject).toEqual(['llm', 'credentials', 'commands'])
  })

  it('registers and reversibly unloads the route, flow, commands, and lazy runtime', async () => {
    const registrations: string[] = []
    const disposals: string[] = []
    const effects: Array<() => void | Promise<void>> = []
    const record = (name: string): (() => void) => {
      registrations.push(name)
      return () => disposals.push(name)
    }
    const authorization = { registerFlow: () => record('authorization') }
    const context = {
      get: (service: string) => service === 'authorization' ? authorization : undefined,
      llm: {
        registerAdapter: (providers: string[]) => {
          expect(providers).toEqual(['github-copilot'])
          const dispose = record('adapter') as (() => void) & { replace(providers: string[]): void }
          dispose.replace = () => {}
          return dispose
        },
      },
      credentials: {},
      authorization,
      commands: { register: (definition: { name: string }) => record(`command:${definition.name}`) },
      effect: (factory: () => Generator<unknown, void, unknown>) => {
        for (const effect of factory()) effects.push(effect as () => void | Promise<void>)
      },
    } as unknown as Context

    apply(context)
    expect(registrations).toEqual([
      'adapter',
      'authorization',
      'command:login',
      'command:logout',
      'command:copilot-status',
    ])

    for (const dispose of effects.reverse()) await dispose()
    expect(disposals).toEqual([
      'command:copilot-status',
      'command:logout',
      'command:login',
      'authorization',
      'adapter',
    ])
  })
})
