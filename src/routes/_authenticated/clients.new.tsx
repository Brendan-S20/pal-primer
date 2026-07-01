import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { createClient } from "@/lib/clients.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

export const Route = createFileRoute("/_authenticated/clients/new")({
  component: NewClient,
});

function NewClient() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fn = useServerFn(createClient);

  const [displayName, setDisplayName] = useState("");
  const [accountType, setAccountType] = useState<"residential" | "commercial">("residential");
  const [primaryEmail, setPrimaryEmail] = useState("");
  const [primaryPhone, setPrimaryPhone] = useState("");

  type CreateInput = {
    displayName: string;
    accountType: "residential" | "commercial";
    primaryEmail?: string;
    primaryPhone?: string;
  };
  const mutation = useMutation({
    mutationFn: (v: CreateInput) => fn({ data: v }),
    onSuccess: ({ id }) => {
      qc.invalidateQueries({ queryKey: ["clients"] });
      qc.invalidateQueries({ queryKey: ["my-org"] });
      navigate({ to: "/clients/$clientId", params: { clientId: id } });
    },
  });

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <Link to="/clients" className="text-sm text-muted-foreground hover:underline">
          ← Clients
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">New client</h1>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate({
            displayName,
            accountType,
            primaryEmail: primaryEmail || undefined,
            primaryPhone: primaryPhone || undefined,
          });
        }}
        className="space-y-5 rounded-lg border bg-card p-6"
      >
        <div className="space-y-2">
          <Label>Account type</Label>
          <RadioGroup
            value={accountType}
            onValueChange={(v) => setAccountType(v as typeof accountType)}
            className="flex gap-6"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="residential" id="rt-res" />
              <Label htmlFor="rt-res" className="font-normal">Residential</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="commercial" id="rt-com" />
              <Label htmlFor="rt-com" className="font-normal">Commercial / HOA</Label>
            </div>
          </RadioGroup>
        </div>

        <div className="space-y-2">
          <Label htmlFor="nc-name">Display name</Label>
          <Input id="nc-name" required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="nc-email">Email</Label>
            <Input id="nc-email" type="email" value={primaryEmail} onChange={(e) => setPrimaryEmail(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="nc-phone">Phone</Label>
            <Input id="nc-phone" value={primaryPhone} onChange={(e) => setPrimaryPhone(e.target.value)} />
          </div>
        </div>

        {mutation.isError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {(mutation.error as Error).message}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Link to="/clients">
            <Button type="button" variant="ghost">Cancel</Button>
          </Link>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Creating…" : "Create client"}
          </Button>
        </div>
      </form>
    </div>
  );
}
