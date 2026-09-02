interface AmbientTarget<T> {
  candidate: T;
  id: string;
  triggers: readonly string[];
}

function ambientTriggerMatches(normalizedBody: string, trigger: string): boolean {
  const normalized = trigger.trim().toLocaleLowerCase();
  if (!normalized) return false;
  if (/^[\p{L}\p{N}_-]+$/u.test(normalized)) {
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}($|[^\\p{L}\\p{N}_-])`, 'u')
      .test(normalizedBody);
  }
  return normalizedBody.includes(normalized);
}

export function matchesAmbientTriggers(body: string, triggers: readonly string[]): boolean {
  const normalizedBody = body.toLocaleLowerCase();
  return triggers.some((trigger) => ambientTriggerMatches(normalizedBody, trigger));
}

export function selectAmbientTarget<T>(body: string, targets: readonly AmbientTarget<T>[]): T | undefined {
  const normalizedBody = body.toLocaleLowerCase();
  return targets
    .map((target) => ({
      target,
      score: target.triggers.reduce(
        (score, trigger) => score + (ambientTriggerMatches(normalizedBody, trigger)
          ? trigger.trim().length
          : 0),
        0
      )
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score
      || left.target.id.localeCompare(right.target.id))[0]
    ?.target.candidate;
}
