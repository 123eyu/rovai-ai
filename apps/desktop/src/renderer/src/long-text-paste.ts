const LONG_TEXT_PASTE_THRESHOLD = 10_000

export function isLongTextPaste(text: string): boolean {
  let count = 0
  for (const _codePoint of text) {
    if (++count > LONG_TEXT_PASTE_THRESHOLD) return true
  }
  return false
}

export function pastedTextFileName(existingNames: Iterable<string>): string {
  const names = new Set(existingNames)
  let index = 1
  while (names.has(`粘贴内容-${index}.txt`)) index += 1
  return `粘贴内容-${index}.txt`
}
