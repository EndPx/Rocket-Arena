import type { FeatureStatusRecord } from '../types/room.js';
import type {
  ReferenceEvidenceRecord,
  TuningApprovalRecord,
  TuningEntry,
  TuningRegistrySnapshot,
} from './model.js';

export type ReleaseGateIssueCode =
  | 'staging-build'
  | 'registry-version-mismatch'
  | 'feature-status-mismatch'
  | 'deferred-feature'
  | 'unverified-hypothesis'
  | 'missing-evidence'
  | 'unapproved-evidence'
  | 'stale-evidence'
  | 'missing-approval'
  | 'stale-approval'
  | 'missing-deterministic-evidence'
  | 'missing-browser-evidence'
  | 'confirmed-change-without-evidence'
  | 'confirmed-change-without-rationale'
  | 'duplicate-record';

export interface ReleaseGateIssue {
  readonly code: ReleaseGateIssueCode;
  readonly tuningId: string | null;
  readonly message: string;
}

export interface ReleaseGateInput {
  readonly snapshot: TuningRegistrySnapshot;
  readonly evidence: readonly ReferenceEvidenceRecord[];
  readonly approvals: readonly TuningApprovalRecord[];
  readonly featureStatus: FeatureStatusRecord;
}

export interface ReleaseGateResult {
  readonly eligible: boolean;
  readonly registryVersion: number;
  readonly issues: readonly ReleaseGateIssue[];
}

function gateIssue(
  code: ReleaseGateIssueCode,
  tuningId: string | null,
  message: string,
): ReleaseGateIssue {
  return Object.freeze({ code, tuningId, message });
}

function nonEmptyStrings(values: readonly string[]): boolean {
  return values.length > 0 && values.every((value) => typeof value === 'string' && value.trim().length > 0);
}

function changedPayload(before: TuningEntry, after: TuningEntry): boolean {
  return JSON.stringify({ value: before.value, range: before.validatedRange })
    !== JSON.stringify({ value: after.value, range: after.validatedRange });
}

/** Pure Mechanics Fidelity release decision; inputs are never mutated. */
export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseGateResult {
  const issues: ReleaseGateIssue[] = [];
  const { snapshot, featureStatus } = input;

  if (featureStatus.buildKind !== 'mechanics-fidelity-release') {
    issues.push(gateIssue('staging-build', null, 'A Hackathon Staging Build cannot claim Mechanics Fidelity Release eligibility.'));
  }
  if (featureStatus.statusVersion !== 1 || featureStatus.registryVersion !== snapshot.version) {
    issues.push(gateIssue('registry-version-mismatch', null, 'Feature status must target the exact pinned registry version.'));
  }
  if (featureStatus.deferred.length > 0) {
    issues.push(gateIssue('deferred-feature', null, 'Mechanics Fidelity Release cannot retain deferred features.'));
  }

  const expectedUnverified = [...snapshot.unverifiedTuningIds].sort();
  const declaredUnverified = [...featureStatus.unverifiedTuningIds].sort();
  if (JSON.stringify(expectedUnverified) !== JSON.stringify(declaredUnverified)) {
    issues.push(gateIssue('feature-status-mismatch', null, 'Feature status unverified IDs must exactly match the pinned registry.'));
  }
  if (declaredUnverified.length > 0) {
    issues.push(gateIssue('unverified-hypothesis', null, 'Mechanics Fidelity Release cannot contain unverified tuning IDs.'));
  }

  const evidenceById = new Map<string, ReferenceEvidenceRecord>();
  for (const record of input.evidence) {
    if (evidenceById.has(record.id)) {
      issues.push(gateIssue('duplicate-record', record.tuningId, `Duplicate evidence record ${record.id}.`));
    } else {
      evidenceById.set(record.id, record);
    }
  }
  const approvalsById = new Map<string, TuningApprovalRecord>();
  for (const record of input.approvals) {
    if (approvalsById.has(record.id)) {
      issues.push(gateIssue('duplicate-record', record.tuningId, `Duplicate approval record ${record.id}.`));
    } else {
      approvalsById.set(record.id, record);
    }
  }

  for (const entry of snapshot.entries) {
    if (entry.classification !== 'unverified-hypothesis') continue;
    if (entry.verificationStatus !== 'verified') {
      issues.push(gateIssue('unverified-hypothesis', entry.id, `${entry.id} remains unverified.`));
    }

    const evidence = entry.evidenceId === null ? undefined : evidenceById.get(entry.evidenceId);
    if (evidence === undefined) {
      issues.push(gateIssue('missing-evidence', entry.id, `${entry.id} requires linked reference evidence.`));
    } else {
      if (evidence.tuningId !== entry.id || evidence.registryVersion !== entry.registryVersion) {
        issues.push(gateIssue('stale-evidence', entry.id, `${entry.id} evidence does not match the accepted entry version.`));
      }
      if (evidence.approvalStatus !== 'approved') {
        issues.push(gateIssue('unapproved-evidence', entry.id, `${entry.id} evidence is not approved.`));
      }
    }

    const approval = entry.approvalId === null ? undefined : approvalsById.get(entry.approvalId);
    if (approval === undefined) {
      issues.push(gateIssue('missing-approval', entry.id, `${entry.id} requires a tuning approval record.`));
      continue;
    }
    if (approval.tuningId !== entry.id || approval.registryVersion !== entry.registryVersion
      || approval.approvedBy.trim().length === 0 || approval.approvedAt.trim().length === 0) {
      issues.push(gateIssue('stale-approval', entry.id, `${entry.id} approval does not match the accepted entry version.`));
    }
    if (entry.affects.includes('authority')
      && !nonEmptyStrings(approval.deterministicHarnessEvidence)) {
      issues.push(gateIssue('missing-deterministic-evidence', entry.id, `${entry.id} requires deterministic harness evidence.`));
    }
    if (entry.affects.some((affect) => affect === 'camera' || affect === 'hud' || affect === 'perceived-control')
      && !nonEmptyStrings(approval.browserEvidence)) {
      issues.push(gateIssue('missing-browser-evidence', entry.id, `${entry.id} requires browser tuning evidence.`));
    }
  }

  const confirmedChanges = new Map<string, TuningEntry>();
  for (const record of snapshot.history) {
    if (!record.accepted) continue;
    for (const change of record.changes) {
      if (change.before.classification === 'confirmed-starting-target'
        && changedPayload(change.before, change.after)) {
        confirmedChanges.set(change.id, change.after);
      }
    }
  }
  for (const [id, entry] of confirmedChanges) {
    const evidence = entry.evidenceId === null ? undefined : evidenceById.get(entry.evidenceId);
    if (evidence === undefined || evidence.tuningId !== id
      || evidence.registryVersion !== entry.registryVersion
      || evidence.approvalStatus !== 'approved') {
      issues.push(gateIssue('confirmed-change-without-evidence', id, `Changed confirmed target ${id} needs approved reference evidence.`));
    }
    if (entry.approvalRationale === null || entry.approvalRationale.trim().length === 0) {
      issues.push(gateIssue('confirmed-change-without-rationale', id, `Changed confirmed target ${id} needs an approval rationale.`));
    }
  }

  return Object.freeze({
    eligible: issues.length === 0,
    registryVersion: snapshot.version,
    issues: Object.freeze(issues),
  });
}

export function isMechanicsFidelityReleaseEligible(input: ReleaseGateInput): boolean {
  return evaluateReleaseGate(input).eligible;
}
