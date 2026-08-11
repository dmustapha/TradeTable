import assert from "node:assert/strict";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {PublicKey} from "@solana/web3.js";

import {
  authorityDraft,
  acquireWriteMutex,
  actionTransport,
  assetLifecycleLabel,
  assertDepositMintUnique,
  bindWalletEvents,
  changeDraft,
  failureAfterSigning,
  humanizeWorkspaceError,
  reconcileFreshPending,
  reconcileDraft,
  reduceWallet,
  seatRadioModel,
  snapshotActionAllowed,
  releaseWriteMutex,
  resolveSignedOutcome,
  walletLabel,
  workspacePolicy,
  type WorkspaceDraft,
} from "../../src/lib/workspace-state";
import {SharedTable} from "../../src/app/shared-table";
import {CycleControl} from "../../src/app/consent-panel";
import {buildPendingRequest, FrozenReceipt, PendingPanel} from "../../src/app/room-client";
import {WalletControl} from "../../src/app/wallet-control";
import type {RoomCore, RoomLive, RoomUiState, WalletRole} from "../../src/lib/room-state";
import {startPending} from "../../src/lib/room-actions";
import {acceptSourceSlot, emptyWatermarks, readSignedOutcome, type SignedIntent} from "../../src/lib/tradetable";

const key = (value: number) => Uint8Array.from({length: 32}, () => value);
const participants = [key(1), key(2), key(3)] as RoomCore["participants"];
const proposal = (revision = 4n, selectedSlots: [number, number, number] = [0, 3, 4]): RoomLive => ({
  version: 1, bump: 1, core: key(9), participants, expiresAt: 2_000n, revision,
  selectedSlots, cycle: "forward", destinations: [1, 2, 0], allocationHash: key(Number(revision)),
  lockedRevision: [revision, 0n, 0n], lockedHash: [key(Number(revision)), key(0), key(0)],
  lockMask: 1, phase: "Negotiating", lastActor: key(1), lastAction: "Locked", updatedAt: 1_000n,
  reserved: new Uint8Array(64),
});

test("wallet events rederive participant roles and clear unsigned local intent", () => {
  const connected = reduceWallet({status: "disconnected", address: null}, {type: "connected", address: key(2)}, participants, false);
  assert.deepEqual(connected.role, {kind: "participant", seat: "B", index: 1});
  assert.equal(walletLabel(connected), "Participant B");
  const changed = reduceWallet(connected, {type: "accountChanged", address: key(8)}, participants, false);
  assert.equal(changed.status, "account-changed");
  assert.deepEqual(changed.role, {kind: "observer"});
  assert.equal(changed.clearLocalIntent, true);
  assert.equal(changed.preserveSignedPending, true);
  const disconnected = reduceWallet(changed, {type: "disconnect"}, participants, false);
  assert.deepEqual(disconnected.role, {kind: "disconnected"});
  assert.equal(disconnected.clearLocalIntent, true);
});

test("wallet labels cover unavailable, connecting, declined, observer, and error states", () => {
  assert.equal(walletLabel({status: "unavailable", address: null, role: {kind: "disconnected"}, clearLocalIntent: false, preserveSignedPending: false}), "Install wallet");
  assert.equal(walletLabel({status: "connecting", address: null, role: {kind: "disconnected"}, clearLocalIntent: false, preserveSignedPending: false}), "Connecting…");
  assert.equal(walletLabel({status: "declined", address: null, role: {kind: "disconnected"}, clearLocalIntent: false, preserveSignedPending: false}), "Approval declined");
  assert.equal(walletLabel({status: "connected", address: key(8), role: {kind: "observer"}, clearLocalIntent: false, preserveSignedPending: false}), "Observer");
  assert.equal(walletLabel({status: "error", address: null, role: {kind: "disconnected"}, clearLocalIntent: false, preserveSignedPending: false}), "Wallet error");
  assert.equal(walletLabel({status: "account-changed", address: key(8), role: {kind: "observer"}, clearLocalIntent: true, preserveSignedPending: true}), "Account changed · Observer");
  assert.equal(walletLabel({status: "disconnected", address: null, role: {kind: "disconnected"}, clearLocalIntent: true, preserveSignedPending: true}), "Disconnected");
});

