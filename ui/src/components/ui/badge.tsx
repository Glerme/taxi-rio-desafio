import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export const Badge = ({ className, ...p }: HTMLAttributes<HTMLSpanElement>) => (
  <span
    className={cn('inline-flex items-center whitespace-nowrap gap-1.5 rounded-full px-2.5 py-1 text-sm font-semibold', className)}
    {...p}
  />
)
