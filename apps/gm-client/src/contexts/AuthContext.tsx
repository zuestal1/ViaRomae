import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { LoginResponse, MeResponse } from "@jlw/contracts";
import { gmFetch } from "../lib/api";

type AuthValue = { account: LoginResponse["account"] | null; ready: boolean; login: (code: string) => Promise<void>; logout: () => void };
const Context = createContext<AuthValue | null>(null);

export function GMAuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<LoginResponse["account"] | null>(null);
  const [ready, setReady] = useState(false);
  const logout = () => { localStorage.removeItem("gm_token"); setAccount(null); };
  useEffect(() => {
    const unauthorized = () => logout();
    window.addEventListener("gm:unauthorized", unauthorized);
    if (!localStorage.getItem("gm_token")) setReady(true);
    else gmFetch<MeResponse>("/auth/me").then(({ account: value }) => {
      if (value.role !== "GM" && value.role !== "ADMIN") throw new Error("GM role required");
      setAccount(value);
    }).catch(logout).finally(() => setReady(true));
    return () => window.removeEventListener("gm:unauthorized", unauthorized);
  }, []);
  const login = async (accessCode: string) => {
    const response = await gmFetch<LoginResponse>("/auth/login", { method: "POST", body: JSON.stringify({ accessCode }) });
    if (response.account.role !== "GM" && response.account.role !== "ADMIN") throw new Error("Dieser Account hat keine Spielleitungsrechte.");
    localStorage.setItem("gm_token", response.token); setAccount(response.account);
  };
  return <Context.Provider value={{ account, ready, login, logout }}>{children}</Context.Provider>;
}
export const useGMAuth = () => { const value = useContext(Context); if (!value) throw new Error("Missing GMAuthProvider"); return value; };
