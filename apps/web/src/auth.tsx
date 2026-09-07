/**
 * Auth state for the SPA. The API issues a JWT on signup/login; we keep it
 * in localStorage and send it as `Authorization: Bearer <token>` on
 * protected calls (see api.ts). localStorage (not an httpOnly cookie)
 * because the frontend and API are served from different origins in the
 * deployed demo, which makes cookie auth awkward; the tradeoff is XSS
 * exposure, mitigated by React's default escaping and no third-party
 * script injection.
 */
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  ReactNode,
} from "react";
import { authMe, setToken, getToken } from "./api";

export interface User {
  id: number;
  email: string;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  setSession: (token: string, user: User) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  setSession: () => {},
  logout: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // On boot, if we have a stored token, verify it and hydrate the user.
  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    authMe()
      .then((u) => setUser(u))
      .catch(() => {
        setToken(null);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const setSession = useCallback((token: string, u: User) => {
    setToken(token);
    setUser(u);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, setSession, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