test("write mutex rejects same-tick duplicate submits and remains locked for signed uncertainty", () => {
  const mutex = {locked: false};
  assert.equal(acquireWriteMutex(mutex), true);
  assert.equal(acquireWriteMutex(mutex), false);
  releaseWriteMutex(mutex, "signed-pending");
  assert.equal(mutex.locked, true);
  releaseWriteMutex(mutex, "reconciled");
  assert.equal(acquireWriteMutex(mutex), true);
  releaseWriteMutex(mutex, "unsigned-failure");
  assert.equal(mutex.locked, false);
});

test("signed outcome recovery unlocks only on conclusive failure or expiry with fresh authority", () => {
  const mutex = {locked: true};
  const pending = resolveSignedOutcome({status: null, blockhashValid: true, freshAuthority: true, exactPostcondition: false});
  if (pending.release) releaseWriteMutex(mutex, "verified-non-effect");
  assert.deepEqual(pending, {kind: "still-pending", release: false});
  assert.equal(mutex.locked, true);
  assert.deepEqual(resolveSignedOutcome({status: null, blockhashValid: null, freshAuthority: true, exactPostcondition: false}), {kind: "inconclusive", release: false});
  assert.deepEqual(resolveSignedOutcome({status: {err: {InstructionError: [0, "Custom"]}}, blockhashValid: null, freshAuthority: false, exactPostcondition: false}), {kind: "known-failed", release: true});
  assert.deepEqual(resolveSignedOutcome({status: {err: null}, blockhashValid: null, freshAuthority: true, exactPostcondition: false}), {kind: "landed", release: false});
  assert.deepEqual(resolveSignedOutcome({status: {err: null}, blockhashValid: null, freshAuthority: true, exactPostcondition: true}), {kind: "reconciled", release: true});
  const expired = resolveSignedOutcome({status: null, blockhashValid: false, freshAuthority: true, exactPostcondition: false});
  if (expired.release) releaseWriteMutex(mutex, "verified-non-effect");
  assert.deepEqual(expired, {kind: "verified-non-effect", release: true});
  assert.equal(mutex.locked, false);
  assert.deepEqual(resolveSignedOutcome({status: null, blockhashValid: false, freshAuthority: false, exactPostcondition: false}), {kind: "needs-fresh-authority", release: false});
});

test("signed outcome reader checks status first and blockhash only when absent", async () => {
  const intent: SignedIntent = {signature: "sig", endpoint: "base", recentBlockhash: "hash", rpcUrl: "http://example.invalid"};
  let blockhashReads = 0;
  assert.deepEqual(await readSignedOutcome(intent, {signatureStatus: async () => ({err: null}), blockhashValid: async () => {blockhashReads += 1; return true;}}), {status: {err: null}, blockhashValid: null});
  assert.equal(blockhashReads, 0);
  assert.deepEqual(await readSignedOutcome(intent, {signatureStatus: async () => null, blockhashValid: async () => {blockhashReads += 1; return false;}}), {status: null, blockhashValid: false});
  assert.equal(blockhashReads, 1);
});

test("wallet event binding removes listeners and rejects callbacks from an old generation", () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const removed: string[] = [];
  const emitter = {on: (name: string, fn: (...args: unknown[]) => void) => listeners.set(name, fn), removeListener: (name: string) => removed.push(name)};
  const events: string[] = [];
  let generation = 2;
  const cleanup = bindWalletEvents(emitter, generation, () => generation, event => events.push(event.type));
  listeners.get("accountChanged")?.(key(2));
  listeners.get("accountChanged")?.(null);
  generation = 3;
  listeners.get("disconnect")?.();
  cleanup();
  assert.deepEqual(events, ["accountChanged", "disconnect"]);
  assert.deepEqual(removed.sort(), ["accountChanged", "disconnect"]);
});

test("dirty drafts survive new authority and become explicitly outdated", () => {
  const initial = authorityDraft(proposal());
  const dirty = changeDraft(initial, {selectedSlots: [1, 3, 4], cycle: "reverse"}, proposal());
  const updated = reconcileDraft(dirty, proposal(5n, [1, 2, 5]), false);
  assert.deepEqual(updated.proposal, dirty.proposal);
  assert.equal(updated.baseRevision, 4n);
  assert.equal(updated.dirty, true);
  assert.equal(updated.outdated, true);
  assert.equal(updated.conflict, true);
});

test("pristine and exactly reconciled drafts rebase to authority", () => {
  const next = proposal(5n, [1, 2, 5]);
  assert.deepEqual(reconcileDraft(authorityDraft(proposal()), next, false), authorityDraft(next));
  const dirty = changeDraft(authorityDraft(proposal()), {selectedSlots: [1, 3, 4], cycle: "reverse"}, proposal());
  assert.deepEqual(reconcileDraft(dirty, next, true), authorityDraft(next));
});

