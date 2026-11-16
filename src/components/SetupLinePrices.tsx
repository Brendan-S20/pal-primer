import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useOrgServices } from "@/components/client-detail/ServicePicker";
import { setSetupStayPrices } from "@/lib/setup-stay-prices.functions";
import {
  SETUP_SIZES,
  setupGroomProblem,
  setupPriceCents,
  setupSizeRules,
  setupStayPricesProblem,
  setupTrainingProblem,
  stayUnitLabel,
  type SetupSizeRow,
} from "@/lib/setup-line-prices";
import { stepSave } from "@/lib/setup-step-save";
import { PET_SIZE_LABEL, type PetSize } from "@/lib/groom";
import { listServiceSizeRules, upsertServiceSizeRule } from "@/lib/groom.functions";
import { getVaccineSettings, setVaccineSettings } from "@/lib/vaccines.functions";
import { REQUIRED_VACCINES, VACCINE_LABELS, type VaccineRule } from "@/lib/vaccines";
import {
  ensureTrainingCatalog,
  listServicePackages,
  saveServicePackage,
  setServicePackageActive,
} from "@/lib/training-packages.functions";
import { listTrainingSkills, saveTrainingSkill } from "@/lib/training-progress.functions";

// ── /setup, step 2: what a stay, a groom and a lesson cost (#959) ─────────
//
// The walks moved off a Settings button in #769. Sitting, grooming and
// training were still that button, so an owner who did not follow it
// finished setup quoting the seeded starters, with an empty size grid, or
// with a lesson package nobody could buy. Each is asked HERE now, the same
// way: a small form, its own Save, the setup save contract (stepSave), and
// the same queries Settings → Services reads, so a price saved here is the
// price Settings and the new-client Plan step show without a reload.
//
// Holiday dates, the deposit refund window, coat rules and session rules
// stay on Settings, Services: setup asks for prices, not every setting.
//
// Office-only (owner, office manager), so English.

const money = (cents: number | null | undefined) =>
  cents != null && cents > 0 ? (cents / 100).toFixed(2) : "";

function SaveRow({
  pending,
  label,
  action,
  problem,
}: {
  pending: boolean;
  label: string;
  action: string;
  problem: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="submit" disabled={pending} data-setup-action={action} className="shrink-0">
        {pending ? "Saving…" : label}
      </Button>
      {problem && (
        <p role="alert" className="min-w-0 text-sm text-destructive" data-setup-line-error>
          {problem}
        </p>
      )}
    </div>
  );
}

const settingsLink = (
  <Link to="/settings/services" className="underline">
    Settings, Services
  </Link>
);

// ── Sitting ────────────────────────────────────────────────────────────────

