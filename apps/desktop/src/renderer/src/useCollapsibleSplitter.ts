import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { prefersReducedMotion } from './reduced-motion'

const COLLAPSE_TRAVEL = 64
const COLLAPSE_MS = 160

export type SplitterPhase = 'idle' | 'dragging' | 'detent' | 'armed' | 'preparing' | 'closing' | 'collapsed'

interface SplitterOptions<Snapshot> {
  size: number
  collapsed: boolean
  minimum: number
  maximum: number
  collapsedSize?: number
  expandAt?: number
  axis?: 'x' | 'y'
  direction: 1 | -1
  disabled?: boolean
  /** A page/selection change invalidates pending frames and async save results. */
  scopeKey?: string | number | null
  readSize?(): number
  scale?(): number
  capture(): Snapshot
  onPreview(size: number): void
  onCommit(size: number): void
  /** Omit for a boundary that resizes without folding. */
  onCollapse?(snapshot: Snapshot): void
  onCancel(snapshot: Snapshot): void
  onActiveChange?(active: boolean): void
  /** May paint below the expanded minimum without changing the saved preference. */
  onCollapseFrame?(size: number): void
  prepareCollapse?(): boolean | Promise<boolean>
}

interface Gesture<Snapshot> {
  pointerId: number
  target: HTMLDivElement
  coordinate: number
  size: number
  scale: number
  raw: number
  snapshot: Snapshot
  phase: SplitterPhase
  generation: number
  released: boolean
  moved: boolean
}