test("seat radio model always exposes three groups with two exclusive options", () => {
  const groups = seatRadioModel([1, 2, 5]);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map(group => group.name), ["seat-A-selection", "seat-B-selection", "seat-C-selection"]);
  assert.deepEqual(groups.map(group => group.options.map(option => option.slot)), [[0, 1], [2, 3], [4, 5]]);
  assert.deepEqual(groups.map(group => group.options.filter(option => option.checked).length), [1, 1, 1]);
});

test("cycle is a separate native two-option radiogroup", () => {
  const html = renderToStaticMarkup(createElement(CycleControl, {cycle: "forward", disabled: false, onChange: () => {}}));
  assert.equal((html.match(/role="radiogroup"/g) ?? []).length, 1);
  assert.equal((html.match(/type="radio"/g) ?? []).length, 2);
  assert.match(html, /Forward/);
  assert.match(html, /Reverse/);
});

const ui = (primary: RoomUiState["primary"], alternatives: RoomUiState["alternatives"] = []): RoomUiState => ({
  primary, alternatives, reason: "Legal from authoritative state", recovery: "Refresh authority", evidenceAuthority: "solana-base",
});

test("workspace policy blocks stale and pending writes without making observers blanket read-only", () => {
  const observer: WalletRole = {kind: "observer"};
  assert.equal(workspacePolicy(ui("settleCommitted"), observer, false, null).primary.enabled, true);
  assert.equal(workspacePolicy(ui("returnAsset"), observer, false, null).primary.enabled, true);
  assert.equal(workspacePolicy(ui("cancelExpired"), observer, false, null).primary.enabled, true);
  assert.equal(workspacePolicy(ui("settleCommitted"), observer, true, null).primary.enabled, false);
  assert.equal(workspacePolicy(ui("settleCommitted"), observer, false, "awaiting-authoritative").primary.enabled, false);
  assert.equal(workspacePolicy(ui("settleCommitted"), observer, false, "timed-out").primary.enabled, false);
});

test("a passive primary state does not disable its legal participant cancellation alternative", () => {
  const participant: WalletRole = {kind: "participant", seat: "C", index: 2};
  const policy = workspacePolicy(ui("waitForParticipants", ["cancelByParticipant"]), participant, false, null);
  assert.equal(policy.primary.enabled, false);
  assert.equal(policy.alternatives[0].enabled, true);
});

test("workspace policy suppresses lock for conflicting drafts and freezes terminal receipts", () => {
  const participant: WalletRole = {kind: "participant", seat: "A", index: 0};
  const conflicting = {dirty: true, conflict: true, outdated: false} as WorkspaceDraft;
  assert.equal(workspacePolicy(ui("lock"), participant, false, null, conflicting).primary.visible, false);
  assert.equal(workspacePolicy(ui("viewReceipt"), participant, false, null).frozen, true);
  assert.equal(workspacePolicy(ui("inspectCommit"), participant, false, null).primary.label, "Inspect commit evidence");
});

test("transport mapping keeps custody on base and negotiation on ER", () => {
  assert.equal(actionTransport("settleCommitted"), "solana-base");
  assert.equal(actionTransport("returnAsset"), "solana-base");
  assert.equal(actionTransport("propose"), "magicblock-er");
  assert.equal(actionTransport("finalizeCommitOnly"), "magicblock-er");
});

test("a silently changed observer account cannot reuse a rendered participant action", () => {
  assert.equal(snapshotActionAllowed("propose", ui("propose"), {kind: "observer"}), false);
  assert.equal(snapshotActionAllowed("lock", ui("lock"), {kind: "observer"}), false);
  assert.equal(snapshotActionAllowed("settleCommitted", ui("settleCommitted"), {kind: "observer"}), true);
  assert.equal(snapshotActionAllowed("cancelExpired", ui("cancelExpired"), {kind: "observer"}), true);
});