export function StayPricesForm({
  done,
  onSaved,
  saveLabel = "Save and continue",
}: {
  done: boolean;
  onSaved: () => void;
  saveLabel?: string;
}) {
  const qc = useQueryClient();
  const saveFn = useServerFn(setSetupStayPrices);
  const { services, isLoading } = useOrgServices();
  const stays = services.filter((s) => s.service_line === "pet_sitting" && s.active);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const valueOf = (id: string, cents: number | null) => typed[id] ?? money(cents);

  const m = useMutation(
    stepSave({
      qc,
      save: async () => {
        const rows = stays.map((s) => ({
          id: s.id,
          name: s.name,
          cents: setupPriceCents(valueOf(s.id, s.base_price_cents)),
        }));
        const refused = setupStayPricesProblem(rows);
        if (refused) throw new Error(refused);
        await saveFn({
          data: { prices: rows.map(({ id, cents }) => ({ id, cents: cents as number })) },
        });
      },
      refresh: [["services"], ["onboarding-status"]],
      saved: () => {
        toast.success("Stay prices saved");
        setTyped({});
        setProblem(null);
      },
      onFailed: setProblem,
      onSaved,
    }),
  );

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading your stays…</p>;
  if (stays.length === 0)
    return <p className="text-sm">You have no stays to price yet. Add one in {settingsLink}.</p>;

  return (
    <form
      className="space-y-4"
      data-setup-stay-prices
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {stays.map((s) => (
          <div key={s.id} className="min-w-0 space-y-1.5">
            <Label htmlFor={`setup-stay-${s.id}`}>
              <bdi>{s.name}</bdi> ($ {stayUnitLabel(s.price_unit)})
            </Label>
            <Input
              id={`setup-stay-${s.id}`}
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              required
              value={valueOf(s.id, s.base_price_cents)}
              onChange={(e) => setTyped((t) => ({ ...t, [s.id]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {done
          ? "Saved. Change a price and save again any time."
          : "A price already filled in is a starter. Change it or keep it, then save so setup knows you chose it."}{" "}
        Extra-pet charges, holiday dates and the deposit refund window are in {settingsLink}.
      </p>
      <SaveRow
        pending={m.isPending}
        label={done ? "Save stay prices" : saveLabel}
        action="save-stays"
        problem={problem}
      />
    </form>
  );
}

// ── Grooming ───────────────────────────────────────────────────────────────

export function GroomSetupForm({
  done,
  onSaved,
  saveLabel = "Save and continue",
}: {
  done: boolean;
  onSaved: () => void;
  saveLabel?: string;
}) {
  const { services, isLoading } = useOrgServices();
  const grooms = services.filter((s) => s.service_line === "mobile_grooming" && s.active);
  const [chosen, setChosen] = useState<string>("");
  const service = grooms.find((g) => g.id === chosen) ?? grooms[0];
  const getVaccines = useServerFn(getVaccineSettings);
  const vaccinesQ = useQuery({ queryKey: ["vaccine-settings"], queryFn: () => getVaccines() });

  if (isLoading || vaccinesQ.isLoading)
    return <p className="text-sm text-muted-foreground">Loading your grooming setup…</p>;
  if (!service)
    return <p className="text-sm">You have no grooms to price yet. Add one in {settingsLink}.</p>;
  if (vaccinesQ.error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {(vaccinesQ.error as Error).message}
      </p>
    );
  const v = vaccinesQ.data!;
  return (
    <div className="space-y-4">
      {grooms.length > 1 && (
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="setup-groom-service">Size prices for</Label>
          <select
            id="setup-groom-service"
            value={service.id}
            onChange={(e) => setChosen(e.target.value)}
            className="min-h-11 w-full max-w-sm rounded-md border bg-background px-3 text-sm"
          >
            {grooms.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <GroomForm
        key={service.id}
        serviceId={service.id}
        serviceMinutes={service.default_duration_min}
        initial={{ rule: v.rule, required: v.required, bufferMin: v.bufferMin }}
        done={done}
        onSaved={onSaved}
        saveLabel={saveLabel}
      />
    </div>
  );
}

function GroomForm({
  serviceId,
  serviceMinutes,
  initial,
  done,
  onSaved,
  saveLabel,
}: {
  serviceId: string;
  serviceMinutes: number | null;
  initial: { rule: VaccineRule; required: string[]; bufferMin: number };
  done: boolean;
  onSaved: () => void;
  saveLabel: string;
}) {
  const qc = useQueryClient();
  const listRules = useServerFn(listServiceSizeRules);
  const upsertRule = useServerFn(upsertServiceSizeRule);
  const saveVaccines = useServerFn(setVaccineSettings);
  const rulesKey = ["service-size-rules", serviceId];
  const rulesQ = useQuery({
    queryKey: rulesKey,
    queryFn: () => listRules({ data: { serviceId } }),
  });
  const plain = (size: PetSize) =>
    (rulesQ.data?.rules ?? []).find((r) => r.size === size && r.coat_type === null);
  const [typed, setTyped] = useState<
    Partial<Record<PetSize, { price?: string; minutes?: string }>>
  >({});
  const rowOf = (size: PetSize): SetupSizeRow => {
    const r = plain(size);
    return {
      size,
      price: typed[size]?.price ?? money(r?.price_cents),
      minutes:
        typed[size]?.minutes ??
        (r ? String(r.duration_min) : serviceMinutes ? String(serviceMinutes) : ""),
    };
  };
  const type = (size: PetSize, k: "price" | "minutes", value: string) =>
    setTyped((t) => ({ ...t, [size]: { ...t[size], [k]: value } }));

  const [rule, setRule] = useState<VaccineRule>(initial.rule);
  const [required, setRequired] = useState(
    initial.required as (typeof REQUIRED_VACCINES)[number][],
  );
  const [buffer, setBuffer] = useState(String(initial.bufferMin));
  const [problem, setProblem] = useState<string | null>(null);

  const m = useMutation(
    stepSave({
      qc,
      save: async () => {
        const rows = SETUP_SIZES.map(rowOf);
        const refused = setupGroomProblem({
          rows,
          bufferMin: buffer,
          sizeLabel: (s) => PET_SIZE_LABEL[s],
        });
        if (refused) throw new Error(refused);
        // The grid first: the review stamp is the last write, so a grid that
        // failed part-way never leaves the part marked reviewed on its own.
        for (const r of setupSizeRules(rows)) {
          await upsertRule({
            data: {
              id: plain(r.size)?.id,
              serviceId,
              size: r.size,
              coatType: null,
              durationMin: r.durationMin,
              priceCents: r.priceCents,
            },
          });
        }
        await saveVaccines({
          data: { rule, required, setupReviewed: true, bufferMin: Number(buffer) },
        });
      },
      refresh: [["service-size-rules"], ["vaccine-settings"], ["services"], ["onboarding-status"]],
      saved: () => {
        toast.success("Grooming setup saved");
        setTyped({});
        setProblem(null);
      },
      onFailed: setProblem,
      onSaved,
    }),
  );

  return (
    <form
      className="space-y-4"
      data-setup-groom
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <fieldset className="min-w-0 space-y-2">
        <legend className="text-sm font-medium">Price by size, per pet</legend>
        {rulesQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading the size grid…</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {SETUP_SIZES.map((size) => {
              const row = rowOf(size);
              return (
                <div
                  key={size}
                  className="grid min-w-0 grid-cols-2 gap-2 rounded-md border p-3"
                  data-setup-size={size}
                >
                  <p className="col-span-2 text-sm font-medium">{PET_SIZE_LABEL[size]}</p>
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor={`setup-size-${size}-price`}>Price ($)</Label>
                    <Input
                      id={`setup-size-${size}-price`}
                      type="number"
                      inputMode="decimal"
                      min="0.01"
                      step="0.01"
                      value={row.price}
                      onChange={(e) => type(size, "price", e.target.value)}
                    />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor={`setup-size-${size}-minutes`}>Minutes</Label>
                    <Input
                      id={`setup-size-${size}-minutes`}
                      inputMode="numeric"
                      value={row.minutes}
                      onChange={(e) => type(size, "minutes", e.target.value)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Price at least one size. A size left blank uses the groom's own price. Coat rules are in{" "}
          {settingsLink}.
        </p>
      </fieldset>
      <div className="min-w-0 space-y-1.5">
        <Label htmlFor="setup-vaccine-rule">When a required vaccine is expired or missing</Label>
        <select
          id="setup-vaccine-rule"
          value={rule}
          onChange={(e) => setRule(e.target.value as VaccineRule)}
          className="min-h-11 w-full max-w-sm rounded-md border bg-background px-3 text-sm"
        >
          <option value="off">Off</option>
          <option value="warn">Warn the office</option>
          <option value="block">Block the booking</option>
        </select>
      </div>
      <fieldset className="min-w-0">
        <legend className="text-sm font-medium">Required vaccines</legend>
        <div className="grid gap-x-4 sm:grid-cols-2">
          {REQUIRED_VACCINES.map((vac) => (
            <label key={vac} className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={required.includes(vac)}
                onChange={(e) =>
                  setRequired(
                    e.target.checked ? [...required, vac] : required.filter((r) => r !== vac),
                  )
                }
              />
              {VACCINE_LABELS[vac]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="min-w-0 space-y-1.5">
        <Label htmlFor="setup-groom-buffer">Setup, cleanup and travel minutes</Label>
        <Input
          id="setup-groom-buffer"
          inputMode="numeric"
          value={buffer}
          onChange={(e) => setBuffer(e.target.value)}
          className="w-24"
        />
        <p className="text-xs text-muted-foreground">
          A booking holds the groom plus these minutes, to set up, clean up and drive.
        </p>
      </div>
      <SaveRow
        pending={m.isPending}
        label={done ? "Save grooming setup" : saveLabel}
        action="save-grooms"
        problem={problem}
      />
    </form>
  );
}

// ── Training ───────────────────────────────────────────────────────────────

export function TrainingSetupForm({
  done,
  onSaved,
  saveLabel = "Save and continue",
}: {
  done: boolean;
  onSaved: () => void;
  saveLabel?: string;
}) {
  const qc = useQueryClient();
  const ensure = useServerFn(ensureTrainingCatalog);
  const listPackages = useServerFn(listServicePackages);
  const listSkills = useServerFn(listTrainingSkills);
  const savePackage = useServerFn(saveServicePackage);
  const activate = useServerFn(setServicePackageActive);
  const saveSkill = useServerFn(saveTrainingSkill);
  // Settings, Services seeds the package and the starter skills on first
  // open; setup is now where a trainer prices them, so it does the same.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    void ensure()
      .then(() => {
        void qc.invalidateQueries({ queryKey: ["service-packages"] });
        void qc.invalidateQueries({ queryKey: ["training-skills"] });
        void qc.invalidateQueries({ queryKey: ["services"] });
      })
      .catch(() => {});
  }, [ensure, qc]);
  const packagesQ = useQuery({ queryKey: ["service-packages"], queryFn: () => listPackages() });
  const skillsQ = useQuery({ queryKey: ["training-skills"], queryFn: () => listSkills() });
  const pkg = packagesQ.data?.packages[0];
  const skills = (skillsQ.data?.skills ?? []).filter((s) => s.active);

  const [price, setPrice] = useState<string | null>(null);
  const [sessions, setSessions] = useState<string | null>(null);
  const [newSkill, setNewSkill] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const priceValue = price ?? money(pkg?.price_cents);
  const sessionsValue = sessions ?? (pkg ? String(pkg.sessions_count) : "6");

  const m = useMutation(
    stepSave({
      qc,
      save: async () => {
        if (!pkg) throw new Error("There is no lesson package to price yet.");
        const cents = setupPriceCents(priceValue);
        const refused = setupTrainingProblem({
          priceCents: cents,
          sessions: sessionsValue,
          hasSkill: skills.length > 0,
          newSkill,
        });
        if (refused) throw new Error(refused);
        await savePackage({
          data: {
            id: pkg.id,
            serviceId: pkg.service_id,
            name: pkg.name,
            sessionsCount: Number(sessionsValue),
            priceCents: cents as number,
            expiresAfterDays: pkg.expires_after_days,
          },
        });
        if (!pkg.active) await activate({ data: { id: pkg.id, active: true } });
        if (newSkill.trim()) await saveSkill({ data: { name: newSkill.trim() } });
      },
      refresh: [["service-packages"], ["training-skills"], ["services"], ["onboarding-status"]],
      saved: () => {
        toast.success("Lesson package saved");
        setPrice(null);
        setSessions(null);
        setNewSkill("");
        setProblem(null);
      },
      onFailed: setProblem,
      onSaved,
    }),
  );

  if (packagesQ.isLoading || skillsQ.isLoading)
    return <p className="text-sm text-muted-foreground">Loading your lessons…</p>;
  if (!pkg)
    return (
      <p className="text-sm">You have no lesson package to price yet. Add one in {settingsLink}.</p>
    );

  return (
    <form
      className="space-y-4"
      data-setup-training
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="setup-package-price">
            <bdi>{pkg.name}</bdi> ($)
          </Label>
          <Input
            id="setup-package-price"
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
            required
            value={priceValue}
            onChange={(e) => setPrice(e.target.value)}
          />
        </div>
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="setup-package-sessions">Lessons in the package</Label>
          <Input
            id="setup-package-sessions"
            inputMode="numeric"
            required
            value={sessionsValue}
            onChange={(e) => setSessions(e.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Saving turns the package on, so clients can buy it.
      </p>
      <div className="min-w-0 space-y-1.5">
        <p className="text-sm font-medium">Skills a trainer scores</p>
        {skills.length > 0 ? (
          <ul className="flex flex-wrap gap-2" data-setup-skills>
            {skills.map((s) => (
              <li key={s.id} className="min-w-0 rounded-md border px-2 py-1 text-sm">
                <bdi>{s.name}</bdi>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No skills yet. Add at least one.</p>
        )}
        <Label htmlFor="setup-new-skill" className="sr-only">
          Add a skill
        </Label>
        <Input
          id="setup-new-skill"
          placeholder={skills.length > 0 ? "Add another skill (optional)" : "A skill, like Sit"}
          value={newSkill}
          maxLength={80}
          required={skills.length === 0}
          onChange={(e) => setNewSkill(e.target.value)}
          className="max-w-sm"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        More packages, renaming skills and lesson rules are in {settingsLink}.
      </p>
      <SaveRow
        pending={m.isPending}
        label={done ? "Save lessons" : saveLabel}
        action="save-lessons"
        problem={problem}
      />
    </form>
  );
}
