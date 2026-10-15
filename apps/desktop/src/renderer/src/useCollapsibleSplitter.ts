import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

const DETENT_MS = 180
const COLLAPSE_TRAVEL = 64
const COLLAPSE_MS = 160

type Phase = 'idle' | 'dragging' | 'detent' | 'preparing' | 'closing' | 'collapsed'

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
  onCollapse(snapshot: Snapshot): void
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
  phase: Phase
  minimumAt: number | null
  generation: number
  blocked: boolean
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

/** A minimum is a stable stop. Folding requires both dwell time and further inward travel. */
export function useCollapsibleSplitter<Snapshot>(options: SplitterOptions<Snapshot>) {
  const latest = useRef(options)
  latest.current = options
  const gesture = useRef<Gesture<Snapshot> | null>(null)
  const frame = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')

  const clearPending = useCallback((): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    if (timer.current !== null) clearTimeout(timer.current)
    frame.current = null
    timer.current = null
  }, [])

  const release = useCallback((): void => {
    const active = gesture.current
    gesture.current = null
    clearPending()
    if (!active) return
    active.generation++
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

  const changePhase = (active: Gesture<Snapshot>, next: Phase): void => {
    active.phase = next
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
      active.blocked = true
      changePhase(active, 'detent')
      if (active.released) {
        latest.current.onCommit(latest.current.minimum)
        release()
      }
      return
    }
    changePhase(active, 'closing')
    const started = performance.now()
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : COLLAPSE_MS
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
        active.minimumAt = null
        changePhase(active, 'collapsed')
        o.onCollapse(active.snapshot)
        // Some owners remove the handle when folded; persistent handles can reverse in the same gesture.
        if (active.released) release()
      }
    }
    frame.current = requestAnimationFrame(animate)
  }

  const update = (active: Gesture<Snapshot>, now: number): void => {
    const o = latest.current
    if (active.phase === 'preparing' || active.phase === 'closing') {
      if (active.raw <= o.minimum + 8) return
      active.generation++
      clearPending()
      active.minimumAt = null
      changePhase(active, 'dragging')
    }
    if (active.phase === 'collapsed') {
      if (active.raw < (o.expandAt ?? o.minimum)) return
      changePhase(active, 'dragging')
    }
    if (active.raw > o.minimum) {
      active.minimumAt = null
      active.blocked = false
      changePhase(active, 'dragging')
      o.onPreview(Math.min(o.maximum, active.raw))
      return
    }
    if (active.minimumAt === null) active.minimumAt = now
    changePhase(active, 'detent')
    o.onPreview(o.minimum)
    if (active.blocked || active.raw > o.minimum - COLLAPSE_TRAVEL) return
    const remaining = DETENT_MS - (now - active.minimumAt)
    if (remaining <= 0) void collapse(active)
    else timer.current = setTimeout(() => {
      timer.current = null
      if (gesture.current === active) update(active, performance.now())
    }, remaining)
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
          minimumAt: null, generation: 0, blocked: false, released: false, moved: false
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
        if (active.phase === 'preparing' || active.phase === 'closing') {
          update(active, performance.now())
          return
        }
        clearPending()
        frame.current = requestAnimationFrame(now => {
          frame.current = null
          if (gesture.current === active) update(active, now)
        })
      },
      onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
        const active = gesture.current
        if (!active || active.pointerId !== event.pointerId) return
        readPointer(active, event)
        const o = latest.current
        if (active.phase === 'preparing' || active.phase === 'closing') {
          update(active, performance.now())
          if (active.phase === 'preparing' || active.phase === 'closing') {
            // Native pointerup releases capture; let an already accepted fold finish.
            active.released = true
            return
          }
        }
        if (!active.moved) { cancel(); return }
        const folded = active.phase === 'collapsed' && active.raw < (o.expandAt ?? o.minimum)
        if (!folded && !active.blocked && active.minimumAt !== null
          && performance.now() - active.minimumAt >= DETENT_MS && active.raw <= o.minimum - COLLAPSE_TRAVEL) {
          active.released = true
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
