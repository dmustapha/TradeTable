import {withTimeout} from "./tradetable";

export type CreateIntent = {core: string; live: string; signature?: string};
export type CreateWorkflowState =
  | {phase: "idle"; error?: string; confirmedFailed?: boolean; failedIntent?: CreateIntent; canSubmit: true}
  | {phase: "awaiting-wallet"; canSubmit: false}
  | {phase: "pre-sign"; intent: CreateIntent; canSubmit: false}
  | {phase: "submitted"; intent: CreateIntent; step: "broadcasting" | "confirming" | "reconciling"; canSubmit: false}
  | {phase: "unreconciled"; intent: CreateIntent; error: string; canSubmit: false};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createIdleState(error?: unknown): CreateWorkflowState {
  return error === undefined ? {phase: "idle", canSubmit: true} : {phase: "idle", error: message(error), canSubmit: true};
}

export function createSubmittedState(intent: CreateIntent, signature?: string, step: "broadcasting" | "confirming" | "reconciling" = "broadcasting"): Extract<CreateWorkflowState, {phase: "submitted"}> {
  return {phase: "submitted", intent: signature ? {...intent, signature} : intent, step, canSubmit: false};
}

export function createFailureState(intent: CreateIntent | null, error: unknown): CreateWorkflowState {
  if (!intent) return createIdleState(error);
  if (error instanceof OnChainTransactionError) {
    return {phase: "idle", error: message(error), confirmedFailed: true, failedIntent: intent, canSubmit: true};
  }
  return {phase: "unreconciled", intent, error: message(error), canSubmit: false};
}

export function assertWalletSnapshot(expected: string, current: string | null): void {
  if (current !== expected) throw new Error("The connected wallet account changed before signing.");
}

export type ConfirmationSource = {label: string; confirm(signature: string): Promise<{err: unknown}>};
export class OnChainTransactionError extends Error {}
export class ConfirmationUnavailableError extends Error {}

export async function confirmBaseSignature(signature: string, sources: ConfirmationSource[], timeoutMs = 20_000): Promise<void> {
  for (const source of sources) {
    try {
      const result = await withTimeout(source.confirm(signature), timeoutMs, `${source.label} confirmation`);
      if (result.err) throw new OnChainTransactionError(`The base transaction failed on-chain: ${JSON.stringify(result.err)}`);
      return;
    } catch (error) { if (error instanceof OnChainTransactionError) throw error; }
  }
  throw new ConfirmationUnavailableError("The base signature exists, but confirmation is currently unavailable.");
}
