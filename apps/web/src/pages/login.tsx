import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { AuthLayout } from "../components/auth-layout";
import { Button, ErrorNote, Field, Input } from "../components/ui";
import { useAuth } from "../lib/auth";

const DEMO = { email: "pm@abay.demo", password: "sitemate-demo" };

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
    <AuthLayout>
      <form onSubmit={submit}>
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

      <div className="mt-8 border-t border-rule pt-5 text-[13px] text-ink-2">
        <p>
          New to SiteMate?{" "}
          <Link to="/signup" className="font-medium text-ink underline underline-offset-2">
            Create an account
          </Link>
        </p>
        <p className="mt-3">
          Just looking? The demo company has two sites with seven weeks of history.{" "}
          <button
            type="button"
            className="font-medium text-ink underline underline-offset-2"
            onClick={() => {
              setEmail(DEMO.email);
              setPassword(DEMO.password);
            }}
          >
            Use the demo account
          </button>
        </p>
      </div>
    </AuthLayout>
  );
}
