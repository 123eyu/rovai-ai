/** One ordinary Bearer Session lets this browser reopen. Editor proofs, drafts,
 * commands and tab ownership are deliberately absent from durable auth storage. */
export interface BrowserSession {
  version: 1
  origin: string
  token: string
  ownerId: string
  expiresAt: number | null
}
export interface AuthStorage {
  read(): Promise<BrowserSession | null>
  write(session: BrowserSession, expectedToken?: string, current?: () => boolean): Promise<void>
  remove(token: string): Promise<void>
}
export const TAB_AUTH_KEY = 'rovai.web.auth.v1'

let browserDatabase: Promise<IDBDatabase> | undefined
function openBrowserDatabase(): Promise<IDBDatabase> {
  return browserDatabase ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('rovai-web-auth-v1', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('sessions')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { browserDatabase = undefined; reject(new Error('无法打开浏览器登录存储。')) }
  })
}

/** Non-secret presentation identity; reuse the browser's existing database and
 * atomic transactions, including HTTP LAN origins without Web Locks. No paths,
 * tombstones or Thread data are stored here. Logout only removes the auth key. */
export async function browserProjectIdentity(scope: string): Promise<string> {
  const db = await openBrowserDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('sessions', 'readwrite')
    const store = transaction.objectStore('sessions')
    const key = `project-registry:${scope}`
    const request = store.get(key)
    let identity: string
    request.onsuccess = () => {
      try {
        if (request.result === undefined) {
          identity = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
          store.put(identity, key)
        } else if (typeof request.result === 'string' && /^[a-f0-9]{64}$/.test(request.result)) identity = request.result
        else transaction.abort()
      } catch { transaction.abort() }
    }
    transaction.oncomplete = () => resolve(identity)
    transaction.onerror = transaction.onabort = () => reject(new Error('项目作用域未能保存，请检查浏览器存储后重试。'))
  })
}

export function browserAuthStorage(origin: string): AuthStorage {
  const access = async (update?: (value: BrowserSession | null, store: IDBObjectStore) => void): Promise<BrowserSession | null> => {
    const db = await openBrowserDatabase()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('sessions', update ? 'readwrite' : 'readonly')
      const store = transaction.objectStore('sessions')
      const request = store.get(origin)
      let value: BrowserSession | null = null
      request.onsuccess = () => { value = request.result ?? null; update?.(value, store) }
      transaction.oncomplete = () => resolve(value)
      transaction.onerror = transaction.onabort = () => reject(new Error('登录状态未能保存，请检查浏览器存储后重试。'))
    })
  }
  return {
    read: () => access(),
    async write(value, expectedToken, current = () => true) {
      await access((previous, store) => {
        if (current() && (expectedToken === undefined || previous === null || previous.token === expectedToken)) store.put(value, origin)
      })
    },
    async remove(token) { await access((previous, store) => { if (previous?.token === token) store.delete(origin) }) }
  }
}
