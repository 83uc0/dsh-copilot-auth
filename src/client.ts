import { jsx, jsxs } from 'react/jsx-runtime'
import * as React from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

const NS = 'githubCopilotUsage'
const en = { label: 'Usage', title: 'GitHub Copilot usage', empty: 'No data yet', loading: 'Loading...', error: 'Unavailable', disabled: 'Tracking disabled', last: 'Last response', requested: 'Requested', used: 'Used', session: 'Session', month: 'This month', input: 'Input', cached: 'Cached', cacheWrite: 'Cache write', output: 'Output', duration: 'Duration', ttft: 'TTFT', nano: 'Raw nano-AIU', estimate: 'Local estimate', billing: 'Official billing', allocation: 'Allocation', details: 'Details', hideDetails: 'Hide details', uncalibrated: 'ESTIMATED', unavailable: 'Unavailable' }
const zh = { label: '用量', title: 'GitHub Copilot 用量', empty: '暂无数据', loading: '加载中...', error: '不可用', disabled: '跟踪已禁用', last: '最近响应', requested: '请求模型', used: '实际模型', session: '会话', month: '本月', input: '输入', cached: '缓存读取', cacheWrite: '缓存写入', output: '输出', duration: '耗时', ttft: '首字延迟', nano: '原始 nano-AIU', estimate: '本地估算', billing: '官方账单', allocation: '配额', details: '详情', hideDetails: '收起详情', uncalibrated: 'ESTIMATED', unavailable: '不可用' }

type ClientState = { open: boolean; loading: boolean; snapshot?: Record<string, unknown> }

