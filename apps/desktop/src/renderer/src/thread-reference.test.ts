import { describe, expect, it } from 'vitest'
import { isReferenceDirectoryEvent } from './useReferenceAvailability'
import invalidations from '../../../../../packages/contracts/fixtures/thread-reference-invalidation.json'
import { fuzzyContains } from './thread-reference'
import cases from '../../../../../packages/contracts/fixtures/thread-reference-search.json'

describe('reference title search', () => {
  it.each(cases)('matches $title / $query consistently with the Core directory', ({ title, query, expected }) => {
    expect(fuzzyContains(title, query)).toBe(expected)
  })
})

it.each(invalidations)('refreshes directory for $method / $params.reason only when needed', ({ expected, ...event }) => {
  expect(isReferenceDirectoryEvent(event)).toBe(expected)
})
