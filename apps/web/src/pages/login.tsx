import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { Button, ErrorNote, Field, Input } from "../components/ui";
import { useAuth } from "../lib/auth";

export function LoginPage() {
  const { session, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to="/" replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      navigate((location.state as { from?: string } | null)?.from ?? "/", { replace: true });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_minmax(420px,520px)]">
      <div className="hidden border-r border-rule bg-sunken lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
            <rect width="32" height="32" rx="5" fill="currentColor" />
            <path d="M7 22h18M9 22V12l7-4 7 4v10M13 22v-6h6v6" fill="none" stroke="var(--page)" strokeWidth="2" strokeLinejoin="round" />
          </svg>
          <span className="text-[17px] font-semibold">SiteMate</span>
        </div>
        <div className="max-w-md">
          <p className="text-[28px] font-semibold leading-tight tracking-[-0.015em]">The project controls engineer your sites never had.</p>
          <p className="mt-4 text-[15px] leading-relaxed text-ink-2">
            Daily reports from site on Telegram, a schedule that knows what every delay does to the handover, materials ordered before they run out,
            and payment claims backed by the record.
          </p>
        </div>
        <dl className="grid grid-cols-3 gap-6 border-t border-rule-strong pt-6 text-[13px]">
          <div>
            <dt className="text-ink-3">Schedule</dt>
            <dd className="mt-0.5 font-medium">Critical path, every evening</dd>
          </div>
          <div>
            <dt className="text-ink-3">Approvals</dt>
            <dd className="mt-0.5 font-medium">One tap on Telegram</dd>
          </div>
          <div>
            <dt className="text-ink-3">Claims</dt>
            <dd className="mt-0.5 font-medium">Evidence kept as it happens</dd>
          </div>
        </dl>
      </div>

      <div className="flex items-center justify-center px-6 py-12">
        <form onSubmit={submit} className="w-full max-w-[360px]">
          <h1 className="text-[22px] font-semibold tracking-[-0.01em]">Sign in</h1>
          <p className="mt-1 text-[13px] text-ink-2">Owners, project managers and site engineers. Supervisors use SiteMate on Telegram.</p>
          <div className="mt-7 flex flex-col gap-4">
            <Field label="Email">
              <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </Field>
            <Field label="Password">
              <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <ErrorNote error={error} />
            <Button variant="primary" type="submit" busy={busy} className="mt-1 w-full">
              Sign in
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
