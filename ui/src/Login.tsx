import { useRef, useState, type FormEvent } from 'react'
import { Eye, EyeOff, Loader2, LogIn, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

export function Login({ onLogin }: { onLogin: (token: string) => boolean }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const body = await res.json().catch(() => null)
      if (res.ok && typeof body?.token === 'string' && onLogin(body.token)) return
      setError(res.status === 401 ? (body?.message ?? 'Credenciais inválidas') : 'Não foi possível entrar. Tente de novo.')
    } catch {
      setError('Falha de rede. Verifique a conexão e tente de novo.')
    }
    // o botão ficou disabled e o foco caiu no body: devolve ao campo
    setLoading(false)
    ;(password ? passwordRef : emailRef).current?.focus()
  }

  return (
    <Card className="mx-auto mt-6 max-w-md sm:mt-12">
      <CardHeader>
        <CardTitle className="text-3xl">Entrar</CardTitle>
        <p className="text-muted">Peça ou aceite corridas pelo Taxi.Rio.</p>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" aria-describedby={error ? 'login-erro' : undefined}>
          <div className="space-y-1">
            <label htmlFor="email" className="font-semibold">E-mail</label>
            <Input
              id="email"
              ref={emailRef}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={!!error}
              required
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="password" className="font-semibold">Senha</label>
            <div className="relative">
              <Input
                id="password"
                ref={passwordRef}
                type={show ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!error}
                className="pr-12"
                required
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}
                aria-pressed={show}
                className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-muted hover:text-asphalt"
              >
                {show ? <EyeOff aria-hidden size={20} /> : <Eye aria-hidden size={20} />}
              </button>
            </div>
          </div>
          {error && (
            <p id="login-erro" role="alert" className="flex items-start gap-2 font-medium text-danger">
              <TriangleAlert aria-hidden size={20} className="mt-0.5 shrink-0" />
              {error}
            </p>
          )}
          <Button type="submit" disabled={loading} className="w-full">
            {loading ? <Loader2 aria-hidden size={20} className="animate-spin" /> : <LogIn aria-hidden size={20} />}
            {loading ? 'Entrando…' : 'Entrar'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
