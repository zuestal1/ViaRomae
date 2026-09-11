import { useState, type FormEvent } from "react";
import { useGMAuth } from "../contexts/AuthContext";
export function LoginPage() {
  const { login } = useGMAuth(); const [code, setCode] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(""); try { await login(code); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <main className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-100"><form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-xl border border-slate-700 bg-slate-900 p-8"><h1 className="text-2xl font-bold">GM-Anmeldung</h1><label className="block text-sm">Zugangscode<input autoFocus type="password" value={code} onChange={e => setCode(e.target.value)} className="mt-2 w-full rounded bg-slate-800 p-3" /></label>{error && <p className="text-sm text-red-400">{error}</p>}<button disabled={busy || code.length < 4} className="w-full rounded bg-blue-600 p-3 font-bold disabled:opacity-50">{busy ? "Anmeldung…" : "Anmelden"}</button></form></main>;
}
