"use client";

import {Idl, type Wallet} from "@coral-xyz/anchor";
import {Connection, PublicKey, Transaction, VersionedTransaction} from "@solana/web3.js";
import {FormEvent, useState} from "react";
import {useRouter} from "next/navigation";

import idl from "../idl/tradetable.json";
import {buildInitializeRoomInstruction} from "@/lib/room-actions";
import {
  assertWalletSnapshot, confirmBaseSignature, createFailureState, createIdleState,
  createSubmittedState, type ConfirmationSource, type CreateIntent, type CreateWorkflowState,
} from "@/lib/create-room-state";
import {pollForInitializedRoom, roomExpiryUnix, type AccountReadSource} from "@/lib/room-loader";
import {
  BASE_RPC_FALLBACK, baseConnection, programFor, programId, sendBase,
} from "@/lib/tradetable";

type InjectedWallet = {
  publicKey: PublicKey | null;
  connect(): Promise<{publicKey: PublicKey}>;
  signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
};
function injectedWallet(): InjectedWallet | undefined {
  return (window as unknown as {solana?: InjectedWallet}).solana;
}

function walletAdapter(wallet: InjectedWallet, snapshot: PublicKey, onSigned: () => void): Wallet {
  assertWalletSnapshot(snapshot.toBase58(), wallet.publicKey?.toBase58() ?? null);
  return {publicKey: snapshot,
    signTransaction: async <T extends Transaction | VersionedTransaction>(value: T) => {
      assertWalletSnapshot(snapshot.toBase58(), wallet.publicKey?.toBase58() ?? null);
      const signed = await wallet.signTransaction(value);
      assertWalletSnapshot(snapshot.toBase58(), wallet.publicKey?.toBase58() ?? null);
      onSigned(); return signed;
    },
    signAllTransactions: <T extends Transaction | VersionedTransaction>(values: T[]) => Promise.all(values.map(value => wallet.signTransaction(value)))} as Wallet;
}

function participant(value: string, label: string): PublicKey {
  try { return new PublicKey(value.trim()); }
  catch { throw new Error(`${label} must be a valid Solana address.`); }
}

function validateRoster(creator: PublicKey, b: string, c: string): [PublicKey, PublicKey, PublicKey] {
  const roster: [PublicKey, PublicKey, PublicKey] = [creator, participant(b, "Participant B"), participant(c, "Participant C")];
  if (new Set(roster.map(value => value.toBase58())).size !== 3) throw new Error("Participants A, B, and C must be distinct wallets.");
  return roster;
}

type CreateField = "participantB" | "participantC" | "expiry";
type CreateFieldErrors = Partial<Record<CreateField, string>>;

function validateCreateFields(b: string, c: string, minutes: number): CreateFieldErrors {
  const errors: CreateFieldErrors = {};
  let participantB: PublicKey | null = null;
  let participantC: PublicKey | null = null;
  try { participantB = new PublicKey(b.trim()); } catch { errors.participantB = "Enter a valid Solana wallet address."; }
  try { participantC = new PublicKey(c.trim()); } catch { errors.participantC = "Enter a valid Solana wallet address."; }
  if (participantB && participantC && participantB.equals(participantC)) {
    errors.participantB = "Participants B and C must use different wallets.";
    errors.participantC = errors.participantB;
  }
  if (!Number.isInteger(minutes) || minutes < 21) errors.expiry = "Use 21 minutes or more.";
  return errors;
}

function mapCreateFieldError(error: unknown): CreateFieldErrors {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Participant B must be a valid Solana address.") return {participantB: "Enter a valid Solana wallet address."};
  if (message === "Participant C must be a valid Solana address.") return {participantC: "Enter a valid Solana wallet address."};
  if (message === "Expiry must be at least 21 minutes.") return {expiry: "Use 21 minutes or more."};
  if (message === "Participants A, B, and C must be distinct wallets.") {
    const remedy = "Must differ from Participant A and the other counterparty.";
    return {participantB: remedy, participantC: remedy};
  }
  return {};
}

