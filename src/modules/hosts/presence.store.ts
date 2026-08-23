// In-memory for now — correct as long as this runs as a single instance,
// which is what we have. Once there's more than one instance, every
// function here needs to move to a shared Redis SET instead (per
// BACKEND_PLAN.md §4) so all instances see the same presence state; that's
// a drop-in swap behind these same exports, not a redesign.
const onlineHostIds = new Set<string>();

export function setOnline(hostId: string): void {
  onlineHostIds.add(hostId);
}

export function setOffline(hostId: string): void {
  onlineHostIds.delete(hostId);
}

export function isOnline(hostId: string): boolean {
  return onlineHostIds.has(hostId);
}

export function listOnlineHostIds(): string[] {
  return Array.from(onlineHostIds);
}
