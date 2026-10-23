import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import {
  DEFAULT_FILE_PREVIEW_RATIO,
  FILE_PREVIEW_RATIO_STORAGE_KEY,
  MIN_CONVERSATION_WIDTH,
  MIN_FILE_PREVIEW_WIDTH,
  filePreviewDragWidth,
  filePreviewRatioForWidth,
  filePreviewRatioFromStoredValue,
  filePreviewSplitMinWidth,
  filePreviewWidthForRatio,
  maximumFilePreviewWidth
} from './file-preview-layout'
import { UiText, uiAttribute } from './interface-language'
import { splitterScale, useCollapsibleSplitter } from './useCollapsibleSplitter'
import { SplitterFeedback } from './SplitterFeedback'

interface FilePreviewLayoutValue {
  threadId: string | null
  visible: boolean
  activityMode: boolean
  compact: boolean
  width: number
  availableWidth: number
  resizing: boolean
  className: string
  style: CSSProperties
  workspace: HTMLDivElement | null
  workspaceRef(element: HTMLDivElement | null): void
  previewWidth(width: number): void
  commitWidth(width: number): void
  cancelResize(): void
  resetRatio(): void
}

const FilePreviewLayoutContext = createContext<FilePreviewLayoutValue | null>(null)
// Initializing a pane must not subscribe the conversation to drag geometry.
const FilePreviewInitialWidthContext = createContext<(() => void) | null>(null)

function readPreferredRatio(): number | null {
  try {
    return filePreviewRatioFromStoredValue(window.localStorage.getItem(FILE_PREVIEW_RATIO_STORAGE_KEY))
  } catch {
    return null
  }
}

