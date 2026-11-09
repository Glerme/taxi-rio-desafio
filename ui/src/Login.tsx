import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import tokens from '../../keys/tokens.json'

export function Login({ onLogin }: { onLogin: (token: string) => boolean }) {
  const [jwt, setJwt] = useState('')

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!onLogin(jwt.trim())) toast.error('JWT inválido')
  }

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <CardTitle>Entrar</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <p className="text-sm">Tokens de teste:</p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(tokens).map(([nome, t]) => (
              <Button key={nome} variant="outline" onClick={() => onLogin(t)}>
                {nome}
              </Button>
            ))}
          </div>
        </div>
        <form onSubmit={submit} className="space-y-2">
          <label htmlFor="jwt" className="text-sm">Ou cole um JWT</label>
          <Input id="jwt" value={jwt} onChange={(e) => setJwt(e.target.value)} required />
          <Button type="submit">Entrar</Button>
        </form>
      </CardContent>
    </Card>
  )
}
