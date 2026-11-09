import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { request, toastError, type Status } from '@/lib/api'
import { CorridasTable } from './CorridasTable'
import { useCorridas } from './useCorridas'

const proximo: Partial<Record<Status, { status: Status; label: string }>> = {
  solicitada: { status: 'aceita', label: 'Aceitar' },
  aceita: { status: 'em_andamento', label: 'Iniciar' },
  em_andamento: { status: 'finalizada', label: 'Finalizar' },
}

export function Motorista({ token }: { token: string }) {
  const { corridas, refresh } = useCorridas(token)

  async function avancar(id: string, status: Status) {
    try {
      await request(token, `/corridas/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) })
    } catch (e) {
      toastError(e)
    }
    refresh() // em 409 a lista mostra o estado real
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Corridas</CardTitle>
      </CardHeader>
      <CardContent>
        <CorridasTable
          corridas={corridas}
          actions={(c) => {
            const p = proximo[c.status]
            return p && <Button onClick={() => avancar(c.id, p.status)}>{p.label}</Button>
          }}
        />
      </CardContent>
    </Card>
  )
}
