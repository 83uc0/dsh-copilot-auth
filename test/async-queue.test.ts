import { describe, expect, it } from 'vitest'
import { AsyncQueue } from '../src/async-queue.js'

describe('AsyncQueue', () => {
  it('delivers queued and awaited values and closes', async () => {
    const queue = new AsyncQueue<number>()
    queue.push(1)
    const iterator = queue[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: false, value: 1 })
    const pending = iterator.next()
    queue.push(2)
    expect(await pending).toEqual({ done: false, value: 2 })
    queue.close()
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
  })
})
