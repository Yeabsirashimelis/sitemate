import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, getToken, setToken, setUnauthorizedHandler } from "./api";
import type { Company, User } from "./types";

interface Session {
  user: User;
  company: Company;
}

interface AuthState {
  session: Session | null;
  loading: boolean;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(() => getToken() !== null);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession(null);
      queryClient.clear();
    });
    if (!getToken()) return;
    api<Session>("/auth/me")
      .then(setSession)
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, [queryClient]);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await api<Session & { token: string }>("/auth/login", { body: { email, password } });
    setToken(result.token);
    setSession({ user: result.user, company: result.company });
  }, []);

  const signOut = useCallback(async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    setToken(null);
    setSession(null);
    queryClient.clear();
  }, [queryClient]);

  const value = useMemo(() => ({ session, loading, signIn, signOut }), [session, loading, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}

export function useCan() {
  const role = useAuth().session?.user.role;
  return {
    manage: role === "owner" || role === "project_manager",
    approve: role === "owner" || role === "project_manager",
  };
}
