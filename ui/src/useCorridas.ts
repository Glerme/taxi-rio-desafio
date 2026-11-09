import { useCallback, useEffect, useState } from 'react'
import { request, toastError, type Corrida } from '@/lib/api'

/** GET /corridas a cada 2s; refresh() força uma leitura imediata (após uma ação) */
export function useCorridas(token: string) {
  const [corridas, setCorridas] = useState<Corrida[]>([])
  const refresh = useCallback(async () => {
    try {
      setCorridas((await request(token, '/corridas')).data)
    } catch (e) {
      toastError(e, 'poll') // id fixo: não empilha um toast a cada 2s
    }
  }, [token])
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 2000)
    return () => clearInterval(t)
  }, [refresh])
  return { corridas, refresh }
}
