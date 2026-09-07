import { Link, NavLink, Outlet } from "react-router-dom";
import { useAuth } from "./auth";

export default function App() {
  const { user, logout } = useAuth();

  return (
    <div className="app">
      <header className="navbar">
        <div className="nav-inner">
          <Link to="/" className="brand">
            <span className="brand-mark">VJ</span>
            <span className="brand-name">Virtual Judge</span>
          </Link>

          <nav className="nav-links">
            <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>
              Problems
            </NavLink>
          </nav>

          <div className="nav-auth">
            {user ? (
              <>
                <NavLink
                  to="/profile"
                  className={({ isActive }) => `nav-user ${isActive ? "active" : ""}`}
                >
                  {user.email}
                </NavLink>
                <button className="btn btn-ghost" onClick={logout}>
                  Log out
                </button>
              </>
            ) : (
              <>
                <Link to="/login" className="btn btn-ghost">
                  Log in
                </Link>
                <Link to="/signup" className="btn btn-primary">
                  Sign up
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
