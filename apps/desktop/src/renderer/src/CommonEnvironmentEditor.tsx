import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { AdapterKind } from '@contracts'
import { useThreadClient } from './camp-client'
import { DialogControlIcon } from './AppDialog'
import { uiAttribute as t, useInterfaceLanguage } from './interface-language'
import { readErrorMessage } from './error-message'
import { COMMON_ENVIRONMENT_CHANGED, environmentText, maskEnvironment, parseMemberEnvironment, SAVED_ENVIRONMENT_VALUE, sensitiveEnvironmentName, type EnvironmentSnapshot } from './member-environment'
import './member-environment.css'

export function EnvironmentJson({ value, onChange, id, label, disabled, readOnly = false, error, placeholder = '{}' }: {
  value: string; onChange(value: string): void; id: string; label: string; disabled: boolean; readOnly?: boolean; error?: string; placeholder?: string
}): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = (): void => {
      if (!el.clientWidth) return
      el.style.height = 'auto'
      const style = getComputedStyle(el)
      el.style.height = `${el.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)}px`
    }
    fit()
    let width = el.clientWidth
    const observer = new ResizeObserver(() => { if (width !== el.clientWidth) { width = el.clientWidth; fit() } })
    observer.observe(el)
    return () => observer.disconnect()
  }, [value])
  return <textarea ref={ref} id={id} className="member-environment-json" value={value} onChange={e => onChange(e.target.value)}
    aria-label={label} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} readOnly={readOnly} disabled={disabled}
    placeholder={placeholder} rows={4} spellCheck={false} autoComplete="off"/>
}

export function useCommonEnvironment(kind: AdapterKind, windows: boolean) {
  const client = useThreadClient()
  const [snapshot, setSnapshot] = useState<EnvironmentSnapshot | null>(null)
  const [text, setText] = useState(''), [error, setError] = useState(''), [revealed, setRevealed] = useState(false)
  const sequence = useRef(0), latest = useRef({ text, kind }); latest.current = { text, kind }
  let parsed: Record<string,string> = {}, parseError = ''
  try { parsed = parseMemberEnvironment(text, windows, kind, undefined) } catch (e) { parseError = readErrorMessage(e) }
  const accept = (next: EnvironmentSnapshot): void => {
    sequence.current++; setSnapshot(next); setText(environmentText(next.environment)); setError(''); setRevealed(false)
  }
  const edit = (): { expectedRevision: number; json: string } => {
    const invalid = Object.entries(parsed).some(([name,value]) => value === SAVED_ENVIRONMENT_VALUE && (!sensitiveEnvironmentName(name) || !snapshot || !Object.hasOwn(snapshot.environment, name)))
    const problem = parseError || (invalid ? t('请填写真实值；“<saved>”仅用于保留已有凭据。') : '')
    if (problem || !snapshot) { setError(problem || t('正在读取…')); throw new Error(problem) }
    return { expectedRevision: snapshot.revision, json: text }
  }
  return {
    text, error, revealed, loading: snapshot === null, dirty: snapshot !== null && text !== environmentText(snapshot.environment),
    hasSecrets: Object.keys(parsed).some(sensitiveEnvironmentName),
    accept, edit, fail: setError,
    async reload() {
      const request = ++sequence.current
      try { const next = await client.request<EnvironmentSnapshot>('runtime.environment.get', { runtimeKind: kind }); if (request === sequence.current) accept(next) }
      catch (e) { if (request === sequence.current) setError(readErrorMessage(e)) }
    },
    update(value: string) { sequence.current++; setText(value); setError('') },
    discard() { if (snapshot) accept({ ...snapshot, environment: maskEnvironment(snapshot.environment) }) },
    saved(next: EnvironmentSnapshot) { accept(next); window.dispatchEvent(new CustomEvent(COMMON_ENVIRONMENT_CHANGED, { detail: kind })) },
    async toggleReveal() {
      try {
        edit()
        if (revealed && snapshot) {
          for (const [name,value] of Object.entries(snapshot.environment)) if (sensitiveEnvironmentName(name) && value !== '' && parsed[name] === value) parsed[name] = SAVED_ENVIRONMENT_VALUE
          setSnapshot({ ...snapshot, environment: maskEnvironment(snapshot.environment) }); setText(environmentText(parsed)); setRevealed(false); sequence.current++; return
        }
        const request = ++sequence.current
        const result = await client.request<EnvironmentSnapshot>('runtime.environment.get', { runtimeKind: kind, reveal: true })
        if (request !== sequence.current || latest.current.text !== text || latest.current.kind !== kind) return
        if (result.revision !== snapshot?.revision) throw new Error(t('通用配置已在其他位置更新，请重新读取。'))
        for (const [name,value] of Object.entries(result.environment)) if (parsed[name] === SAVED_ENVIRONMENT_VALUE) parsed[name] = value
        setSnapshot(result); setText(environmentText(parsed)); setRevealed(true)
      } catch (e) { setError(readErrorMessage(e)) }
    }
  }
}

export function CommonEnvironmentEditor({ environment: env, disabled, onChange }: {
  environment: ReturnType<typeof useCommonEnvironment>; disabled: boolean; onChange(): void
}): React.JSX.Element {
  useInterfaceLanguage()
  const id = useId(), [help, setHelp] = useState(false)
  return <section className="runtime-startup-section common-environment-section">
    <div className="runtime-startup-section-heading"><div className="common-environment-heading">
      <label htmlFor={id}>{t('通用环境变量')}</label>
      <button className="common-environment-help" type="button" aria-label={t('通用环境变量说明')} aria-describedby={help ? `${id}-help` : undefined}
        onMouseEnter={() => setHelp(true)} onMouseLeave={e => { if (document.activeElement !== e.currentTarget) setHelp(false) }} onFocus={() => setHelp(true)} onBlur={() => setHelp(false)} onClick={() => setHelp(true)}
        onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setHelp(false) } }}>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M7.8 7.2a2.2 2.2 0 0 1 4.4.2c0 1.6-2.2 1.8-2.2 3.3M10 13.7v.1"/></svg>
      </button>
      {help && <span id={`${id}-help`} role="tooltip" className="common-environment-tooltip">{t('用于在不同队员之间共享一些配置变量。')}</span>}
    </div></div>
    <EnvironmentJson id={id} value={env.text} onChange={value => { env.update(value); onChange() }} disabled={disabled || env.loading} error={env.error} label={t('通用环境变量 JSON')}/>
    {env.error && <p id={`${id}-error`} className="environment-error" role="alert">{env.error}<button type="button" className="quiet-button" disabled={disabled} onClick={() => void env.reload()}>{t('重新读取')}</button></p>}
    {env.hasSecrets && <div className="environment-caption"><button type="button" className="quiet-button environment-reveal" onClick={() => void env.toggleReveal()} disabled={disabled || env.loading} aria-pressed={env.revealed}><DialogControlIcon name={env.revealed ? 'eye-off' : 'eye'}/>{env.revealed ? t('隐藏密钥') : t('显示密钥')}</button></div>}
  </section>
}
