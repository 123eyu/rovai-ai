import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $addUpdateTag, $getRoot, $getSelection, $isElementNode, $isRangeSelection,
  COMMAND_PRIORITY_NORMAL, HISTORIC_TAG, HISTORY_MERGE_TAG,
  KEY_ARROW_UP_COMMAND, KEY_ARROW_DOWN_COMMAND, KEY_ESCAPE_COMMAND,
  mergeRegister, type EditorState
} from 'lexical'
import { useEffect, useMemo, type RefObject } from 'react'
import { useThreadClient } from './camp-client'
import { $replaceEditorWithComposerDocument } from './composer-editor-state'
import {
  ComposerDraftSync, ROVAI_INPUT_HISTORY_PREVIEW_TAG, ROVAI_ATOM_PRESENTATION_TAG,
  ROVAI_COMPOSER_INITIALIZE_TAG, ROVAI_COMPOSER_REPLACE_TAG
} from './composer-draft-sync'
import {
  inputHistoryFor, inputHistoryKey, InputHistoryNavigation, isInputHistoryKey,
  type InputHistoryTarget
} from './input-history'

export type ComposerHistoryNavigation = InputHistoryNavigation<EditorState>

// Document boundaries are independent of wrapping, zoom and visual line height.
function $atDocumentBoundary(end: boolean): boolean {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false
  let node = selection.anchor.getNode()
  const length = $isElementNode(node) ? node.getChildrenSize() : node.getTextContentSize()
  if (selection.anchor.offset !== (end ? length : 0)) return false
  while (node.getKey() !== 'root') {
    if (end ? node.getNextSibling() : node.getPreviousSibling()) return false
    const parent = node.getParent()
    if (!parent) return false
    node = parent
  }
  return true
}

export function ComposerInputHistoryPlugin({ target, syncRef, navigationRef }: {
  target: InputHistoryTarget
  syncRef: RefObject<ComposerDraftSync | null>
  navigationRef: RefObject<ComposerHistoryNavigation | null>
}): null {
  const [editor] = useLexicalComposerContext()
  const client = useThreadClient()
  const key = inputHistoryKey(target)
  const store = inputHistoryFor(client)
  const navigation = useMemo(() => new InputHistoryNavigation(store, target, {
    capture: () => editor.getEditorState(),
    preview(content, boundary) {
      editor.update(() => {
        $replaceEditorWithComposerDocument(content)
        if (boundary === 'start') $getRoot().selectStart()
        else $getRoot().selectEnd()
      }, { discrete: true, tag: [ROVAI_INPUT_HISTORY_PREVIEW_TAG, HISTORIC_TAG] })
    },
    restore(snapshot) {
      editor.update(() => {
        editor.setEditorState(snapshot, { tag: ROVAI_INPUT_HISTORY_PREVIEW_TAG })
        // Browsing/caret moves must not add recalled content to the undo stack.
        $addUpdateTag(HISTORY_MERGE_TAG)
      }, { discrete: true })
      syncRef.current?.restoreHistoryDraft()
    }
  }), [editor, store, key, syncRef])

  useEffect(() => {
    navigationRef.current = navigation
    const leave = store.activate(target)
    const handle = (event: KeyboardEvent): boolean => {
      if (!editor.isEditable() || editor.isComposing() || !isInputHistoryKey(event)) return false
      const selection = $getSelection()
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false
      if (event.key === 'Escape') {
        if (!navigation.browsing) return false
      } else {
        const older = event.key === 'ArrowUp'
        if (!$atDocumentBoundary(!older) || !navigation.canMove(older ? 'older' : 'newer')) return false
      }
      event.preventDefault()
      // Lexical commands already run inside an update; refill after that update commits.
      queueMicrotask(() => {
        if (navigationRef.current !== navigation || !editor.isEditable()) return
        if (event.key === 'Escape') navigation.cancel()
        else if (event.key === 'ArrowUp') navigation.older()
        else navigation.newer()
      })
      return true
    }
    const unregister = mergeRegister(
      editor.registerCommand(KEY_ARROW_UP_COMMAND, handle, COMMAND_PRIORITY_NORMAL),
      editor.registerCommand(KEY_ARROW_DOWN_COMMAND, handle, COMMAND_PRIORITY_NORMAL),
      editor.registerCommand(KEY_ESCAPE_COMMAND, handle, COMMAND_PRIORITY_NORMAL),
      editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, tags }) => {
        if ((dirtyElements.size || dirtyLeaves.size)
          && ![ROVAI_INPUT_HISTORY_PREVIEW_TAG, ROVAI_ATOM_PRESENTATION_TAG,
            ROVAI_COMPOSER_INITIALIZE_TAG, ROVAI_COMPOSER_REPLACE_TAG].some(tag => tags.has(tag))) touch()
      }),
      editor.registerRootListener((root, previous) => {
        // Opening/focusing an input is a real use; renders and catalog reads are not.
        previous?.removeEventListener('focus', touch)
        previous?.removeEventListener('blur', blur)
        root?.addEventListener('focus', touch)
        root?.addEventListener('blur', blur)
      })
    )
    function touch(): void { store.use(target) }
    function blur(): void { navigation.cancelPending() }
    const root = editor.getRootElement()
    return () => {
      root?.removeEventListener('focus', touch)
      root?.removeEventListener('blur', blur)
      unregister()
      navigation.adopt()
      if (navigationRef.current === navigation) navigationRef.current = null
      leave()
    }
  }, [editor, navigation, navigationRef, store, key])
  return null
}
