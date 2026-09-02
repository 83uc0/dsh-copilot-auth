export interface UsageClientState {
  readonly open: boolean
  readonly loading: boolean
  readonly snapshot?: Record<string, unknown>
}

export interface UsageStateStore {
  getSnapshot(): UsageClientState
  set(value: UsageClientState): void
}

export class UsageController {
  state: UsageClientState = { open: false, loading: true }
  readonly store: UsageStateStore
  timer?: ReturnType<typeof setInterval>

  constructor(store?: UsageStateStore) {
    this.store = store ?? { getSnapshot: () => this.state, set: (value) => { this.state = value } }
  }

  async poll(fetchFn: typeof fetch = fetch): Promise<void> {
    try {
      const response = await fetchFn('/github-copilot/usage', { headers: { Accept: 'application/json' } })
      if (!response.ok) return
      this.state = { ...this.state, loading: false, snapshot: await response.json() as Record<string, unknown> }
      this.store.set(this.state)
    } catch {
      this.state = { ...this.state, loading: false }
      this.store.set(this.state)
    }
  }

  start(): void { void this.poll(); this.timer = setInterval(() => void this.poll(), 15_000) }
  stop(): void { if (this.timer !== undefined) clearInterval(this.timer) }
  toggle(): void { this.state = { ...this.state, open: !this.state.open }; this.store.set(this.state); if (this.state.open) void this.poll() }
}