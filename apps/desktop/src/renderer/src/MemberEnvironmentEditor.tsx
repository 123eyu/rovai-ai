import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { AdapterKind, ModelSelection } from '@contracts'
import { useThreadClient } from './camp-client'
import { DialogControlIcon } from './AppDialog'
import { uiAttribute as t, useInterfaceLanguage } from './interface-language'
import { readErrorMessage } from './error-message'
import { ENVIRONMENT_PLACEHOLDER, SAVED_ENVIRONMENT_VALUE, environmentText, parseMemberEnvironment, sensitiveEnvironmentName, type MemberEnvironmentEdit, type MemberEnvironmentSnapshot } from './member-environment'
import { EnvironmentJson } from './CommonEnvironmentEditor'
import { COMMON_ENVIRONMENT_CHANGED, maskEnvironment, mergeEnvironment, type EnvironmentSnapshot } from './member-environment'
import './member-environment.css'

type Draft = { snapshot: MemberEnvironmentSnapshot; text: string; error: string; loading: boolean; revealed: boolean; saved: boolean; inherit: boolean }
const empty = (): Draft => ({ snapshot: { revision: 0, environment: {} }, text: '', error: '', loading: true, revealed: false, saved: false, inherit: true })

export function useMemberEnvironment(memberId: string, kind: AdapterKind | '', memberVersion: number, model: ModelSelection | undefined, windows: boolean, active = true) {
  const client = useThreadClient()
  const key = `${memberId}:${kind}`
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const current = drafts[key] ?? empty()
  const state = useRef({ key, current }); state.current = { key, current }
  const sequence = useRef(0)
  const revealSequence = useRef(0)
  const savedReadKey = useRef<string | null>(null)
  const patch = useCallback((change: Partial<Draft>): void => setDrafts(all => ({ ...all, [key]: { ...(all[key] ?? empty()), ...change } })), [key])
  const load = useCallback(async (force = false): Promise<void> => {
    if (!kind) return
    const request = ++sequence.current
    try {
      const snapshot = await client.request<MemberEnvironmentSnapshot>('member.runtimeEnvironment.get', { memberId, adapterKind: kind })
      if (request !== sequence.current) return
      // A profile-version refresh may supersede the read started by Save. It must
      // still accept that saved revision instead of treating our own write as a conflict.
      const saved = savedReadKey.current === key
      if (saved) savedReadKey.current = null
      setDrafts(all => {
        const previous = all[key]
        if ((previous?.snapshot.common?.revision ?? -1) > (snapshot.common?.revision ?? -1)) snapshot.common = previous?.snapshot.common
        if (!force && !saved && previous && (previous.text !== environmentText(previous.snapshot.environment) || previous.inherit !== (previous.snapshot.inheritCommon ?? true))) {
          return { ...all, [key]: { ...previous, loading: false, error: snapshot.revision !== previous.snapshot.revision ? t('运行环境已在其他位置更新，请重新读取。') : previous.error } }
        }
        return { ...all, [key]: { ...empty(), snapshot, text: environmentText(snapshot.environment), loading: false, saved: saved || (previous?.saved === true && previous.snapshot.revision === snapshot.revision), inherit: snapshot.inheritCommon ?? true } }
      })
    } catch (error) { if (request === sequence.current) patch({ error: readErrorMessage(error), loading: true }) }
  }, [client, key, kind, memberId, patch])
  useEffect(() => { void load(); return () => { sequence.current++ } }, [load, memberVersion])
  useEffect(() => {
    if (!kind || !active) return
    let cancelled = false
    const refresh = (): void => {
      void client.request<EnvironmentSnapshot>('runtime.environment.get', { runtimeKind: kind }).then(common => {
        if (!cancelled) setDrafts(all => !all[key] || (all[key].snapshot.common?.revision ?? -1) > common.revision ? all : ({ ...all, [key]: { ...all[key], snapshot: { ...all[key].snapshot, common } } }))
      }).catch(() => { /* The member read/save remains authoritative; don't replace a usable draft. */ })
    }
    const changed = (event: Event): void => { if ((event as CustomEvent).detail === kind) refresh() }
    refresh()
    window.addEventListener(COMMON_ENVIRONMENT_CHANGED, changed)
    window.addEventListener('focus', refresh)
    return () => { cancelled = true; window.removeEventListener(COMMON_ENVIRONMENT_CHANGED, changed); window.removeEventListener('focus', refresh) }
  }, [client, kind, key, active])
  const common = current.snapshot.common ?? { revision: 0, environment: {} }
  let parsed: Record<string, string> = {}, parseError = ''
  try {
    parsed = parseMemberEnvironment(current.text, windows, kind, model)
    parseMemberEnvironment(JSON.stringify(mergeEnvironment(common.environment, parsed, current.inherit)), windows, kind, model)
  } catch (error) { parseError = readErrorMessage(error) }
  const dirty = current.text !== environmentText(current.snapshot.environment) || current.inherit !== (current.snapshot.inheritCommon ?? true)
  const mask = (): void => {
    revealSequence.current++
    if (current.revealed && !parseError) {
      for (const [name, value] of Object.entries(current.snapshot.environment)) if (sensitiveEnvironmentName(name) && value !== '' && parsed[name] === value) parsed[name] = SAVED_ENVIRONMENT_VALUE
      const masked = Object.fromEntries(Object.entries(current.snapshot.environment).map(([name,value]) => [name, sensitiveEnvironmentName(name) && value !== '' ? SAVED_ENVIRONMENT_VALUE : value]))
      patch({ text: environmentText(parsed), snapshot: { ...current.snapshot, environment: masked }, revealed: false })
    }
  }
  return {
    ...current, dirty, kind, memberId, common, parsed, parseError,
    setInherit(inherit: boolean) { patch({ inherit, error: '', saved: false }) },
    async previewValues(): Promise<Record<string,string>> {
      const text = current.text
      const snapshot = await client.request<MemberEnvironmentSnapshot>('member.runtimeEnvironment.get', { memberId, adapterKind: kind, reveal: true })
      if (state.current.key !== key || state.current.current.text !== text) throw new Error(t('配置已更改，请重新查看。'))
      if (snapshot.revision !== current.snapshot.revision || snapshot.common?.revision !== current.snapshot.common?.revision) throw new Error(t('运行环境已在其他位置更新，请重新读取。'))
      const local = { ...parsed }
      for (const [name,value] of Object.entries(snapshot.environment)) if (local[name] === SAVED_ENVIRONMENT_VALUE) local[name] = value
      return mergeEnvironment(snapshot.common?.environment ?? {}, local, current.inherit)
    },
    count: Object.keys(current.snapshot.environment).length,
    hasSecrets: Object.entries(current.snapshot.environment).some(([name, value]) => sensitiveEnvironmentName(name) && value !== ''),
    update(text: string) { patch({ text, error: '', saved: false }) },
    reset() { revealSequence.current++; setDrafts({}); void load(true) },
    async savedSuccessfully() { savedReadKey.current = key; await load(true) },
    edit(): MemberEnvironmentEdit | undefined {
      const invalidMarker = Object.entries(parsed).some(([name,value]) => value === SAVED_ENVIRONMENT_VALUE && (!sensitiveEnvironmentName(name) || !Object.hasOwn(current.snapshot.environment, name)))
      const error = parseError || (invalidMarker ? t('请填写真实值；“<saved>”仅用于保留已有凭据。') : '')
      if (error) { patch({ error }); throw new Error(error) }
      if (!dirty) return undefined
      return { expectedRevision: current.snapshot.revision, json: current.text, inheritCommon: current.inherit }
    },
    async toggleReveal() {
      if (current.revealed) { mask(); return }
      if (parseError) { patch({ error: parseError }); return }
      const originalText = current.text
      const revealRequest = ++revealSequence.current
      try {
        const snapshot = await client.request<MemberEnvironmentSnapshot>('member.runtimeEnvironment.get', { memberId, adapterKind: kind, reveal: true })
        if (revealRequest !== revealSequence.current || state.current.key !== key || state.current.current.text !== originalText) return
        if (snapshot.revision !== current.snapshot.revision) throw new Error(t('运行环境已在其他位置更新，请重新读取。'))
        for (const [name, value] of Object.entries(snapshot.environment)) if (parsed[name] === SAVED_ENVIRONMENT_VALUE) parsed[name] = value
        patch({ text: environmentText(parsed), snapshot: { ...snapshot, common }, revealed: true })
      } catch (error) { patch({ error: readErrorMessage(error) }) }
    }, mask
  }
}

