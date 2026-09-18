import type { NewDomainEvent } from '../events/envelope.js';
import type { JsonObject, JsonValue } from '../json.js';
import type { ApprovalSubject, ApprovalSubjectInput } from './approval.js';
import type { CallbackEvent, ClaimResult, ReleaseResult, SubmitResult } from './client-contract.js';
import type { CallbackRequest } from './gate.js';

type CallbackHistoryPayload =
  | Readonly<{ readonly event: JsonObject }>
  | Readonly<{
      readonly event: JsonObject;
      readonly approvalSubject: ApprovalSubject;
    }>;

export type NewCallbackHistoryEvent = NewDomainEvent<
  'callback:history-recorded',
  1,
  CallbackHistoryPayload
>;

export interface StoredCallbackClient {
  post(request: CallbackRequest, approvalSubject?: ApprovalSubjectInput): Promise<void>;
  listPending(): Promise<readonly CallbackRequest[]>;
  claim(requestId: string, routerId: string): Promise<ClaimResult>;
  submit(
    requestId: string,
    claimToken: string,
    routerId: string,
    requestDigest: string,
    response: JsonValue,
    actor?: JsonObject,
  ): Promise<SubmitResult>;
  release(requestId: string, claimToken: string): Promise<ReleaseResult>;
  supersede(requestId: string, supersededBy: string): Promise<void>;
  history(requestId?: string): Promise<readonly CallbackEvent[]>;
}
