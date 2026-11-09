import { toast } from 'sonner'

export type Status = 'solicitada' | 'aceita' | 'em_andamento' | 'finalizada'

export interface Corrida {
  id: string
  passageiro_id: string
  motorista_id: string | null
  origem: string
  destino: string
  status: Status
  version: number
  created_at: string
  updated_at: string
}

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message)
  }
  /** erro de rede/5xx: vale reenviar com a mesma Idempotency-Key */
  get retryable() {
    return this.statusCode === 0 || this.statusCode >= 500
  }
}

let onUnauthorized = () => {}
export const setOnUnauthorized = (fn: () => void) => (onUnauthorized = fn)

export async function request(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<{ data: any; replayed: boolean }> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    })
  } catch {
    throw new ApiError(0, 'Falha de rede')
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 401) onUnauthorized()
    throw new ApiError(res.status, body?.message ?? res.statusText)
  }
  return { data: body, replayed: res.headers.get('Idempotent-Replayed') === 'true' }
}

export const toastError = (e: unknown, id?: string) => {
  const err = e instanceof ApiError ? e : new ApiError(0, String(e))
  toast.error(`${err.statusCode}: ${Array.isArray(err.message) ? err.message.join(', ') : err.message}`, { id })
}
