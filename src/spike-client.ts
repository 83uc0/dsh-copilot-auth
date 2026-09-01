type SlotProps = Record<string, unknown>

const SPIKE_ROUTE = '/llm-github-copilot-spike/status'

function safePropNames(props: SlotProps): string[] {
  return Object.keys(props).sort()
}

function messageIdentity(props: SlotProps): { messageId: boolean; seq: boolean } {
  return {
    messageId: 'messageId' in props || 'id' in props,
    seq: 'seq' in props,
  }
}

function SpikeLabel(props: SlotProps): string {
  const names = safePropNames(props)
  const identity = messageIdentity(props)
  console.info('[github-copilot client spike]', {
    slot: props.slot,
    props: names,
    messageId: identity.messageId,
    seq: identity.seq,
  })
  return `client spike ${String(props.slot ?? 'unknown')}`
}

export const inject = ['slots', 'locale']

export function apply(ctx: {
  slots: {
    inject: (slot: string, factory: () => unknown) => void
    register: (definition: Record<string, unknown>, component: typeof SpikeLabel) => unknown
  }
  locale: { register: (namespace: string, dictionaries: Record<string, unknown>) => unknown }
}): void {
  void fetch(SPIKE_ROUTE).then(async (response) => {
    const body = await response.json() as { schemaVersion?: unknown; loaded?: unknown }
    console.info('[github-copilot client spike]', {
      route: SPIKE_ROUTE,
      schemaVersion: body.schemaVersion,
      loaded: body.loaded === true,
    })
  }).catch(() => {
    console.info('[github-copilot client spike]', { route: SPIKE_ROUTE, available: false })
  })
  ctx.locale.register('githubCopilotClientSpike', { en: { label: 'Client spike' } })
  for (const name of ['conversation.input.right', 'conversation.chat.turnTail']) {
    ctx.slots.inject(name, () => ctx.slots.register({
      name,
      id: `github-copilot-client-spike-${name.replaceAll('.', '-')}`,
      locale: 'githubCopilotClientSpike',
    }, SpikeLabel))
  }
}