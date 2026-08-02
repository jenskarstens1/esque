interface DemandWaiter<Value> {
  demand: number
  signal?: AbortSignal
  onAbort?: () => void
  resolve: (value: Value | null) => void
  reject: (reason: unknown) => void
}

interface DemandState<Value> {
  demand: number
  waiters: DemandWaiter<Value>[]
  controller: AbortController | null
}

interface DemandQueueOptions<Key, Value> {
  peek: (key: Key) => Value | null
  satisfies: (value: Value, demand: number) => boolean
  produce: (key: Key, demand: number, signal: AbortSignal) => Promise<Value | null>
  store: (value: Value) => void
}

const abortReason = (signal: AbortSignal) =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Decode no longer needed', 'AbortError')

/**
 * Coalesces increasing per-key demands into one active job and one latest job.
 *
 * A lower-resolution result is published as soon as it is ready. Requests that
 * need more stay queued, and any number of increases collapse into the largest
 * outstanding demand instead of starting parallel work for the same source.
 */
export function createDemandQueue<Key, Value>(options: DemandQueueOptions<Key, Value>) {
  const states = new Map<Key, DemandState<Value>>()

  const detach = (waiter: DemandWaiter<Value>) => {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
  }

  const resolveSatisfied = (state: DemandState<Value>, value: Value) => {
    const remaining: DemandWaiter<Value>[] = []
    for (const waiter of state.waiters) {
      if (options.satisfies(value, waiter.demand)) {
        detach(waiter)
        waiter.resolve(value)
      } else remaining.push(waiter)
    }
    state.waiters = remaining
  }

  const resolveAll = (state: DemandState<Value>, value: Value | null) => {
    for (const waiter of state.waiters) {
      detach(waiter)
      waiter.resolve(value)
    }
    state.waiters = []
  }

  const rejectAll = (state: DemandState<Value>, error: unknown) => {
    for (const waiter of state.waiters) {
      detach(waiter)
      waiter.reject(error)
    }
    state.waiters = []
  }

  const drain = async (key: Key, state: DemandState<Value>) => {
    try {
      while (state.waiters.length) {
        const cached = options.peek(key)
        if (cached) {
          resolveSatisfied(state, cached)
          if (!state.waiters.length) break
        }

        state.demand = Math.max(...state.waiters.map((waiter) => waiter.demand))
        const controller = new AbortController()
        state.controller = controller
        let value: Value | null
        try {
          value = await options.produce(key, state.demand, controller.signal)
        } catch (error) {
          state.controller = null
          // Every consumer of the active job went away. A waiter that arrived
          // while cancellation was propagating starts a fresh job instead of
          // inheriting the old AbortError.
          if (controller.signal.aborted && state.waiters.length) continue
          rejectAll(state, error)
          break
        }
        state.controller = null
        if (controller.signal.aborted) {
          if (state.waiters.length) continue
          break
        }
        if (!value) {
          resolveAll(state, null)
          break
        }

        options.store(value)
        const before = state.waiters.length
        resolveSatisfied(state, value)
        if (state.waiters.length === before) {
          // The producer reached its native ceiling; this is the best result it
          // can provide, so do not retry the same impossible demand forever.
          resolveAll(state, value)
        }
      }
    } catch (error) {
      rejectAll(state, error)
    } finally {
      state.controller = null
      if (states.get(key) === state) states.delete(key)
    }
  }

  return (key: Key, demand: number, signal?: AbortSignal): Promise<Value | null> => {
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    const cached = options.peek(key)
    if (cached && options.satisfies(cached, demand)) return Promise.resolve(cached)

    let state = states.get(key)
    const start = !state
    if (!state) {
      state = { demand, waiters: [], controller: null }
      states.set(key, state)
    } else {
      state.demand = Math.max(state.demand, demand)
    }

    const promise = new Promise<Value | null>((resolve, reject) => {
      const waiter: DemandWaiter<Value> = { demand, signal, resolve, reject }
      if (signal) {
        waiter.onAbort = () => {
          const index = state.waiters.indexOf(waiter)
          if (index === -1) return
          state.waiters.splice(index, 1)
          detach(waiter)
          reject(abortReason(signal))
          if (!state.waiters.length) {
            state.controller?.abort(new DOMException('Decode no longer needed', 'AbortError'))
          }
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      state.waiters.push(waiter)
      if (signal?.aborted) waiter.onAbort?.()
    })
    if (start) void drain(key, state)
    return promise
  }
}
