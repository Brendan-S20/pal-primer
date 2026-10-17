/** The same plan-first dog count used by public.walk_dogs_on_visit. */
export function dogsOnWalk(planDogs: number | null | undefined, activeDogs: number): number {
  return Math.max(planDogs ?? activeDogs, 1);
}

export type WalkGroupVisit = {
  id: string;
  serviceId: string | null;
  groupId: string | null;
  client: string;
  dogs: string[];
  dogCount: number;
  status: string;
};

export type WalkGroupSummary = {
  id: string;
  serviceId: string;
  service: string;
  maxDogs: number;
  walkerId: string | null;
  earliestTime: string | null;
  latestTime: string | null;
  members: WalkGroupVisit[];
};
