import { useEffect, useState } from 'react'
import type { ComposerDocument, ReferenceCandidate, ReferenceIdentity } from '@contracts'
import type { ReferenceScope } from './useReferencePicker'
import { isReferenceAtom, referenceIdentity } from './thread-reference'

const EMPTY = new Map<string, ReferenceCandidate | null>()

export function useReferenceAvailability(scope: ReferenceScope | undefined, document: ComposerDocument) {
  const identities = [...new Map(document.segments.flatMap(segment => segment.kind === 'atom' && isReferenceAtom(segment.atom)
    ? [[referenceIdentity(segment.atom).id, referenceIdentity(segment.atom)] as const] : [])).values()]
  const key = JSON.stringify(identities)
  const [state, setState] = useState<{ scope: string; items: Map<string, ReferenceCandidate | null> }>({ scope: '', items: new Map() })
  useEffect(() => {
    if (!scope || !identities.length) return
    let cancelled = false, sequence = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      const ticket = ++sequence
      const refs = JSON.parse(key) as ReferenceIdentity[]
      const found = new Map<string, ReferenceCandidate | null>()
      try {
        for (let start = 0; start < refs.length; start += 128) {
          const batch = refs.slice(start, start + 128)
          const result = await scope.client.request<Array<ReferenceCandidate | null>>('threadReferences.resolve', { threadId: scope.threadId, references: batch })
          if (cancelled || ticket !== sequence) return
          batch.forEach((ref, index) => found.set(ref.id, result[index] ?? null))
        }
        if (!cancelled && ticket === sequence) setState({ scope: scope.threadId, items: found })
      } catch { /* A transport failure does not declare a target deleted. Core validates publication. */ }
    }
    const refresh = () => { clearTimeout(timer); timer = setTimeout(() => { void read() }, 150) }
    void read()
    const stopEvent = scope.client.onEvent?.(refresh)
    const stopInvalidated = scope.client.onInvalidated?.(refresh)
    return () => { cancelled = true; clearTimeout(timer); stopEvent?.(); stopInvalidated?.() }
  }, [scope?.threadId, scope?.client, key])
  return state.scope === scope?.threadId ? state.items : EMPTY
}
