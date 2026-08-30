export interface FindingEvidencePresentationInput {
  type: string;
  stableReference: string;
  title: string;
  retrievedAt: string;
  claim: string;
  accessible: boolean;
}

export interface FindingEvidencePresentation {
  href: string | null;
  status: 'available' | 'inaccessible';
  provenance: string;
  title: string;
  claim: string;
}

function safeExternalHref(reference: string): string | null {
  try {
    const url = new URL(reference);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function presentFindingEvidence(
  evidence: FindingEvidencePresentationInput
): FindingEvidencePresentation {
  const type = evidence.type.length > 0
    ? `${evidence.type[0]?.toUpperCase()}${evidence.type.slice(1)}`
    : 'Evidence';
  return {
    href: evidence.accessible && evidence.type === 'external'
      ? safeExternalHref(evidence.stableReference)
      : null,
    status: evidence.accessible ? 'available' : 'inaccessible',
    provenance: `${type} · ${evidence.stableReference} · retrieved ${evidence.retrievedAt}`,
    title: evidence.title,
    claim: evidence.claim
  };
}
