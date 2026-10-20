import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { ThreadClient } from './camp-client'
import {
  InputHistoryNavigation, inputHistoryFor, inputHistoryKey, isInputHistoryKey, type InputHistoryTarget
} from './input-history'

export function useTextareaInputHistory({
  client, target, draft, setDraft, inputRef
}: {
  client: ThreadClient
  target: InputHistoryTarget | null
  draft: string
  setDraft(value: string): void
  inputRef: RefObject<HTMLTextAreaElement | null>
}) {
  const current = useRef({ draft, setDraft })
  current.current = { draft, setDraft }
  const [preview, setPreview] = useState<string | null>(null)
  const previewRef = useRef<string | null>(null)
  const selection = useRef<{ start: number; end: number } | null>(null)
  const store = inputHistoryFor(client)
  const key = target ? inputHistoryKey(target) : null
  const navigation = useMemo(() => target ? new InputHistoryNavigation(store, target, {
    capture: () => ({
      start: inputRef.current?.selectionStart ?? 0,
      end: inputRef.current?.selectionEnd ?? 0
    }),
    preview(content, boundary) {
      const text = content.segments.map(segment => segment.kind === 'text' ? segment.text : '').join('')
      const offset = boundary === 'start' ? 0 : text.length
      selection.current = { start: offset, end: offset }
      previewRef.current = text
      setPreview(text)
    },
    restore(snapshot) {
      selection.current = snapshot
      previewRef.current = null
      setPreview(null)
    }
  }) : null, [store, key, inputRef])

  const reset = (): void => {
    navigation?.adopt()
    previewRef.current = null
    selection.current = null
    setPreview(null)
  }
  useLayoutEffect(() => {
    reset()
    if (!target || !navigation) return
    const leave = store.activate(target)
    return () => { navigation.adopt(); leave() }
  }, [store, navigation])
  // Explicit external replacements (e.g. returning Pending to the composer)
  // become the normal draft and cancel an outstanding historical refill.
  useLayoutEffect(() => { reset() }, [draft])
  useLayoutEffect(() => {
    const position = selection.current
    if (!position) return
    inputRef.current?.setSelectionRange(position.start, position.end)
    selection.current = null
  }, [preview, draft])

  const value = preview ?? draft
  return {
    value,
    reset,
    cancel: () => navigation?.cancel(),
    blur: () => navigation?.cancelPending(),
    touch: () => { if (target) store.use(target) },
    edit(text: string) { if (target) store.use(target); reset(); current.current.setDraft(text) },
    adopt(): string {
      const text = previewRef.current ?? current.current.draft
      reset()
      current.current.setDraft(text)
      return text
    },
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
      if (!navigation || event.currentTarget.disabled || !isInputHistoryKey(event.nativeEvent)) return false
      const input = event.currentTarget
      if (input.selectionStart !== input.selectionEnd) return false
      if (event.key === 'Escape') {
        if (!navigation.browsing) return false
        navigation.cancel()
      } else if (event.key === 'ArrowUp') {
        if (input.selectionStart !== 0 || !navigation.canMove('older')) return false
        navigation.older()
      } else {
        if (input.selectionEnd !== input.value.length || !navigation.canMove('newer')) return false
        navigation.newer()
      }
      event.preventDefault()
      return true
    }
  }
}
