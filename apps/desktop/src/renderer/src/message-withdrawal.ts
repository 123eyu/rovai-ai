import type { StoredCommandResult, ThreadMessageView } from '@contracts'
import { newCommandId } from '../../shared/command-id'
import { uiAttribute } from './interface-language'
import { MessageReeditStore, messageReeditDocument, type WithdrawalRequest } from './message-reedit-store'

/** Adapts only message withdrawal; no general command queue or background retry loop. */
export class MessageWithdrawal {
  private readonly inFlight = new Map<string, Promise<void>>()
  constructor(private readonly options: {
    store: MessageReeditStore
    request(request: WithdrawalRequest): Promise<StoredCommandResult>
    accepted(threadId: string, messageId: string): void
    refresh(threadId: string): Promise<unknown>
    notify(message: string): void
    rejectionMessage(result: StoredCommandResult): string
  }) {}

  withdraw(threadId: string, message: ThreadMessageView): Promise<void> {
    if (message.withdrawn || !message.canWithdraw || message.id.startsWith('optimistic:')) return Promise.resolve()
    const previous = this.options.store.requestFor(threadId, message.id)
    const request = previous ?? { commandId: newCommandId(), command: { threadId, messageId: message.id, expectedVersion: message.version } }
    const running = this.inFlight.get(request.commandId)
    if (running) return running
    const document = messageReeditDocument(message)
    if (!previous && document && !this.options.store.stage(request, document)) {
      this.options.notify(uiAttribute('未能保存恢复内容，本次撤回后无法重新编辑。'))
    }
    return this.perform(request, Boolean(previous), Boolean(document))
  }
  recoverPending = (): void => {
    for (const request of this.options.store.pending()) {
      void this.perform(request, true, true).catch(() => undefined)
    }
  }
  private perform(request: WithdrawalRequest, recovered: boolean, hasText: boolean): Promise<void> {
    const running = this.inFlight.get(request.commandId)
    if (running) return running
    const task = this.execute(request, recovered, hasText).finally(() => { this.inFlight.delete(request.commandId) })
    this.inFlight.set(request.commandId, task)
    return task
  }
  private async execute(request: WithdrawalRequest, recovered: boolean, hasText: boolean): Promise<void> {
    let result: StoredCommandResult
    try { result = await this.options.request(request) }
    catch { throw new Error(uiAttribute('撤回结果尚未确认，请恢复连接后重试。')) }
    if (result.status === 'rejected') {
      this.options.store.reject(request)
      throw new Error(this.options.rejectionMessage(result))
    }
    const restored = this.options.store.confirm(request, recovered)
    if (hasText && !restored) this.options.notify(uiAttribute('已撤回，本次无法重新编辑。'))
    const { threadId, messageId } = request.command
    this.options.accepted(threadId, messageId)
    try { await this.options.refresh(threadId) }
    catch { this.options.notify(uiAttribute('消息已撤回，会话暂未刷新，请稍后重试。')) }
  }
}
