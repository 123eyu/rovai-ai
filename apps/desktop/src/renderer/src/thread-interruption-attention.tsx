import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { NotificationEpisodeChange, NotificationThreadInterruptions, StoredCommandResult } from '@contracts'
import { useThreadClient } from './camp-client'
import { newCommandId } from '../../shared/command-id'
import { uiAttribute } from './interface-language'

export const INTERRUPTION_FEEDBACK_MS = 600
const THREAD_BATCH_SIZE = 200
type Snapshot = { unread: boolean; sequence: number }
export type InterruptionReadIntent = { commandId: string; command: { threadId: string; observedThroughChangeSequence: number } }
type StopIntent = { commandId: string; threadId: string; conversationId: string | null }
type Pulse = { threadId: string; conversationId: string | null; episodeId: string; revision: number; until: number }
type Surface = { threadId: string | null; conversationId: string | null | undefined; visible: boolean }

/** Check whether the existing status slot can paint, including clipped/hidden sidebars.
 * An empty cluster may have zero width before the dot is inserted. */
export function interruptionSlotVisible(threadId: string): boolean {
  for (const row of document.querySelectorAll<HTMLElement>('.camp-nav-row[data-thread-id]')) {
    if (row.dataset.threadId !== threadId || row.closest('[inert], [hidden], [aria-hidden="true"]')) continue
    const cluster = row.querySelector<HTMLElement>('.camp-status-cluster')
    if (!cluster || getComputedStyle(cluster).visibility !== 'visible' || !row.getClientRects().length) continue
    let bounds = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth }
    for (let parent = row.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      if (style.display === 'none' || style.visibility !== 'visible' || style.opacity === '0') {
        bounds.bottom = bounds.top
        break
      }
      const rect = parent.getBoundingClientRect()
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        bounds = { ...bounds, top: Math.max(bounds.top, rect.top), bottom: Math.min(bounds.bottom, rect.bottom) }
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        bounds = { ...bounds, left: Math.max(bounds.left, rect.left), right: Math.min(bounds.right, rect.right) }
      }
    }
    const slot = cluster.getBoundingClientRect()
    const rect = { top: slot.top, bottom: slot.bottom, left: slot.width ? slot.left : slot.left - 12, right: slot.right }
    if (slot.height > 0 && bounds.bottom > bounds.top && bounds.right > bounds.left
      && rect.bottom > bounds.top && rect.top < bounds.bottom
      && rect.right > bounds.left && rect.left < bounds.right) return true
  }
  return false
}

const attentive = (): boolean => document.visibilityState === 'visible' && document.hasFocus()

