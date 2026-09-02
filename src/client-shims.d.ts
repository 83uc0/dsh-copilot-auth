declare module 'react/jsx-runtime' {
  export const jsx: (...args: any[]) => any
  export const jsxs: (...args: any[]) => any
}

declare module 'react' {
  export type ReactElement = any
  export type ReactNode = any
  export function useState<T>(initial: T): [T, (value: T) => void]
  export function useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]): void
  const React: { useEffect: typeof useEffect }
  export default React
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  export function createSnapshotStore<T>(initial: T): { getSnapshot(): T; set(value: T): void; use(selector: (value: T) => T): T }
}