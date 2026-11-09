const KEY = 'token'

export interface Session {
  token: string
  sub: string
  role: string
}

// só para exibir sub/role: a assinatura é validada pela api, não aqui
export function decode(token: string): Session | null {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const { sub, role } = JSON.parse(new TextDecoder().decode(bytes))
    return typeof sub === 'string' && typeof role === 'string' ? { token, sub, role } : null
  } catch {
    return null
  }
}

export const load = () => {
  try {
    const t = sessionStorage.getItem(KEY)
    return t ? decode(t) : null
  } catch {
    return null
  }
}
export const save = (token: string) => sessionStorage.setItem(KEY, token)
export const clear = () => sessionStorage.removeItem(KEY)