function randomNonce(): bigint {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return (BigInt(words[0]) << 32n) | BigInt(words[1]);
}

function baseConnections() {
  return [baseConnection(), ...(BASE_RPC_FALLBACK ? [new Connection(BASE_RPC_FALLBACK, "confirmed")] : [])];
}

function confirmationSources(): ConfirmationSource[] {
  return baseConnections().map(connection => ({label: connection.rpcEndpoint, confirm: async signature => {
    const result = await connection.confirmTransaction(signature, "confirmed");
    return {err: result.value.err};
  }}));
}

function pollingSources(): AccountReadSource[] {
  return baseConnections().map(connection => ({label: connection.rpcEndpoint, read: address => connection.getAccountInfo(address, "confirmed")}));
}

function workflowStatus(state: CreateWorkflowState): string {
  if (state.phase === "awaiting-wallet") return "Awaiting wallet approval";
  if (state.phase === "pre-sign") return "Checking the exact room intent before signing";
  if (state.phase === "unreconciled") return "Outcome not yet reconciled";
  if (state.phase !== "submitted") return "";
  if (state.step === "broadcasting") return "Signed once; broadcasting one Solana base transaction";
  if (state.step === "confirming") return "Signature returned; checking base confirmation";
  return "Checking authoritative RoomCore and RoomLive";
}

type InitializeResult = {intent: CreateIntent; signature: string; core: PublicKey; live: PublicKey};
type IntentCallbacks = {prepared(intent: CreateIntent): void; signed(intent: CreateIntent): void};

async function initializeRoom(wallet: InjectedWallet, participantB: string, participantC: string, minutes: number, callbacks: IntentCallbacks): Promise<InitializeResult> {
  const connected = await wallet.connect();
  const snapshot = connected.publicKey;
  assertWalletSnapshot(snapshot.toBase58(), wallet.publicKey?.toBase58() ?? null);
  const roster = validateRoster(snapshot, participantB, participantC);
  const connection = baseConnection();
  let intent: CreateIntent | null = null;
  const adapter = walletAdapter(wallet, snapshot, () => {
    if (!intent) throw new Error("The canonical room intent is unavailable before signing.");
    callbacks.signed(intent);
  });
  const program = programFor(idl as Idl, adapter, connection);
  if (!program.programId.equals(programId())) throw new Error("Configured program does not match the TradeTable IDL.");
  const built = await buildInitializeRoomInstruction(program, snapshot, randomNonce(), roster, roomExpiryUnix(Date.now(), minutes));
  intent = {core: built.core.toBase58(), live: built.live.toBase58()};
  callbacks.prepared(intent);
  const signature = await sendBase(connection, adapter, built.instruction);
  return {intent: {...intent, signature}, signature, core: built.core, live: built.live};
}

