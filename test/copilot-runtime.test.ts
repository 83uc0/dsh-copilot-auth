import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { memoizeAsync, resolveCliPath, toSdkTools, toSessionError } from '../src/copilot-runtime.js'

const CLI_NAME = process.platform === 'win32' ? 'copilot.cmd' : 'copilot'

describe('resolveCliPath', () => {
  const createdDirectories: string[] = []

  afterEach(() => {
    for (const directory of createdDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  function tempDirectoryWithExecutable(): string {
    const directory = mkdtempSync(join(tmpdir(), 'copilot-cli-test-'))
    createdDirectories.push(directory)
    const filePath = join(directory, CLI_NAME)
    writeFileSync(filePath, '#!/bin/sh\nexit 0\n')
    chmodSync(filePath, 0o755)
    return directory
  }

  it('returns an explicit path unchanged instead of searching PATH', () => {
    expect(resolveCliPath('/usr/local/bin/copilot', { PATH: '' })).toBe('/usr/local/bin/copilot')
    expect(resolveCliPath('./copilot', { PATH: '' })).toBe('./copilot')
  })

  it('resolves a bare command found on PATH to its absolute path', () => {
    const directory = tempDirectoryWithExecutable()
    expect(resolveCliPath('copilot', { PATH: directory })).toBe(join(directory, CLI_NAME))
  })

  it('returns undefined when the bare command is not found on PATH', () => {
    const directory = mkdtempSync(join(tmpdir(), 'copilot-cli-test-'))
    createdDirectories.push(directory)
    expect(resolveCliPath('copilot', { PATH: directory })).toBeUndefined()
  })

  it('returns undefined when PATH is unset so the caller can fall back to the bundled runtime', () => {
    expect(resolveCliPath('copilot', {})).toBeUndefined()
  })
})

describe('toSessionError', () => {
  it('surfaces the real message and classification hints instead of "Unknown GitHub Copilot error"', () => {
    const error = toSessionError({ errorType: 'authentication', message: 'Please sign in again', statusCode: 401 })
    expect(error.message).toBe('Please sign in again (authentication 401)')
  })

  it('appends only the hints that are present', () => {
    const error = toSessionError({ errorType: 'query', message: 'The request could not be completed' })
    expect(error.message).toBe('The request could not be completed (query)')
  })

  it('redacts secret-shaped content in the underlying message', () => {
    const error = toSessionError({ errorType: 'authorization', message: 'Rejected Bearer super-secret', statusCode: 403 })
    expect(error.message).not.toContain('super-secret')
  })
})

describe('toSdkTools', () => {
  it('overrides built-in tools so a same-named DSH tool (e.g. "bash") does not reject session creation', () => {
    const [tool] = toSdkTools([{ name: 'bash', description: 'Run a shell command', parameters: {} }])
    expect(tool).toMatchObject({
      name: 'bash',
      description: 'Run a shell command',
      skipPermission: true,
      defer: 'never',
      overridesBuiltInTool: true,
    })
  })
})

describe('memoizeAsync', () => {
  it('runs the factory only once for concurrent callers, closing the double-start race', async () => {
    let calls = 0
    let resolveFactory: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      resolveFactory = resolve
    })
    const memoized = memoizeAsync(() => {
      calls += 1
      return gate
    })

    const first = memoized.run()
    const second = memoized.run()
    resolveFactory()
    await Promise.all([first, second])

    expect(calls).toBe(1)
  })

  it('clears the cache on rejection so a later call retries', async () => {
    let calls = 0
    const memoized = memoizeAsync(() => {
      calls += 1
      return calls === 1 ? Promise.reject(new Error('transient')) : Promise.resolve()
    })

    await expect(memoized.run()).rejects.toThrow('transient')
    await expect(memoized.run()).resolves.toBeUndefined()
    expect(calls).toBe(2)
  })

  it('reset reports whether a cached attempt existed and clears it', async () => {
    const memoized = memoizeAsync(() => Promise.resolve())
    expect(memoized.reset()).toBe(false)

    await memoized.run()
    expect(memoized.reset()).toBe(true)
    expect(memoized.reset()).toBe(false)
  })
})
