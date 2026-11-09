import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export const Card = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('rounded-xl border-2 border-asphalt bg-white', className)} {...p} />
)
export const CardHeader = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('p-4 pb-2 sm:p-5 sm:pb-2', className)} {...p} />
)
export const CardTitle = ({ className, ...p }: HTMLAttributes<HTMLHeadingElement>) => (
  <h2 className={cn('font-display text-2xl font-bold tracking-tight', className)} {...p} />
)
export const CardContent = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('p-4 pt-2 sm:p-5 sm:pt-2', className)} {...p} />
)
