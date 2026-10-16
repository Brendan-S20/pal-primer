// "How we get in" on the portal's property tab (#410), for a client with a
// dog-walking plan. Draws nothing for anyone else, so a pet-waste client's
// tab is unchanged.
//
// The two codes are write-only: the card says "On file" or "Not set" and
// offers a box to type a new one, or Remove. It never has the value to show,
// because portalGetAccess never sends it.
//
// One form per address. Every control is at least 44px on touch, and the
// fields stack below `sm`.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  KEY_LOCATION_MAX,
  portalGetAccess,
  portalUpdateAccess,
  type PortalAccess,
} from "@/lib/portal-access.functions";
import {
  ACCESS_CODE_MAX,
  ACCESS_METHODS,
  ACCESS_METHOD_LABEL,
  isAccessMethod,
} from "@/lib/walk-access";
import { usePortalCtx } from "@/lib/portal-ui";

const selectClass =
  "h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm touch:min-h-11";

export function WalkAccessCard() {
  const { token, verified } = usePortalCtx();
  const getFn = useServerFn(portalGetAccess);
  const q = useQuery({
    queryKey: ["portal", token, "access"],
    queryFn: () => getFn({ data: { token } }),
    enabled: verified,
    staleTime: 30_000,
  });
  const properties = q.data?.properties ?? [];
  if (properties.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold">
        <KeyRound className="h-4 w-4 shrink-0" /> How we get in
      </h2>
      <p className="mb-2 text-xs text-muted-foreground">
        Once saved, a code shows here as On file. Only your walker and our office can see it.
      </p>
      <ul className="space-y-3">
        {properties.map((p) => (
          <AccessForm key={p.propertyId} access={p} showAddress={properties.length > 1} />
        ))}
      </ul>
    </section>
  );
}

function AccessForm({ access, showAddress }: { access: PortalAccess; showAddress: boolean }) {
  const { token } = usePortalCtx();
  const qc = useQueryClient();
  const saveFn = useServerFn(portalUpdateAccess);
  const [method, setMethod] = useState(access.accessMethod ?? "");
  const [keyLocation, setKeyLocation] = useState(access.keyLocation ?? "");
  const [lockBox, setLockBox] = useState("");
  const [doorCode, setDoorCode] = useState("");
  useEffect(() => {
    setMethod(access.accessMethod ?? "");
    setKeyLocation(access.keyLocation ?? "");
  }, [access.accessMethod, access.keyLocation]);

  const id = access.propertyId;
  const mut = useMutation({
    mutationFn: (change: {
      accessMethod?: string | null;
      keyLocation?: string | null;
      lockBoxCode?: string | null;
      doorCode?: string | null;
    }) => saveFn({ data: { token, propertyId: id, ...(change as any) } }),
    onSuccess: () => {
      setLockBox("");
      setDoorCode("");
      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["portal", token, "access"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const methodChanged = method !== (access.accessMethod ?? "");
  const keyChanged = keyLocation.trim() !== (access.keyLocation ?? "").trim();
  const dirty = methodChanged || keyChanged || !!lockBox.trim() || !!doorCode.trim();

  const save = () =>
    mut.mutate({
      ...(methodChanged ? { accessMethod: isAccessMethod(method) ? method : null } : {}),
      ...(keyChanged ? { keyLocation: keyLocation.trim() || null } : {}),
      ...(lockBox.trim() ? { lockBoxCode: lockBox.trim() } : {}),
      ...(doorCode.trim() ? { doorCode: doorCode.trim() } : {}),
    });

  return (
    <li className="space-y-3 rounded-md border bg-card p-3 text-sm">
      {showAddress && (
        <p className="break-words font-medium">
          {access.label ? `${access.label}: ${access.street ?? ""}` : access.street}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`access-method-${id}`} className="text-xs">
            Way in
          </Label>
          <select
            id={`access-method-${id}`}
            className={selectClass}
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            <option value="">Not set</option>
            {ACCESS_METHODS.map((m) => (
              <option key={m} value={m}>
                {ACCESS_METHOD_LABEL[m]}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`access-key-${id}`} className="text-xs">
            Where the key is (optional)
          </Label>
          <Input
            id={`access-key-${id}`}
            value={keyLocation}
            maxLength={KEY_LOCATION_MAX}
            onChange={(e) => setKeyLocation(e.target.value)}
            placeholder="With the neighbor at number 14"
            className="touch:min-h-11"
          />
        </div>
        <CodeField
          id={`access-lockbox-${id}`}
          label="Lock box code"
          isSet={access.lockBoxSet}
          value={lockBox}
          onChange={setLockBox}
          onRemove={() => mut.mutate({ lockBoxCode: null })}
          pending={mut.isPending}
        />
        <CodeField
          id={`access-door-${id}`}
          label="Door or gate code"
          isSet={access.doorCodeSet}
          value={doorCode}
          onChange={setDoorCode}
          onRemove={() => mut.mutate({ doorCode: null })}
          pending={mut.isPending}
        />
      </div>
      <div className="flex justify-end">
        <Button disabled={!dirty || mut.isPending} onClick={save}>
          {mut.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </li>
  );
}

function CodeField({
  id,
  label,
  isSet,
  value,
  onChange,
  onRemove,
  pending,
}: {
  id: string;
  label: string;
  isSet: boolean;
  value: string;
  onChange: (v: string) => void;
  onRemove: () => void;
  pending: boolean;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <Label htmlFor={id} className="min-w-0 text-xs">
          {label}
        </Label>
        <span className="min-w-0 text-xs text-muted-foreground">{isSet ? "On file" : "Not set"}</span>
      </div>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="password"
          autoComplete="off"
          inputMode="text"
          value={value}
          maxLength={ACCESS_CODE_MAX}
          onChange={(e) => onChange(e.target.value)}
          placeholder={isSet ? "Type a new code to replace it" : "Type the code"}
          className="min-w-0 flex-1 touch:min-h-11"
        />
        {isSet && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={onRemove}
            className="shrink-0"
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
