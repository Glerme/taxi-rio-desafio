import { useRef, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ApiError, request, toastError } from '@/lib/api'
import { CorridasTable } from './CorridasTable'
import { useCorridas } from './useCorridas'

export function Passageiro({ token }: { token: string }) {
  const { corridas, refresh } = useCorridas(token)
  const [origem, setOrigem] = useState('')
  const [destino, setDestino] = useState('')
  const [retry, setRetry] = useState(false)
  // uma key por envio: sobrevive a "tentar de novo", zera no sucesso ou se o usuário editar o formulário
  const key = useRef<string | null>(null)

  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    key.current = null
    setRetry(false)
    set(e.target.value)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    key.current ??= crypto.randomUUID()
    try {
      const { replayed } = await request(token, '/corridas', {
        method: 'POST',
        headers: { 'Idempotency-Key': key.current },
        body: JSON.stringify({ origem, destino }),
      })
      if (replayed) toast.info('Corrida já registrada (resposta repetida pela Idempotency-Key)')
      else toast.success('Corrida solicitada')
      key.current = null
      setRetry(false)
      setOrigem('')
      setDestino('')
      refresh()
    } catch (err) {
      setRetry(err instanceof ApiError && err.retryable)
      toastError(err)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Solicitar corrida</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
            <div className="flex-1 space-y-1">
              <label htmlFor="origem" className="text-sm">Origem</label>
              <Input id="origem" value={origem} onChange={edit(setOrigem)} required />
            </div>
            <div className="flex-1 space-y-1">
              <label htmlFor="destino" className="text-sm">Destino</label>
              <Input id="destino" value={destino} onChange={edit(setDestino)} required />
            </div>
            <Button type="submit">{retry ? 'Tentar de novo' : 'Solicitar'}</Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Minhas corridas</CardTitle>
        </CardHeader>
        <CardContent>
          <CorridasTable corridas={corridas} />
        </CardContent>
      </Card>
    </div>
  )
}
