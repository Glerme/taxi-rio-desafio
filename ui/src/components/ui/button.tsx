import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-5 text-base font-semibold transition-colors disabled:pointer-events-none disabled:opacity-60',
  {
    variants: {
      variant: {
        default: 'bg-taxi text-asphalt shadow-[0_2px_0_var(--color-asphalt)] hover:bg-taxi-hover',
        outline: 'border-2 border-asphalt bg-transparent text-asphalt hover:bg-taxi-soft',
        ghost: 'px-3 text-asphalt hover:bg-white/15 hover:text-white',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export function Button({
  className,
  variant,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant }), className)} {...props} />
}