class UsageController {
  state: ClientState = { open: false, loading: true }
  timer?: ReturnType<typeof setInterval>
  constructor(readonly store: { getSnapshot(): ClientState; set(value: ClientState): void; use(selector: (state: ClientState) => ClientState): ClientState }) {}
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

const controller = new UsageController(createSnapshotStore<ClientState>({ open: false, loading: true }))
function number(value: unknown): string { return typeof value === 'number' ? value.toLocaleString() : '-' }
function money(value: unknown): string { return typeof value === 'number' ? `$${value.toFixed(4)}` : '-' }
function Row({ label, value }: { label: string; value: unknown }): React.ReactElement { return jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 5, fontSize: 11 }, children: [jsx('span', { style: { color: 'var(--dsw-alias-label-tertiary)' }, children: label }), jsx('strong', { style: { color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }, children: typeof value === 'string' ? value : number(value) })] }) }
function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement { return jsxs('section', { style: { borderTop: '1px solid var(--dsw-alias-border-l2)', marginTop: 10, paddingTop: 9 }, children: [jsx('h3', { style: { margin: 0, fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', textTransform: 'uppercase' }, children: title }), children] }) }
function UsageBadge({ t, useCopilotUsage, start, stop, toggle }: { t: (key: string) => string; useCopilotUsage: (selector: (state: ClientState) => ClientState) => ClientState; start: () => void; stop: () => void; toggle: () => void }): React.ReactElement {
  const state = useCopilotUsage((snapshot) => snapshot)
  const [detailsOpen, setDetailsOpen] = React.useState(false)
  React.useEffect(() => { start(); return () => stop() }, [])
  const snapshot = state.snapshot as any
  const response = snapshot?.response
  const call = response?.calls?.at(-1)
  const statusColor = response?.status === 'OFFICIAL' ? '#35b879' : response?.status === 'UNCALIBRATED' ? '#e0a83e' : '#8293a6'
  const detail = response === null ? jsx('p', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }, children: t('empty') }) : response === undefined ? jsx('p', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }, children: t('error') }) : jsxs('div', { children: [jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 8 }, children: [jsx('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: response.text ?? '-' }), jsx('b', { style: { color: statusColor, fontSize: 10 }, children: response.status })] }), jsx(Row, { label: t('requested'), value: response.requestedModel }), jsx(Row, { label: t('used'), value: response.model ?? call?.model }), response.estimatedCredits === undefined ? null : jsx(Row, { label: t('estimate'), value: `${number(response.estimatedCredits)} credits (${money(response.estimatedUsd)})` }), detailsOpen && (call === undefined ? null : jsxs('div', { style: { marginTop: 8 }, children: [jsx(Row, { label: t('input'), value: call.inputTokens }), jsx(Row, { label: t('cached'), value: call.cachedTokens }), jsx(Row, { label: t('cacheWrite'), value: call.cacheWriteTokens }), jsx(Row, { label: t('output'), value: call.outputTokens }), jsx(Row, { label: t('duration'), value: call.durationMs === undefined ? '-' : `${number(call.durationMs)} ms` }), jsx(Row, { label: t('ttft'), value: call.ttftMs === undefined ? '-' : `${number(call.ttftMs)} ms` }), response.nanoAiu === undefined ? null : jsx(Row, { label: t('nano'), value: response.nanoAiu })] }))] })
  const panel = state.loading ? t('loading') : snapshot?.enabled === false ? t('disabled') : jsxs('div', { children: [jsx('h2', { style: { margin: 0, fontSize: 14, color: 'var(--dsw-alias-label-primary)' }, children: t('title') }), jsx(Section, { title: t('last'), children: detail }), jsx('button', { type: 'button', onClick: () => setDetailsOpen(!detailsOpen), style: { marginTop: 10, padding: '4px 8px', fontSize: 11 }, children: detailsOpen ? t('hideDetails') : t('details') }), snapshot?.session === undefined ? null : jsx(Section, { title: t('session'), children: jsxs('div', { children: [jsx(Row, { label: t('output'), value: snapshot.session.modelCalls === 0 ? '-' : `${number(snapshot.session.modelCalls)} calls` }), jsx(Row, { label: t('estimate'), value: `${number(snapshot.session.estimatedCredits)} credits (${money(snapshot.session.estimatedUsd)})` })] }) }), snapshot?.month === null ? null : jsx(Section, { title: t('month'), children: jsxs('div', { children: [jsx(Row, { label: t('output'), value: `${number(snapshot.month?.modelCalls)} calls` }), jsx(Row, { label: t('estimate'), value: `${number(snapshot.month?.estimatedCredits)} credits (${money(snapshot.month?.estimatedUsd)})` }), snapshot?.allocationCredits === undefined ? null : jsx(Row, { label: t('allocation'), value: `${number(snapshot.allocationPercent)}% / ${number(snapshot.allocationCredits)} credits` })] }) }), jsx(Section, { title: t('billing'), children: jsx(Row, { label: t('billing'), value: t('unavailable') }) }), snapshot?.calibration !== 'calibrated' ? jsx('p', { style: { margin: '10px 0 0', fontSize: 11, color: '#d7a337' }, children: t('uncalibrated') }) : null] })
  return jsxs('span', { style: { position: 'relative', display: 'inline-flex' }, children: [jsx('button', { type: 'button', title: t('title'), onClick: toggle, style: { fontVariantNumeric: 'tabular-nums' }, children: response?.status === 'UNCALIBRATED' ? t('uncalibrated') : response?.status ?? t('label') }), !state.open ? null : jsx('div', { style: { position: 'fixed', zIndex: 220, right: 16, bottom: 64, width: 360, maxWidth: 'calc(100vw - 32px)', maxHeight: 'min(520px, calc(100vh - 96px))', overflowY: 'auto', padding: 14, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2))', boxShadow: '0 12px 32px rgba(0,0,0,.28)' }, children: panel })] })
}
export const inject = ['slots', 'locale']
export function apply(ctx: any): void {
  ctx.locale.register(NS, { en, zh })
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'github-copilot-usage',
    order: 60,
    locale: NS,
    inject: () => ({ hooks: { copilotUsage: controller.store }, start: () => controller.start(), stop: () => controller.stop(), toggle: () => controller.toggle() }),
  }, UsageBadge))
}