export default function CreateRoomForm() {
  const router = useRouter();
  const [participantB, setParticipantB] = useState("");
  const [participantC, setParticipantC] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [workflow, setWorkflow] = useState<CreateWorkflowState>(() => createIdleState());
  const [fieldErrors, setFieldErrors] = useState<CreateFieldErrors>({});

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!workflow.canSubmit) return;
    const validation = validateCreateFields(participantB, participantC, minutes);
    if (Object.keys(validation).length) { setFieldErrors(validation); return; }
    setFieldErrors({});
    setWorkflow({phase: "awaiting-wallet", canSubmit: false});
    let submittedIntent: CreateIntent | null = null;
    try {
      const wallet = injectedWallet();
      if (!wallet) throw new Error("Install or open an injected Solana wallet to create a room.");
      const result = await initializeRoom(wallet, participantB, participantC, minutes, {
        prepared: intent => setWorkflow({phase: "pre-sign", intent, canSubmit: false}),
        signed: intent => {submittedIntent = intent; setWorkflow(createSubmittedState(intent));},
      });
      submittedIntent = result.intent;
      setWorkflow(createSubmittedState(result.intent, result.signature, "confirming"));
      await confirmBaseSignature(result.signature, confirmationSources());
      setWorkflow(createSubmittedState(result.intent, result.signature, "reconciling"));
      await pollForInitializedRoom(result.core, result.live, programId(), pollingSources());
      router.push(`/rooms/${result.intent.core}`);
    } catch (caught) {
      const mapped = mapCreateFieldError(caught);
      if (Object.keys(mapped).length) setFieldErrors(mapped);
      setWorkflow(createFailureState(submittedIntent, caught));
    }
  }

  async function refreshAuthority() {
    if (workflow.phase !== "unreconciled") return;
    const intent = workflow.intent;
    setWorkflow(createSubmittedState(intent, intent.signature, "reconciling"));
    try {
      await pollForInitializedRoom(new PublicKey(intent.core), new PublicKey(intent.live), programId(), pollingSources());
      router.push(`/rooms/${intent.core}`);
    } catch (caught) { setWorkflow(createFailureState(intent, caught)); }
  }

  const pending = !workflow.canSubmit;
  const status = workflowStatus(workflow);
  const clearField = (field: CreateField) => setFieldErrors(current => ({...current, [field]: undefined}));
  return <form className="controlRail" onSubmit={event => void create(event)}>
    <p>Participant A is the connected creator wallet.</p>
    <label htmlFor="participant-b">Participant B wallet</label>
    <input id="participant-b" aria-invalid={Boolean(fieldErrors.participantB)} aria-describedby={fieldErrors.participantB ? "participant-b-error" : undefined} value={participantB} onChange={event => {setParticipantB(event.target.value); clearField("participantB");}} disabled={pending} required />
    {fieldErrors.participantB ? <p id="participant-b-error" role="alert">{fieldErrors.participantB}</p> : null}
    <label htmlFor="participant-c">Participant C wallet</label>
    <input id="participant-c" aria-invalid={Boolean(fieldErrors.participantC)} aria-describedby={fieldErrors.participantC ? "participant-c-error" : undefined} value={participantC} onChange={event => {setParticipantC(event.target.value); clearField("participantC");}} disabled={pending} required />
    {fieldErrors.participantC ? <p id="participant-c-error" role="alert">{fieldErrors.participantC}</p> : null}
    <label htmlFor="expiry-minutes">Expiry in minutes</label>
    <input id="expiry-minutes" aria-invalid={Boolean(fieldErrors.expiry)} aria-describedby={fieldErrors.expiry ? "expiry-minutes-error" : undefined} type="number" min={21} step={1} value={minutes} onChange={event => {setMinutes(Number(event.target.value)); clearField("expiry");}} disabled={pending} required />
    {fieldErrors.expiry ? <p id="expiry-minutes-error" role="alert">{fieldErrors.expiry}</p> : null}
    <button className="accent" type="submit" disabled={pending}>{pending ? status.toUpperCase() : "CONNECT & CREATE ROOM"}</button>
    {status ? <p role="status" aria-live="polite">{status}. Do not close this page.</p> : null}
    {workflow.phase === "unreconciled" ? <div role="alert"><strong>Outcome not yet reconciled.</strong><p>{workflow.error} This exact signed intent will not be submitted again.</p>{workflow.intent.signature ? <code>Base signature: {workflow.intent.signature}</code> : null}<div className="heroActions"><button type="button" onClick={() => void refreshAuthority()}>REFRESH AUTHORITY</button><a className="secondary" href={`/rooms/${workflow.intent.core}`}>OPEN KNOWN ROOM ROUTE</a></div></div> : null}
    {workflow.phase === "idle" && workflow.confirmedFailed ? <div role="alert"><strong>Transaction confirmed failed.</strong><p>{workflow.error} The atomic transaction made no room state change, so creating a new intent with a new nonce is safe.</p>{workflow.failedIntent?.signature ? <code>Failed base signature: {workflow.failedIntent.signature}</code> : null}</div> : null}
    {workflow.phase === "idle" && workflow.error && !workflow.confirmedFailed ? <p role="alert"><strong>Request not signed.</strong> {workflow.error} You may correct the issue and try again.</p> : null}
  </form>;
}
