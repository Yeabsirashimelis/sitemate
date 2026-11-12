import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Send, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button, Dialog, Empty, ErrorNote, Field, Input, Loading, PageHeader, Select, Status, Table, Td, Th } from "../components/ui";
import { api } from "../lib/api";
import { useCan } from "../lib/auth";
import { longDate, roleLabel } from "../lib/format";
import { keys, useUsers } from "../lib/queries";
import type { Role, User } from "../lib/types";

const DASHBOARD: Role[] = ["owner", "project_manager", "site_engineer"];

function AddPersonDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: "", role: "supervisor" as Role, email: "", password: "", language: "en" });
  const needsLogin = DASHBOARD.includes(form.role);
  const create = useMutation({
    mutationFn: () =>
      api("/users", {
        body: {
          name: form.name,
          role: form.role,
          language: form.language,
          ...(needsLogin ? { email: form.email, password: form.password } : {}),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.users });
      setForm({ name: "", role: "supervisor", email: "", password: "", language: "en" });
      onClose();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <Dialog open={open} onClose={onClose} title="Add a person">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name">
          <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Role">
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {(["project_manager", "site_engineer", "supervisor", "subcontractor", "consultant"] as Role[]).map((r) => (
                <option key={r} value={r}>
                  {roleLabel[r]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Language on Telegram">
            <Select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
              <option value="en">English</option>
              <option value="am">Amharic</option>
            </Select>
          </Field>
        </div>
        {needsLogin ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Email">
              <Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="First password" hint="At least 8 characters">
              <Input type="password" required minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </Field>
          </div>
        ) : (
          <p className="text-[13px] text-ink-2">Supervisors, subcontractors and the consultant only use Telegram. After adding them, send them an invite code. The consultant receives approved RFIs there and answers them.</p>
        )}
        <ErrorNote error={create.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={create.isPending}>
            Add
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function InviteDialog({ user, onClose }: { user: Pick<User, "id" | "name"> | null; onClose: () => void }) {
  const invite = useMutation({
    mutationFn: (id: string) => api<{ code: string; link: string | null; expiresAt: string }>(`/users/${id}/telegram-invite`, { method: "POST" }),
  });
  const open = user !== null;
  return (
    <Dialog
      open={open}
      onClose={() => {
        invite.reset();
        onClose();
      }}
      title={`Link ${user?.name ?? ""} to Telegram`}
    >
      {invite.data ? (
        <div className="flex flex-col gap-3 text-[14px]">
          <p>Send this to {user?.name}. They open the bot and send:</p>
          <div className="rounded-[4px] bg-sunken px-4 py-3 font-mono text-[18px] tracking-[0.08em]">/start {invite.data.code}</div>
          {invite.data.link ? (
            <p className="text-[13px] text-ink-2">
              Or the direct link:{" "}
              <a href={invite.data.link} className="underline underline-offset-2" target="_blank" rel="noreferrer">
                {invite.data.link}
              </a>
            </p>
          ) : null}
          <p className="text-[12px] text-ink-3">The code works once and expires {longDate(invite.data.expiresAt)}.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[14px]">SiteMate will create a one-time code. When {user?.name} sends it to the bot, their Telegram is linked and the agents can reach them.</p>
          <ErrorNote error={invite.error} />
          <div className="flex justify-end">
            <Button variant="primary" busy={invite.isPending} onClick={() => user && invite.mutate(user.id)}>
              Create code
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function TeamPage() {
  const { data, isLoading, error } = useUsers();
  const can = useCan();
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState<User | null>(null);
  const users = (data?.users ?? []).filter((u) => u.role !== "supplier");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Team"
        meta="Who works with SiteMate, and whether the agents can reach them on Telegram."
        actions={
          can.manage ? (
            <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)}>
              Add person
            </Button>
          ) : null
        }
      />
      <ErrorNote error={error} />
      {isLoading ? <Loading /> : null}
      {users.length === 0 && !isLoading ? <Empty title="No one here yet" /> : null}
      {users.length > 0 ? (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Role</Th>
              <Th>Sign in</Th>
              <Th>Telegram</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <Td className="font-medium">{u.name}</Td>
                <Td>{roleLabel[u.role]}</Td>
                <Td className="text-ink-2">{u.email ?? "Telegram only"}</Td>
                <Td>{u.telegramUserId ? <Status tone="good">Linked</Status> : <Status tone="neutral">Not linked</Status>}</Td>
                <Td align="right">
                  {can.manage && !u.telegramUserId ? (
                    <Button size="sm" variant="ghost" icon={<Send className="size-3.5" />} onClick={() => setInviting(u)}>
                      Invite code
                    </Button>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
      <AddPersonDialog open={adding} onClose={() => setAdding(false)} />
      <InviteDialog user={inviting} onClose={() => setInviting(null)} />
    </div>
  );
}