export function useThreadInterruptionAttention(enabled: boolean, threadIds: string[], surface: Surface) {
  const client = useThreadClient()
  const idsKey = JSON.stringify([...new Set(threadIds)].sort())
  const scope = useRef({ enabled, key: idsKey, ids: threadIds, generation: 0 })
  const currentSurface = useRef(surface)
  currentSurface.current = surface
  const mounted = useRef(true)
  const running = useRef(false)
  const dirty = useRef(false)
  const floor = useRef(new Map<string, number>())
  const snapshotsRef = useRef<Record<string, Snapshot>>({})
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({})
  const stops = useRef(new Map<string, StopIntent>())
  const pulses = useRef(new Map<string, Pulse>())
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set())
  const frame = useRef<number | null>(null)
  const pendingReads = useRef(new Map<string, InterruptionReadIntent>())
  const inFlightReads = useRef(new Set<string>())

  const paint = useCallback((): void => {
    frame.current = null
    const now = performance.now()
    const active = currentSurface.current
    for (const [id, pulse] of pulses.current) {
      if (now >= pulse.until || !attentive() || !active.visible
        || active.threadId !== pulse.threadId || active.conversationId !== pulse.conversationId
        || !interruptionSlotVisible(pulse.threadId)) pulses.current.delete(id)
    }
    const next = new Set([...pulses.current.values()].map(pulse => pulse.threadId))
    setFlashing(previous => previous.size === next.size && [...next].every(id => previous.has(id)) ? previous : next)
    // Only the short visual lifetime schedules frames; it never schedules an ACK.
    if (pulses.current.size) frame.current = window.requestAnimationFrame(paint)
  }, [])

  const schedulePaint = useCallback((): void => {
    if (frame.current === null) frame.current = window.requestAnimationFrame(paint)
  }, [paint])

  const refresh = useCallback(async (): Promise<void> => {
    dirty.current = true
    if (running.current || !scope.current.enabled) return
    running.current = true
    try {
      while (dirty.current && mounted.current && scope.current.enabled) {
        dirty.current = false
        const captured = scope.current
        const batches: Promise<void>[] = []
        for (let at = 0; at < captured.ids.length; at += THREAD_BATCH_SIZE) {
          const threadIds = captured.ids.slice(at, at + THREAD_BATCH_SIZE)
          batches.push(client.request<NotificationThreadInterruptions>('notifications.threadInterruptions', { threadIds })
            .then(result => {
              if (!mounted.current || captured.generation !== scope.current.generation) return
              const next = { ...snapshotsRef.current }
              for (const thread of result.threads) {
                if (!threadIds.includes(thread.threadId)) continue
                if (result.throughChangeSequence < Math.max(floor.current.get(thread.threadId) ?? 0, next[thread.threadId]?.sequence ?? 0)) continue
                next[thread.threadId] = { unread: thread.hasUnreadInterruption, sequence: result.throughChangeSequence }
              }
              if (Object.entries(next).some(([id, value]) => value.unread !== snapshotsRef.current[id]?.unread
                || value.sequence !== snapshotsRef.current[id]?.sequence)) {
                snapshotsRef.current = next
                setSnapshots(next)
              }
            }).catch(() => {
              // Keep this batch's last proven state; other batches apply as
              // they arrive. Existing notification recovery/focus retries it.
            }))
        }
        // Coalesce refresh rounds only; receiving a batch never waits here.
        await Promise.all(batches)
      }
    } finally {
      running.current = false
    }
  }, [client])

  const acknowledge = useCallback(async (intent: InterruptionReadIntent): Promise<void> => {
    if (inFlightReads.current.has(intent.commandId)) return
    pendingReads.current.set(intent.commandId, intent)
    inFlightReads.current.add(intent.commandId)
    try {
      const result = await client.request<StoredCommandResult>('notifications.acknowledgeThreadInterruptions', intent)
      if (result.status !== 'applied') {
        pendingReads.current.delete(intent.commandId)
        throw new Error(uiAttribute('本机阅读状态已保存，但中断提醒未能标记已读，请重试。'))
      }
      pendingReads.current.delete(intent.commandId)
      const sequence = (result.payload as { resultingChangeSequence?: number })?.resultingChangeSequence
      if (typeof sequence === 'number') floor.current.set(intent.command.threadId, Math.max(floor.current.get(intent.command.threadId) ?? 0, sequence))
      await refresh()
    } catch (error) {
      if (pendingReads.current.has(intent.commandId)) {
        throw new Error(uiAttribute('本机阅读状态已保存，中断提醒的已读结果尚未确认，将继续核对。'))
      }
      throw error
    } finally {
      inFlightReads.current.delete(intent.commandId)
    }
  }, [client, refresh])

  const changes = useCallback((batch: NotificationEpisodeChange[], boundary: number): void => {
    const active = currentSurface.current
    for (const change of batch) {
      const source = change.interruptionAdmission
      const threadId = source?.threadId ?? change.episode?.thread.id
      if (threadId) floor.current.set(threadId, Math.max(floor.current.get(threadId) ?? 0, change.changeSequence))
      if (change.changeCause !== 'acknowledged') {
        for (const [id, pulse] of pulses.current) {
          const invalidation = change.headsUpInvalidation
          if (pulse.episodeId === change.episodeId && (change.operation === 'remove'
            || (invalidation?.kind === 'attention_cleared' && pulse.revision <= invalidation.throughAttentionRevision)
            || (invalidation?.kind === 'source_state_changed' && id === invalidation.acknowledgementId))) pulses.current.delete(id)
        }
      }
      if (!source || change.changeCause !== 'occurrence_admitted') continue
      const intent = stops.current.get(source.agentRunId)
      if (!intent) continue
      stops.current.delete(source.agentRunId)
      if (source.kind !== 'user_stop' || source.admittedChangeSequence > boundary
        || source.threadId !== intent.threadId || source.conversationId !== intent.conversationId
        || !active.visible || active.threadId !== source.threadId || active.conversationId !== source.conversationId
        || !attentive() || !interruptionSlotVisible(source.threadId)) continue
      pulses.current.set(source.acknowledgementId, { threadId: source.threadId, conversationId: source.conversationId,
        episodeId: change.episodeId, revision: change.attentionRevision, until: performance.now() + INTERRUPTION_FEEDBACK_MS })
    }
    schedulePaint()
    void refresh()
    // Retry only the frozen Core step; never repeat the local reminder write.
    for (const intent of pendingReads.current.values()) void acknowledge(intent).catch(() => undefined)
  }, [acknowledge, refresh, schedulePaint])

  const reset = useCallback((): void => {
    stops.current.clear()
    pulses.current.clear()
    floor.current.clear()
    scope.current = { ...scope.current, generation: scope.current.generation + 1 }
    snapshotsRef.current = {}
    setSnapshots({})
    schedulePaint()
    void refresh()
  }, [refresh, schedulePaint])

  const beginStop = useCallback((runId: string, intent: StopIntent): void => {
    if (!scope.current.enabled || !currentSurface.current.visible || !attentive()) return
    if (stops.current.get(runId)?.commandId === intent.commandId) return
    stops.current.set(runId, intent)
    if (stops.current.size > 64) stops.current.delete(stops.current.keys().next().value!)
  }, [])
  const rejectStop = useCallback((runId: string): void => { stops.current.delete(runId) }, [])
  const captureRead = useCallback((threadId: string): InterruptionReadIntent | null => {
    const snapshot = snapshotsRef.current[threadId]
    if (!snapshot) {
      void refresh()
      throw new Error(uiAttribute('提醒状态尚未加载，请稍后重试。'))
    }
    return snapshot.unread ? { commandId: newCommandId(), command: { threadId, observedThroughChangeSequence: snapshot.sequence } } : null
  }, [refresh])
  const committed = useCallback((threadId: string, sequence?: number): void => {
    if (sequence !== undefined) floor.current.set(threadId, Math.max(floor.current.get(threadId) ?? 0, sequence))
    void refresh()
  }, [refresh])

  useEffect(() => {
    const ids: string[] = JSON.parse(idsKey)
    scope.current = { enabled, ids, key: idsKey, generation: scope.current.generation + 1 }
    snapshotsRef.current = Object.fromEntries(Object.entries(snapshotsRef.current).filter(([id]) => ids.includes(id)))
    setSnapshots(snapshotsRef.current)
    floor.current = new Map([...floor.current].filter(([id]) => ids.includes(id)))
    if (enabled) void refresh()
  }, [enabled, idsKey, refresh])
  useEffect(() => {
    stops.current.clear()
    pulses.current.clear()
    schedulePaint()
  }, [surface.threadId, surface.conversationId, surface.visible, schedulePaint])
  useEffect(() => {
    mounted.current = true
    const visibility = (): void => {
      if (!attentive()) { stops.current.clear(); pulses.current.clear(); schedulePaint() }
    }
    window.addEventListener('blur', visibility)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      mounted.current = false
      window.removeEventListener('blur', visibility)
      document.removeEventListener('visibilitychange', visibility)
      if (frame.current !== null) window.cancelAnimationFrame(frame.current)
    }
  }, [schedulePaint])

  return useMemo(() => ({ snapshots, flashing, beginStop, rejectStop, captureRead, acknowledge, changes, reset, refresh, committed }),
    [snapshots, flashing, beginStop, rejectStop, captureRead, acknowledge, changes, reset, refresh, committed])
}

export const ThreadInterruptionAttentionContext = createContext<ReturnType<typeof useThreadInterruptionAttention> | null>(null)
export const useInterruptionAttention = () => useContext(ThreadInterruptionAttentionContext)
