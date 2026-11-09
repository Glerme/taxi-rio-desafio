import { useEffect, useState } from 'react'
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
    <main className="mx-auto max-w-3xl space-y-4 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Taxi.Rio</h1>
        {session && (
          <div className="flex items-center gap-3 text-sm">
            <span>{session.sub} ({session.role})</span>
            <Button variant="outline" onClick={logout}>Sair</Button>
          </div>
        )}
      </header>
      {!session ? (
        <Login onLogin={login} />
      ) : session.role === 'motorista' ? (
        <Motorista token={session.token} />
      ) : (
        <Passageiro token={session.token} />
      )}
      <Toaster />
    </main>
  )
}
