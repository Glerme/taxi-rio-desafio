import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { Corrida, Status } from '@/lib/api'

const cores: Record<Status, string> = {
  solicitada: 'bg-yellow-100 text-yellow-800',
  aceita: 'bg-blue-100 text-blue-800',
  em_andamento: 'bg-purple-100 text-purple-800',
  finalizada: 'bg-green-100 text-green-800',
}

export function CorridasTable({
  corridas,
  actions,
}: {
  corridas: Corrida[]
  actions?: (c: Corrida) => ReactNode
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Origem</TableHead>
          <TableHead>Destino</TableHead>
          <TableHead>Status</TableHead>
          {actions && <TableHead>Ação</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {corridas.map((c) => (
          <TableRow key={c.id}>
            <TableCell>{c.origem}</TableCell>
            <TableCell>{c.destino}</TableCell>
            <TableCell>
              <Badge className={cores[c.status]}>{c.status}</Badge>
            </TableCell>
            {actions && <TableCell>{actions(c)}</TableCell>}
          </TableRow>
        ))}
        {corridas.length === 0 && (
          <TableRow>
            <TableCell colSpan={4} className="text-neutral-500">
              Nenhuma corrida.
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  )
}