// Layout updates have their own context so dragging does not rerender the Thread or file contents.
export function FilePreviewLayoutProvider({
  threadId,
  visible,
  activityMode = false,
  children
}: {
  threadId: string | null
  visible: boolean
  activityMode?: boolean
  children: ReactNode
}): React.JSX.Element {
  const [workspace, setWorkspace] = useState<HTMLDivElement | null>(null)
  const [availableWidth, setAvailableWidth] = useState(0)
  const availableWidthRef = useRef(0)
  const [preferredRatio, setPreferredRatio] = useState(readPreferredRatio)
  const [initialRatios, setInitialRatios] = useState<ReadonlyMap<string, number>>(() => new Map())
  const openedThreads = useRef(new Set<string>())
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const [snapping, setSnapping] = useState(false)
  const snapTimer = useRef<number | null>(null)

  const cancelResize = useCallback(() => setDragWidth(null), [])

  useLayoutEffect(() => {
    if (threadId && visible) openedThreads.current.add(threadId)
  }, [threadId, visible])

  const initializeMinimumWidth = useCallback((): void => {
    if (!threadId || visible || preferredRatio !== null || openedThreads.current.has(threadId)) return
    const ratio = filePreviewRatioForWidth(availableWidthRef.current, MIN_FILE_PREVIEW_WIDTH)
    if (ratio === null) return
    openedThreads.current.add(threadId)
    setInitialRatios(current => new Map(current).set(threadId, ratio))
  }, [preferredRatio, threadId, visible])

  useLayoutEffect(() => {
    if (!workspace) return
    const measure = (): void => {
      const width = workspace.clientWidth
      if (width <= 0 || width === availableWidthRef.current) return
      availableWidthRef.current = width
      setAvailableWidth(width)
      setDragWidth(null)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(workspace)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [workspace])

  useEffect(cancelResize, [activityMode, threadId, visible, cancelResize])
  useEffect(() => () => {
    if (snapTimer.current !== null) window.clearTimeout(snapTimer.current)
  }, [])

  const saveRatio = useCallback((ratio: number): void => {
    setPreferredRatio(ratio)
    setDragWidth(null)
    setSnapping(true)
    if (snapTimer.current !== null) window.clearTimeout(snapTimer.current)
    snapTimer.current = window.setTimeout(() => setSnapping(false), 180)
    try {
      window.localStorage.setItem(FILE_PREVIEW_RATIO_STORAGE_KEY, String(ratio))
    } catch {
      // A blocked storage area keeps the last stable ratio usable for this window.
    }
  }, [])

  const commitWidth = useCallback((width: number): void => {
    const ratio = filePreviewRatioForWidth(availableWidthRef.current, width)
    if (ratio !== null) saveRatio(ratio)
  }, [saveRatio])

  const resetRatio = useCallback(() => {
    saveRatio(DEFAULT_FILE_PREVIEW_RATIO)
  }, [saveRatio])
  const previewWidth = useCallback((width: number): void => {
    if (!Number.isFinite(width)) return
    setSnapping(false)
    setDragWidth(filePreviewDragWidth(availableWidthRef.current, width))
  }, [])

  const compact = availableWidth < filePreviewSplitMinWidth(activityMode)
  const ratio = preferredRatio ?? initialRatios.get(threadId ?? '') ?? DEFAULT_FILE_PREVIEW_RATIO
  const width = dragWidth ?? filePreviewWidthForRatio(availableWidth, ratio)
  const value = useMemo<FilePreviewLayoutValue>(() => ({
    threadId,
    visible,
    activityMode,
    compact,
    width,
    availableWidth,
    resizing: dragWidth !== null,
    className: [
      compact ? 'file-preview-compact' : '',
      dragWidth !== null ? 'is-file-preview-resizing' : '',
      snapping ? 'is-file-preview-snapping' : ''
    ].filter(Boolean).join(' '),
    style: { '--file-preview-width': `${Math.round(width)}px` } as CSSProperties,
    workspace,
    workspaceRef: setWorkspace,
    previewWidth,
    commitWidth,
    cancelResize,
    resetRatio
  }), [activityMode, availableWidth, cancelResize, commitWidth, compact, dragWidth, previewWidth, resetRatio, snapping, threadId, visible, width, workspace])

  return <FilePreviewInitialWidthContext.Provider value={initializeMinimumWidth}>
    <FilePreviewLayoutContext.Provider value={value}>{children}</FilePreviewLayoutContext.Provider>
  </FilePreviewInitialWidthContext.Provider>
}

export function useInitializeFilePreviewMinimumWidth(): (() => void) | null {
  return useContext(FilePreviewInitialWidthContext)
}

export function useOptionalFilePreviewLayout(): FilePreviewLayoutValue | null {
  return useContext(FilePreviewLayoutContext)
}

export function FilePreviewWorkspace({ children, hidden }: { children: ReactNode; hidden?: boolean }): React.JSX.Element {
  const layout = useOptionalFilePreviewLayout()
  return <div
    ref={layout?.workspaceRef}
    className={`workspace-grid inspector-collapsed${layout?.visible ? ` file-preview-open ${layout.className}` : ''}`}
    style={layout?.visible ? layout.style : undefined}
    hidden={hidden}
  >{children}</div>
}

export function FilePreviewResizeHandle({ onClose }: { onClose(): void }): React.JSX.Element | null {
  const layout = useOptionalFilePreviewLayout()
  const hintId = useId()
  const maximum = maximumFilePreviewWidth(layout?.availableWidth ?? 0)
  const closePreview = (): void => {
    layout?.cancelResize()
    onClose()
    window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>('.thread-timeline:not([hidden])')
        ?? document.querySelector<HTMLElement>('.timeline-pane')
      target?.focus({ preventScroll: true })
    })
  }
  const splitter = useCollapsibleSplitter({
    size: layout?.width ?? MIN_FILE_PREVIEW_WIDTH, collapsed: false,
    minimum: MIN_FILE_PREVIEW_WIDTH, maximum, direction: -1,
    disabled: !layout?.visible || layout.compact,
    scopeKey: layout?.threadId,
    scale: () => splitterScale(layout?.workspace ?? null),
    capture: () => undefined,
    onPreview: width => layout?.previewWidth(width),
    onCommit: width => layout?.commitWidth(width),
    onCollapse: closePreview,
    onCancel: () => layout?.cancelResize(),
    onActiveChange: active => {
      document.documentElement.classList.toggle('file-preview-resizing', active)
      if (active && layout) layout.previewWidth(layout.width)
    }
  })

  if (!layout?.visible || layout.compact) return null

  const atMinimum = splitter.phase === 'detent'
  const atConversationMinimum = layout.width >= maximum
  const hint = splitter.phase === 'armed' ? uiAttribute('松开收起预览区') : atMinimum ? uiAttribute('已到最小宽度，继续拖动收起')
    : atConversationMinimum ? uiAttribute("会话区已达最小宽度 {0}px", String(MIN_CONVERSATION_WIDTH))
      : uiAttribute("会话 {0}px · 文件 {1}px", String(Math.round(layout.availableWidth - layout.width)), String(Math.round(layout.width)))

  // One rail belongs to the shell grid, spanning the shared header and the body without clipping.
  const shell = layout.workspace?.closest('.mission-workspace-host, .app-shell-camp')
  const handle = <div
    className={`file-preview-resize-handle${shell ? ' is-shell-divider' : ''}${layout.resizing ? ' is-resizing' : ''}`}
    style={layout.style}
    role="separator"
    aria-label={uiAttribute("调整文件预览宽度")}
    aria-orientation="vertical"
    aria-valuemin={splitter.phase === 'closing' ? 0 : MIN_FILE_PREVIEW_WIDTH}
    aria-valuemax={Math.round(maximum)}
    aria-valuenow={Math.round(layout.width)}
    aria-valuetext={hint}
    aria-describedby={hintId}
    tabIndex={0}
    title={uiAttribute("拖动调整 · 双击恢复 44/56 · 方向键调整 · Delete 关闭")}
    {...splitter.handlers}
    onDoubleClick={() => {
      splitter.cancel()
      layout.resetRatio()
    }}
    onKeyDown={(event) => {
      if (splitter.active) return
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        closePreview()
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        const step = event.shiftKey ? 80 : 24
        layout.commitWidth(layout.width + (event.key === 'ArrowLeft' ? step : -step))
      } else if (event.key === 'Home') {
        event.preventDefault()
        layout.commitWidth(MIN_FILE_PREVIEW_WIDTH)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        layout.resetRatio()
      }
    }}
  >
    <span className="file-preview-splitter-grip" aria-hidden="true" />
    {splitter.phase !== 'detent' && splitter.phase !== 'armed' && <span className="file-preview-splitter-tip" aria-hidden="true">{hint}</span>}
    <SplitterFeedback phase={splitter.phase} target={splitter.target} label={uiAttribute('松开收起预览区')} />
    <span className="sr-only" id={hintId}><UiText zh={"左右方向键调整 24px，按住 Shift 调整 80px；Home 最窄；Delete 或 Backspace 关闭；双击或 Enter 恢复默认比例；Escape 取消拖动。拖到最窄处先停住，继续向内推 64 像素后松开收起，无需停留。"} /></span>
  </div>
  return shell ? createPortal(handle, shell) : handle
}