test("workspace actions bind exact authoritative postconditions before signing", () => {
  const live = proposal();
  const core = {depositedMask: 1} as RoomCore;
  const draft = authorityDraft(live);
  const coreAddress = new PublicKey(key(9));
  const proposed = buildPendingRequest("propose", coreAddress, core, live, 1, draft);
  assert.equal(proposed.expectation.kind, "proposal");
  if (proposed.expectation.kind === "proposal") assert.equal(proposed.expectation.revision, 5n);
  assert.deepEqual(buildPendingRequest("cancelExpired", coreAddress, core, live, -1, draft), {action: "cancelExpired", expectation: {kind: "status", status: "Cancelled"}});
  assert.deepEqual(buildPendingRequest("returnAsset", coreAddress, core, live, -1, draft, 3), {action: "returnAsset", expectation: {kind: "return", slot: 3}});
  const settlement = buildPendingRequest("settleCommitted", coreAddress, core, live, -1, draft);
  assert.equal(settlement.expectation.kind, "settlement");
  if (settlement.expectation.kind === "settlement") assert.equal(settlement.expectation.selectedMask, (1 << 0) | (1 << 3) | (1 << 4));
});

test("deposit preflight rejects a mint already deposited in another slot", () => {
  const mint = key(44);
  const core = {depositedMask: 1, assets: [{mint}, ...Array.from({length: 5}, () => ({mint: key(0)}))]} as RoomCore;
  assert.throws(() => assertDepositMintUnique(core, mint, 1), /already deposited.*slot 0/i);
  assert.doesNotThrow(() => assertDepositMintUnique(core, key(45), 1));
});

test("custody labels respect lifecycle instead of implying premature returns", () => {
  const core = {depositedMask: 1, returnedMask: 0, selectedMask: 1, status: "Funding"} as RoomCore;
  assert.equal(assetLifecycleLabel(core, 0), "Deposited · In custody · Awaiting activation");
  assert.equal(assetLifecycleLabel({...core, status: "Active"}, 0), "Deposited · Selected proposal slot · Not settled");
  assert.equal(assetLifecycleLabel({...core, status: "Settled"}, 0), "Deposited · Selected · Settled");
  assert.equal(assetLifecycleLabel({...core, status: "Returning", selectedMask: 0}, 0), "Deposited · Unselected · Eligible to return");
  assert.equal(assetLifecycleLabel({...core, status: "Cancelled"}, 0), "Deposited · Cancelled · Eligible to return");
});

test("human errors expose a remedy separately from raw diagnostic detail", () => {
  const declined = humanizeWorkspaceError(new Error("User rejected request 4001"));
  assert.match(declined.summary, /approval declined/i);
  assert.match(declined.remedy, /approve/i);
  assert.match(declined.raw, /4001/);
  const stale = humanizeWorkspaceError(new Error("authority projection stale"));
  assert.match(stale.remedy, /refresh/i);
});

test("authority watermarks are monotonic within base and ER domains", () => {
  const marks = emptyWatermarks();
  assert.equal(acceptSourceSlot(marks, "base-ws", 100), true);
  assert.equal(acceptSourceSlot(marks, "base-poll", 99), false);
  assert.equal(acceptSourceSlot(marks, "base-fallback-poll", 101), true);
  assert.equal(acceptSourceSlot(marks, "router-poll", 9), true);
  assert.equal(acceptSourceSlot(marks, "er-ws", 8), false);
  assert.equal(acceptSourceSlot(marks, "er-poll", 10), true);
});

test("stale authority cannot reconcile a pending write but a fresh exact snapshot can", () => {
  const pending = startPending({action: "cancelExpired", expectation: {kind: "status", status: "Cancelled"}}, 0, 10_000);
  const core = {status: "Cancelled"} as RoomCore;
  assert.equal(reconcileFreshPending(pending, core, proposal(), 0, 6_000).phase, "awaiting-wallet");
  assert.equal(reconcileFreshPending(pending, core, proposal(), 0, 10_001).phase, "timed-out");
  assert.equal(reconcileFreshPending(pending, core, proposal(), 5_999, 6_000).phase, "reconciled");
});

test("a signed base failure without a surfaced signature is refresh-only and never retryable", () => {
  const pending = startPending({action: "settleCommitted", expectation: {kind: "settlement", selectedMask: 21, revision: 4n, allocationHash: key(4)}}, 0, 10_000);
  const failed = failureAfterSigning(pending, new Error("broadcast unavailable"), null, 2_000);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.refreshAuthority, true);
  assert.equal(failed.canBlindRetry, false);
  assert.equal(failed.signature, undefined);
  assert.equal(failed.evidenceUrl, undefined);
});