export function MemberEnvironmentEditor({ environment: env, disabled, onEditCommon }: {
  environment: ReturnType<typeof useMemberEnvironment>; disabled: boolean; onEditCommon?(): void
}): React.JSX.Element {
  useInterfaceLanguage()
  const id = useId(), [open, setOpen] = useState(false), [preview, setPreview] = useState(false)
  const [revealedResult, setRevealedResult] = useState<Record<string,string> | null>(null)
  const [previewError, setPreviewError] = useState(''), [revealing, setRevealing] = useState(false)
  const revealSequence = useRef(0)
  const hasCommon = Object.keys(env.common.environment).length > 0
  const viewing = hasCommon && preview
  const merged = mergeEnvironment(env.common.environment, env.parsed, env.inherit)
  const result = JSON.stringify(revealedResult ?? maskEnvironment(merged, '••••••••'), null, 2)
  const showSecret = viewing ? Object.entries(merged).some(([name,value]) => sensitiveEnvironmentName(name) && value !== '') : env.hasSecrets
  const revealed = viewing ? revealedResult !== null : env.revealed
  useEffect(() => { setPreview(false) }, [env.memberId, env.kind, hasCommon])
  useEffect(() => { revealSequence.current++; setRevealedResult(null); setRevealing(false) }, [env.memberId, env.kind, env.text, env.inherit, env.common.revision, viewing, open])
  useEffect(() => { if (env.error || previewError) setOpen(true) }, [env.error, previewError])
  const togglePreview = (): void => {
    setPreviewError('')
    if (viewing) { setPreview(false); return }
    try { env.edit(); setPreview(true) } catch { /* Validation is displayed beside this editor. */ }
  }
  const revealPreview = async (): Promise<void> => {
    if (revealedResult) { setRevealedResult(null); return }
    const request = ++revealSequence.current
    setRevealing(true); setPreviewError('')
    try { const values = await env.previewValues(); if (request === revealSequence.current) setRevealedResult(values) }
    catch (error) { if (request === revealSequence.current) setPreviewError(readErrorMessage(error)) }
    finally { if (request === revealSequence.current) setRevealing(false) }
  }
  const error = env.error || previewError
  return <details className="member-environment-disclosure" open={open} onToggle={event => { setOpen(event.currentTarget.open); if (!event.currentTarget.open) env.mask() }}>
    <summary className="member-environment-entry"><DialogControlIcon name="chevron"/><span>{t('环境变量')}</span></summary>
    <div className="member-environment-body">
      {hasCommon && <div className="environment-inherit-row">
        <label><input type="checkbox" checked={env.inherit} disabled={disabled || env.loading} onChange={e => env.setInherit(e.target.checked)}/><span>{t('继承通用配置')}</span></label>
        {onEditCommon && <button className="quiet-button environment-text-link" type="button" disabled={disabled} onClick={onEditCommon}>{t('编辑通用配置')}<DialogControlIcon name="chevron"/></button>}
      </div>}
      {hasCommon && <div className="environment-own-label"><label htmlFor={id}>{viewing ? t('合并结果（只读）') : env.inherit ? t('队员变量') : t('独立变量')}</label></div>}
      <EnvironmentJson id={id} value={viewing ? result : env.text} onChange={env.update} disabled={disabled || env.loading} readOnly={viewing} error={error}
        label={viewing ? t('合并结果 JSON，只读') : t('环境变量 JSON')} placeholder={ENVIRONMENT_PLACEHOLDER}/>
      {error && <p id={`${id}-error`} className="environment-error" role="alert">{error}{env.loading && <button type="button" className="quiet-button" onClick={env.reset}>{t('重试')}</button>}</p>}
      {(hasCommon || showSecret) && <div className="environment-caption environment-member-caption">
        {hasCommon && <button className="quiet-button environment-text-link" type="button" disabled={disabled || env.loading} onClick={togglePreview}>{viewing ? t('编辑') : t('查看合并结果')}</button>}
        {showSecret && <button type="button" className="quiet-button environment-reveal" disabled={disabled || env.loading || revealing} aria-pressed={revealed} onClick={() => viewing ? void revealPreview() : void env.toggleReveal()}><DialogControlIcon name={revealed ? 'eye-off' : 'eye'}/>{revealed ? t('隐藏密钥') : t('显示密钥')}</button>}
      </div>}
      {env.saved && <p className="environment-saved" role="status">{t('已保存。')}</p>}
    </div>
  </details>
}
