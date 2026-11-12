import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { AuthLayout } from "../components/auth-layout";
import { Button, ErrorNote, Field, Input } from "../components/ui";
import { useAuth } from "../lib/auth";

export function SignupPage() {
  const { session, signUp } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ companyName: "", name: "", email: "", password: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to="/" replace />;

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: event.target.value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signUp({ companyName: form.companyName.trim(), name: form.name.trim(), email: form.email.trim(), password: form.password });
      navigate("/", { replace: true });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <form onSubmit={submit}>
        <h1 className="text-[22px] font-semibold tracking-[-0.01em]">Create your company</h1>
        <p className="mt-1 text-[13px] text-ink-2">You start as the owner. Add your project managers and supervisors once you are in.</p>
        <div className="mt-7 flex flex-col gap-4">
          <Field label="Company name">
            <Input required minLength={2} autoComplete="organization" placeholder="Abay Construction PLC" value={form.companyName} onChange={set("companyName")} autoFocus />
          </Field>
          <Field label="Your name">
            <Input required minLength={2} autoComplete="name" value={form.name} onChange={set("name")} />
          </Field>
          <Field label="Work email">
            <Input type="email" required autoComplete="email" value={form.email} onChange={set("email")} />
          </Field>
          <Field label="Password" hint="At least 8 characters">
            <Input type="password" required minLength={8} autoComplete="new-password" value={form.password} onChange={set("password")} />
          </Field>
          <ErrorNote error={error} />
          <Button variant="primary" type="submit" busy={busy} className="mt-1 w-full">
            Create account
          </Button>
        </div>
      </form>
      <p className="mt-8 border-t border-rule pt-5 text-[13px] text-ink-2">
        Already have an account?{" "}
        <Link to="/login" className="font-medium text-ink underline underline-offset-2">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
