import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export const Table = ({ className, ...p }: HTMLAttributes<HTMLTableElement>) => (
  <div className="w-full overflow-x-auto">
    <table className={cn('w-full text-base', className)} {...p} />
  </div>
)
export const TableHeader = (p: HTMLAttributes<HTMLTableSectionElement>) => <thead {...p} />
export const TableBody = (p: HTMLAttributes<HTMLTableSectionElement>) => <tbody {...p} />
export const TableRow = ({ className, ...p }: HTMLAttributes<HTMLTableRowElement>) => (
  <tr className={cn('border-b border-line', className)} {...p} />
)
export const TableHead = ({ className, ...p }: ThHTMLAttributes<HTMLTableCellElement>) => (
  <th className={cn('h-11 px-2 text-left font-semibold text-muted', className)} {...p} />
)
export const TableCell = ({ className, ...p }: TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={cn('p-2 align-middle', className)} {...p} />
)
