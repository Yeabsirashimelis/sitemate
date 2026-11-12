import { Building2, CheckSquare, LayoutGrid, LogOut, Menu, Moon, Sun, Users, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useAuth } from "../lib/auth";
import { roleLabel } from "../lib/format";
import { useApprovals, usePortfolio } from "../lib/queries";
import { cx } from "./ui";

function Wordmark() {
  return (
    <div className="flex items-center gap-2">
      <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
        <rect width="32" height="32" rx="5" fill="currentColor" />
        <path d="M7 22h18M9 22V12l7-4 7 4v10M13 22v-6h6v6" fill="none" stroke="var(--page)" strokeWidth="2" strokeLinejoin="round" />
      </svg>
      <span className="text-[15px] font-semibold tracking-[-0.01em]">SiteMate</span>
    </div>
  );
}

type Theme = "light" | "dark";

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem("sitemate.theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      // Storage blocked: follow the system.
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("sitemate.theme", theme);
    } catch {
      // Not remembered, which is fine.
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "light" ? "dark" : "light"))];
}

function NavItem({ to, icon, children, count }: { to: string; icon: ReactNode; children: ReactNode; count?: number | undefined }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        cx(
          "flex items-center gap-2.5 rounded-[4px] px-2.5 py-1.5 text-[13px] transition-colors",
          isActive ? "bg-sunken font-medium text-ink" : "text-ink-2 hover:bg-sunken hover:text-ink",
        )
      }
    >
      <span className="text-ink-3">{icon}</span>
      <span className="flex-1 truncate">{children}</span>
      {count ? <span className="rounded-[3px] bg-ink px-1.5 text-[11px] font-medium leading-[18px] text-page tabular">{count}</span> : null}
    </NavLink>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { session, signOut } = useAuth();
  const portfolio = usePortfolio();
  const pending = useApprovals("pending");
  const [theme, toggleTheme] = useTheme();

  return (
    <nav className="flex h-full flex-col gap-6 px-3 py-4" onClick={(event) => (event.target as HTMLElement).closest("a") && onNavigate?.()}>
      <div className="px-2.5">
        <Wordmark />
        <div className="mt-1 truncate text-[12px] text-ink-3">{session?.company.name}</div>
      </div>

      <div className="flex flex-col gap-0.5">
        <NavItem to="/" icon={<LayoutGrid className="size-4" />}>
          Portfolio
        </NavItem>
        <NavItem to="/approvals" icon={<CheckSquare className="size-4" />} count={pending.data?.approvals.length}>
          Approvals
        </NavItem>
        <NavItem to="/team" icon={<Users className="size-4" />}>
          Team
        </NavItem>
      </div>

      <div className="flex min-h-0 flex-col gap-0.5">
        <div className="eyebrow px-2.5 pb-1.5">Projects</div>
        <div className="flex flex-col gap-0.5 overflow-y-auto">
          {portfolio.data?.projects.map((p) => (
            <NavItem key={p.id} to={`/projects/${p.id}`} icon={<Building2 className="size-4" />}>
              {p.name}
            </NavItem>
          ))}
        </div>
      </div>

      <div className="mt-auto border-t border-rule px-2.5 pt-3">
        <div className="truncate text-[13px] font-medium">{session?.user.name}</div>
        <div className="text-[12px] text-ink-3">{session ? roleLabel[session.user.role] : ""}</div>
        <div className="mt-2.5 flex gap-1">
          <button onClick={toggleTheme} className="flex items-center gap-1.5 rounded-[4px] px-2 py-1 text-[12px] text-ink-2 hover:bg-sunken hover:text-ink">
            {theme === "light" ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
            {theme === "light" ? "Dark" : "Light"}
          </button>
          <button onClick={() => void signOut()} className="flex items-center gap-1.5 rounded-[4px] px-2 py-1 text-[12px] text-ink-2 hover:bg-sunken hover:text-ink">
            <LogOut className="size-3.5" /> Sign out
          </button>
        </div>
      </div>
    </nav>
  );
}

export function Shell() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[232px_1fr]">
      <aside className="sticky top-0 hidden h-dvh border-r border-rule bg-page lg:block">
        <Sidebar />
      </aside>

      <div className="sticky top-0 z-20 flex items-center justify-between border-b border-rule bg-page/95 px-4 py-2.5 backdrop-blur lg:hidden">
        <Wordmark />
        <button onClick={() => setOpen(true)} className="rounded p-1.5 text-ink-2" aria-label="Open menu">
          <Menu className="size-5" />
        </button>
      </div>
      {open ? (
        <div className="fixed inset-0 z-30 lg:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[264px] border-r border-rule bg-page">
            <button onClick={() => setOpen(false)} className="absolute right-2 top-3 rounded p-1.5 text-ink-3" aria-label="Close menu">
              <X className="size-4" />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </div>
        </div>
      ) : null}

      <main className="min-w-0 px-4 py-6 sm:px-8 lg:px-10 lg:py-8">
        <div className="mx-auto max-w-[1280px]">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
