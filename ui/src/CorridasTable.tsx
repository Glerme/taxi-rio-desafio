import type { ReactNode } from 'react'
import { CheckCircle2, Clock, MapPin, Navigation, Route, ThumbsUp, type LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { Corrida, Status } from '@/lib/api'

const estilo: Record<Status, { cor: string; Icon: LucideIcon; label: string }> = {
  solicitada: { cor: 'bg-taxi-soft text-[#5b4400]', Icon: Clock, label: 'Solicitada' },
  aceita: { cor: 'bg-blue-100 text-blue-900', Icon: ThumbsUp, label: 'Aceita' },
  em_andamento: { cor: 'bg-violet-100 text-violet-900', Icon: Navigation, label: 'Em andamento' },
  finalizada: { cor: 'bg-green-100 text-green-900', Icon: CheckCircle2, label: 'Finalizada' },
}

function StatusBadge({ status }: { status: Status }) {
  const { cor, Icon, label } = estilo[status]
  return (
    <Badge className={cor}>
      <Icon aria-hidden size={16} />
      {label}
    </Badge>
  )
}

export function CorridasTable({
  corridas,
  actions,
}: {
  corridas: Corrida[]
  actions?: (c: Corrida) => ReactNode
}) {
  if (corridas.length === 0) return <p className="py-4 text-muted">Nenhuma corrida por aqui ainda.</p>
  return (
    <>
      <ul className="space-y-3 md:hidden">
        {corridas.map((c) => (
          <li key={c.id} className="space-y-3 rounded-lg border-2 border-line p-3">
            <StatusBadge status={c.status} />
            <p className="flex items-start gap-2">
              <MapPin aria-hidden size={18} className="mt-1 shrink-0 text-muted" />
              <span><span className="sr-only">Origem: </span>{c.origem}</span>
            </p>
            <p className="flex items-start gap-2">
              <Route aria-hidden size={18} className="mt-1 shrink-0 text-muted" />
              <span><span className="sr-only">Destino: </span>{c.destino}</span>
            </p>
            {actions?.(c)}
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
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
                  <StatusBadge status={c.status} />
                </TableCell>
                {actions && <TableCell>{actions(c)}</TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  )
}
