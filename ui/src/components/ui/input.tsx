import type { InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'min-h-11 w-full rounded-lg border-2 border-asphalt/70 bg-white px-3 text-base aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  )
}