test("shared table renders six custody assets, three native radiogroups, and three lock rows", () => {
  const core = {assets: Array.from({length: 6}, (_, slot) => ({mint: key(20 + slot), flags: 1})), depositedMask: 62, returnedMask: 2, selectedMask: 21} as RoomCore;
  const html = renderToStaticMarkup(createElement(SharedTable, {core, live: proposal(), draft: authorityDraft(proposal()), editable: true, onSelect: () => {}}));
  assert.equal((html.match(/role="radiogroup"/g) ?? []).length, 3);
  assert.equal((html.match(/type="radio"/g) ?? []).length, 6);
  assert.equal((html.match(/data-lock-row=/g) ?? []).length, 3);
  assert.equal((html.match(/aria-disabled="false"/g) ?? []).length, 6);
  assert.equal((html.match(/data-locked="true"/g) ?? []).length, 1);
  assert.equal((html.match(/data-locked="false"/g) ?? []).length, 2);
  assert.match(html, /Deposited/);
  assert.match(html, /Returned/);
  assert.match(html, /Selected/);
  assert.doesNotMatch(html, /11111111111111111111111111111111/);
});

test("disabled asset cards expose their state to assistive and pointer users", () => {
  const core = {assets: Array.from({length: 6}, (_, slot) => ({mint: key(20 + slot), flags: 1})), depositedMask: 63, returnedMask: 0, selectedMask: 0} as RoomCore;
  const html = renderToStaticMarkup(createElement(SharedTable, {core, live: proposal(), draft: authorityDraft(proposal()), editable: false, onSelect: () => {}}));
  assert.equal((html.match(/aria-disabled="true"/g) ?? []).length, 6);
  assert.equal((html.match(/ disabled=""/g) ?? []).length, 6);
});

test("wallet control exposes network readiness separately from role and uses a stable control label", () => {
  const html = renderToStaticMarkup(createElement(WalletControl, {state: {status: "connected", address: key(2), role: {kind: "participant", seat: "B", index: 1}, clearLocalIntent: false, preserveSignedPending: false}, networkReady: false, onConnect: () => {}}));
  assert.match(html, /Participant B/);
  assert.match(html, /RPC unavailable/);
  assert.match(html, /aria-label="Wallet: Participant B"/);
});

test("terminal receipt removes draft radios but preserves six custody flags and three exact locks", () => {
  const core = {assets: Array.from({length: 6}, (_, slot) => ({mint: key(20 + slot)})), depositedMask: 63, returnedMask: 2, selectedMask: 21, status: "Complete"} as RoomCore;
  const html = renderToStaticMarkup(createElement(FrozenReceipt, {core, live: proposal()}));
  assert.equal((html.match(/type="radio"/g) ?? []).length, 0);
  assert.equal((html.match(/data-custody-slot=/g) ?? []).length, 6);
  assert.equal((html.match(/data-lock-row=/g) ?? []).length, 3);
  assert.match(html, /Allocation hash/);
  assert.match(html, /Last action/);
});

test("pending ambiguity exposes a verify-signed-outcome recovery control", () => {
  const pending = {...startPending({action: "cancelExpired", expectation: {kind: "status", status: "Cancelled"}}, 0, 10_000), phase: "timed-out", signature: "sig", refreshAuthority: true} as const;
  const recovery: SignedIntent = {signature: "sig", endpoint: "base", recentBlockhash: "hash", rpcUrl: "https://api.devnet.solana.com"};
  const html = renderToStaticMarkup(createElement(PendingPanel, {pending, recovery, verification: "Outcome remains locked.", onRefresh: () => {}, onVerify: () => {}}));
  assert.match(html, /Verify signed outcome/);
  assert.match(html, /Outcome remains locked/);
  assert.doesNotMatch(html, />Retry</);
});

test("pending ER evidence uses human labels and an actionable raw RPC path", () => {
  const pending = {...startPending({action: "revokeLock", expectation: {kind: "revoke", actorIndex: 0, revision: 4n, allocationHash: key(4)}}, 0, 10_000),
    phase: "awaiting-authoritative", signature: "er-sig", evidence: {kind: "raw-er-signature", endpoint: "https://devnet-as.magicblock.app/"}} as const;
  const html = renderToStaticMarkup(createElement(PendingPanel, {pending, recovery: null, verification: null, onRefresh: () => {}, onVerify: () => {}}));
  assert.match(html, /Revoke exact-revision lock/);
  assert.match(html, /Awaiting authoritative state/);
  assert.match(html, /href="https:\/\/devnet-as\.magicblock\.app\/"/);
  assert.match(html, /getSignatureStatuses/);
  assert.doesNotMatch(html, /Open Solana base evidence/);
});
