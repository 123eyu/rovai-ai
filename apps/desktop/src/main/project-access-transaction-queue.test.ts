import { expect, it } from 'vitest'
import { ProjectAccessTransactionCoordinator } from './project-access-restore'

it('serializes presentation writes and continues after a failed write', async () => {
  const queue = new ProjectAccessTransactionCoordinator()
  const events: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const failed = queue.run(async () => { events.push('first'); await gate; throw new Error('disk') })
  const next = queue.run(async () => { events.push('second'); return 'saved' })
  await Promise.resolve()
  expect(events).toEqual(['first'])
  release()
  await expect(failed).rejects.toThrow('disk')
  await expect(next).resolves.toBe('saved')
  expect(events).toEqual(['first', 'second'])
})
