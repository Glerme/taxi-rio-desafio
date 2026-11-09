import { useEffect, useState } from 'react'
import { CarTaxiFront, LogOut, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import { setOnUnauthorized } from '@/lib/api'
import * as auth from '@/lib/auth'
import { Login } from './Login'
import { Motorista } from './Motorista'
import { Passageiro } from './Passageiro'

export default function App() {
  const [session, setSession] = useState(auth.load)

  const logout = () => {
    auth.clear()
    setSession(null)
  }
  useEffect(() => setOnUnauthorized(logout), [])

  function login(token: string) {
    const s = auth.decode(token)
    if (s) {
      auth.save(token)
      setSession(s)
    }
    return !!s
  }

  return (
    <div className="min-h-screen">
      <header className="bg-asphalt text-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <h1 className="flex shrink-0 items-center gap-2 font-display text-3xl font-extrabold tracking-tight">
            <span className="flex size-10 items-center justify-center rounded-lg bg-taxi text-asphalt">
              <CarTaxiFront aria-hidden size={26} />
            </span>
            Taxi.Rio
          </h1>
          {session && (
            <div className="flex min-w-0 items-center gap-1 text-sm">
              <UserRound aria-hidden size={18} className="shrink-0 text-taxi" />
              <span className="min-w-12 truncate" title={session.sub}>
                <span className="sm:hidden">{session.sub.split('@')[0]}</span>
                <span className="hidden sm:inline">{session.sub}</span>
              </span>
              <span className="shrink-0">({session.role})</span>
              <Button variant="ghost" onClick={logout} aria-label="Sair" className="text-white focus-visible:outline-taxi">
                <LogOut aria-hidden size={20} />
                <span className="hidden sm:inline">Sair</span>
              </Button>
            </div>
          )}
        </div>
        <div className="checker" aria-hidden />
      </header>
      <main className="mx-auto max-w-3xl space-y-4 p-4">
        {!session ? (
          <Login onLogin={login} />
        ) : session.role === 'motorista' ? (
          <Motorista token={session.token} />
        ) : (
          <Passageiro token={session.token} />
        )}
      </main>
      <Toaster />
    </div>
  )
}