/** Convert CSS zoom / transformed layout pixels to pointer coordinates once per gesture. */
export function splitterScale(element: HTMLElement | null, axis: 'x' | 'y' = 'x'): number {
  if (!element) return 1
  const rect = element.getBoundingClientRect()
  const scale = axis === 'x' ? rect.width / element.offsetWidth : rect.height / element.offsetHeight
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

/** Minimum widths are stable stops; further inward travel arms a fold committed on release. */
export function useCollapsibleSplitter<Snapshot>(options: SplitterOptions<Snapshot>) {
  const latest = useRef(options)
  latest.current = options
  const gesture = useRef<Gesture<Snapshot> | null>(null)
  const frame = useRef<number | null>(null)
  const [phase, setPhase] = useState<SplitterPhase>('idle')

  const clearPending = useCallback((): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
  }, [])

  const release = useCallback((): void => {
    const active = gesture.current
    gesture.current = null
    clearPending()
    if (!active) return
    active.generation++
    delete active.target.dataset.foldState
    delete active.target.dataset.resizing
    if (active.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId)
    latest.current.onActiveChange?.(false)
    setPhase('idle')
  }, [clearPending])

  const cancel = useCallback((): void => {
    const active = gesture.current
    if (!active) return
    latest.current.onCancel(active.snapshot)
    release()
  }, [release])

  const changePhase = (active: Gesture<Snapshot>, next: SplitterPhase): void => {
    active.phase = next
    active.target.dataset.foldState = next
    setPhase(next)
  }

  const collapse = async (active: Gesture<Snapshot>): Promise<void> => {
    clearPending()
    const generation = ++active.generation
    const current = (): boolean => gesture.current === active && active.generation === generation
    changePhase(active, 'preparing')
    let permitted = true
    try { permitted = await (latest.current.prepareCollapse?.() ?? true) }
    catch { permitted = false }
    if (!current()) return
    if (!permitted) {
      changePhase(active, 'detent')
      if (active.released) {
        latest.current.onCommit(latest.current.minimum)
        release()
      }
      return
    }
    changePhase(active, 'closing')
    const started = performance.now()
    const duration = prefersReducedMotion() ? 0 : COLLAPSE_MS
    const animate = (now: number): void => {
      frame.current = null
      if (!current()) return
      const o = latest.current
      const progress = duration === 0 ? 1 : Math.min(1, (now - started) / duration)
      const end = o.collapsedSize ?? 0
      const paint = o.onCollapseFrame ?? o.onPreview
      paint(end + (o.minimum - end) * Math.pow(1 - progress, 3))
      if (progress < 1) {
        frame.current = requestAnimationFrame(animate)
      } else {
        changePhase(active, 'collapsed')
        o.onCollapse?.(active.snapshot)
        // Folding starts only on release, so native lost capture must not cancel the animation.
        if (active.released) release()
      }
    }
    frame.current = requestAnimationFrame(animate)
  }

  const update = (active: Gesture<Snapshot>): void => {
    const o = latest.current
    if (active.phase === 'collapsed') {
      if (active.raw < (o.expandAt ?? o.minimum)) return
      changePhase(active, 'dragging')
    }
    if (active.raw > o.minimum) {
      changePhase(active, 'dragging')
      o.onPreview(Math.min(o.maximum, active.raw))
      return
    }
    o.onPreview(o.minimum)
    changePhase(active, !o.onCollapse ? 'dragging'
      : active.raw <= o.minimum - COLLAPSE_TRAVEL ? 'armed' : 'detent')
  }

  const readPointer = (active: Gesture<Snapshot>, event: ReactPointerEvent<HTMLDivElement>): void => {
    const o = latest.current
    const coordinate = o.axis === 'y' ? event.clientY : event.clientX
    active.raw = active.size + (coordinate - active.coordinate) * o.direction / active.scale
    active.moved ||= Math.abs(active.raw - active.size) > .5
  }

  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !gesture.current) return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', escape, true)
    window.addEventListener('blur', cancel)
    window.addEventListener('resize', cancel)
    return () => {
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('resize', cancel)
      cancel()
    }
  }, [cancel])

  useLayoutEffect(cancel, [cancel, options.disabled, options.scopeKey, options.minimum, options.maximum])

  return {
    active: phase !== 'idle',
    phase,
    target: gesture.current?.target ?? null,
    cancel,
    handlers: {
      onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
        const o = latest.current
        if (event.button !== 0 || !event.isPrimary || o.disabled || gesture.current) return
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
        event.currentTarget.dataset.resizing = 'true'
        const size = o.readSize?.() ?? o.size
        const scale = o.scale?.() ?? 1
        const active: Gesture<Snapshot> = {
          pointerId: event.pointerId, target: event.currentTarget,
          coordinate: o.axis === 'y' ? event.clientY : event.clientX,
          size, scale: Number.isFinite(scale) && scale > 0 ? scale : 1, raw: size,
          snapshot: o.capture(), phase: o.collapsed ? 'collapsed' : 'dragging',
          generation: 0, released: false, moved: false
        }
        gesture.current = active
        setPhase(active.phase)
        o.onActiveChange?.(true)
      },
      onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
        const active = gesture.current
        if (!active || active.pointerId !== event.pointerId || active.released) return
        readPointer(active, event)
        if (!active.moved) return
        event.preventDefault()
        clearPending()
        frame.current = requestAnimationFrame(() => {
          frame.current = null
          if (gesture.current === active) update(active)
        })
      },
      onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
        const active = gesture.current
        if (!active || active.pointerId !== event.pointerId || active.released) return
        readPointer(active, event)
        const o = latest.current
        if (!active.moved) { cancel(); return }
        const folded = active.phase === 'collapsed' && active.raw < (o.expandAt ?? o.minimum)
        // Commit the release coordinate even if the last pointermove has not painted.
        // Clear intent must not depend on dwell time or a previous animation frame.
        if (!folded && o.onCollapse && active.raw <= o.minimum - COLLAPSE_TRAVEL) {
          active.released = true
          o.onPreview(o.minimum)
          void collapse(active)
          return
        }
        if (!folded) o.onCommit(Math.max(o.minimum, Math.min(o.maximum, active.raw)))
        release()
      },
      onPointerCancel(event: ReactPointerEvent<HTMLDivElement>): void {
        if (gesture.current?.pointerId === event.pointerId) cancel()
      },
      onLostPointerCapture(event: ReactPointerEvent<HTMLDivElement>): void {
        if (gesture.current?.pointerId === event.pointerId && !gesture.current.released) cancel()
      }
    }
  }
}
