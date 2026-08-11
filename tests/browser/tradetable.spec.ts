import {expect, test, type Page} from "@playwright/test";
import {mkdir} from "node:fs/promises";
import path from "node:path";
import {PublicKey} from "@solana/web3.js";

const participantA = Array(32).fill(11);
const participantB = Array(32).fill(12);
const observer = Array(32).fill(99);
const captures = path.resolve("output/playwright/ui-redesign-verification-20260811");

type WalletMode = "participant-a" | "observer" | "disconnected" | "declined";

async function installWallet(page: Page, mode: WalletMode) {
  await page.addInitScript(({mode, participantA, observer}) => {
    const listeners = new Map<string, Set<(value?: unknown) => void>>();
    let signCalls = 0;
    const key = (bytes: number[], label: string) => ({toBytes: () => Uint8Array.from(bytes), toBase58: () => label});
    const initial = mode === "participant-a" ? key(participantA, "fixture-participant-a") : mode === "observer" ? key(observer, "fixture-observer") : null;
    const wallet = {
      publicKey: initial,
      async connect() {
        if (mode === "declined") throw new Error("User rejected request 4001");
        if (!this.publicKey) this.publicKey = key(participantA, "fixture-participant-a");
        return {publicKey: this.publicKey};
      },
      async signTransaction() { signCalls += 1; throw new Error("Fixture wallets never sign or broadcast."); },
      on(event: string, listener: (value?: unknown) => void) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(listener); },
      removeListener(event: string, listener: (value?: unknown) => void) { listeners.get(event)?.delete(listener); },
    };
    Object.assign(window, {solana: wallet, __fixtureWallet: {
      change(bytes: number[] | null, label: string) {
        wallet.publicKey = bytes ? key(bytes, label) : null;
        listeners.get("accountChanged")?.forEach(listener => listener(wallet.publicKey));
      },
      disconnect() { wallet.publicKey = null; listeners.get("disconnect")?.forEach(listener => listener()); },
      signCalls: () => signCalls,
    }});
  }, {mode, participantA, observer});
}

async function openFixture(page: Page, scenario: string, wallet: WalletMode = "participant-a") {
  await installWallet(page, wallet);
  await page.goto(`/test-fixtures/rooms/${scenario}`);
  await expect(page.locator("main")).toHaveAttribute("data-ui-fixture", scenario);
}

test.beforeAll(async () => mkdir(captures, {recursive: true}));

test("landing routes to dedicated workflows without embedding either form", async ({page}) => {
  await page.goto("/");
  await expect(page.getByRole("link", {name: /Create a room/}).first()).toHaveAttribute("href", "/create");
  await expect(page.getByRole("link", {name: /Open a room/}).first()).toHaveAttribute("href", "/open");
  await expect(page.getByRole("textbox", {name: "Participant B wallet"})).toHaveCount(0);
  await expect(page.getByRole("textbox", {name: "RoomCore address"})).toHaveCount(0);
});

test("create-room validation is field-associated and unsigned failure is safely retryable", async ({page}) => {
  await page.goto("/create");
  const b = page.getByRole("textbox", {name: "Participant B wallet"});
  const c = page.getByRole("textbox", {name: "Participant C wallet"});
  const expiry = page.getByRole("spinbutton", {name: "Expiry in minutes"});
  await b.fill("invalid-b"); await c.fill("invalid-c"); await expiry.fill("20");
  await page.getByRole("button", {name: "CONNECT & CREATE ROOM"}).click();
  await expect(page.locator("#participant-b-error")).toBeVisible();
  await expect(page.locator("#participant-c-error")).toBeVisible();
  await expect(page.locator("#expiry-minutes-error")).toContainText("21 minutes or more");
  await b.fill(new PublicKey(Uint8Array.from(participantB)).toBase58());
  await c.fill(new PublicKey(Uint8Array.from({length: 32}, () => 13)).toBase58());
  await expiry.fill("21");
  await page.getByRole("button", {name: "CONNECT & CREATE ROOM"}).click();
  await expect(page.locator(".controlRail [role=alert]")).toContainText("Request not signed");
  await expect(page.getByRole("button", {name: "CONNECT & CREATE ROOM"})).toBeEnabled();
});

test("funding exposes only the participant's missing deposits and participant cancellation", async ({page}, testInfo) => {
  await openFixture(page, "funding");
  await expect(page.getByRole("button", {name: "Deposit slot"})).toHaveCount(2);
  await expect(page.getByRole("button", {name: "Cancel room"})).toBeVisible();
  await expect(page.getByText("Slot 0 immutable classic SPL mint")).toBeVisible();
  await page.screenshot({path: path.join(captures, `funding-${testInfo.project.name}.png`), fullPage: true});
});

test("fully funded room exposes activation without removing Funding-only cancellation", async ({page}) => {
  await openFixture(page, "funded");
  await expect(page.getByRole("button", {name: "Activate negotiation"})).toBeVisible();
  await expect(page.getByRole("button", {name: "Cancel room"})).toBeVisible();
});

test("negotiation separates authority from a conflicting local draft", async ({page}, testInfo) => {
  await openFixture(page, "negotiating");
  await expect(page.getByRole("radiogroup")).toHaveCount(4);
  await expect(page.getByRole("radio")).toHaveCount(8);
  await expect(page.getByRole("button", {name: "Lock revision 4"})).toBeVisible();
  await page.getByRole("radiogroup", {name: "Participant A asset selection"}).getByRole("radio").nth(1).click();
  await expect(page.locator(".draftTray")).toHaveAttribute("data-conflict", "true");
  await expect(page.getByRole("button", {name: "Propose this draft"})).toBeVisible();
  await expect(page.getByRole("button", {name: "Lock revision 4"})).toHaveCount(0);
  await page.screenshot({path: path.join(captures, `conflicting-draft-${testInfo.project.name}.png`), fullPage: true});
});

test("native radio keyboard behavior updates the local draft", async ({page}) => {
  await openFixture(page, "negotiating");
  const choices = page.getByRole("radiogroup", {name: "Participant A asset selection"}).getByRole("radio");
  await choices.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await expect(choices.nth(1)).toBeChecked();
  await expect(page.getByRole("button", {name: "Propose this draft"})).toBeVisible();
});

test("fixture actions are blocked before wallet signing", async ({page}) => {
  await openFixture(page, "negotiating");
  await page.getByRole("button", {name: "Lock revision 4"}).click();
  await expect(page.locator(".errorNotice [role=alert]")).toContainText("transaction could not be completed");
  expect(await page.evaluate(() => (window as any).__fixtureWallet.signCalls())).toBe(0);
});

test("finalizing exposes commit-only finalization and never composed finalize or settleAction", async ({page}, testInfo) => {
  await openFixture(page, "finalizing");
  await expect(page.getByRole("button", {name: "Commit final agreement"})).toBeVisible();
  await expect(page.getByText(/settleAction|Commit \+ action/i)).toHaveCount(0);
  await page.screenshot({path: path.join(captures, `finalizing-${testInfo.project.name}.png`), fullPage: true});
});

test("ER-only Finalized waits while base-owned Finalized permits observer settlement", async ({page}, testInfo) => {
  await openFixture(page, "er-stuck", "observer");
  await expect(page.getByText(/Wait for an undelegated/)).toBeVisible();
  await expect(page.getByRole("button", {name: /Settle/})).toHaveCount(0);
  await page.screenshot({path: path.join(captures, `er-stuck-${testInfo.project.name}.png`), fullPage: true});
  await page.goto("/test-fixtures/rooms/settle-ready");
  await expect(page.getByRole("button", {name: "Settle selected three"})).toBeVisible();
});

test("returning and cancelled rooms expose one permissionless button per eligible asset", async ({page}, testInfo) => {
  await openFixture(page, "returning", "observer");
  await expect(page.getByRole("button", {name: /^Return slot/})).toHaveCount(2);
  await expect(page.getByRole("button", {name: /^Return slot 1/})).toHaveCount(0);
  await page.screenshot({path: path.join(captures, `returning-${testInfo.project.name}.png`), fullPage: true});
  await page.goto("/test-fixtures/rooms/cancelled");
  await expect(page.getByRole("button", {name: /^Return slot/})).toHaveCount(6);
});

test("expired rooms allow observer cancellation and terminal rooms remove draft controls", async ({page}, testInfo) => {
  await openFixture(page, "expired", "observer");
  await expect(page.getByRole("button", {name: "Cancel expired room"})).toBeVisible();
  await page.goto("/test-fixtures/rooms/complete");
  await expect(page.getByRole("region", {name: "Frozen room receipt"})).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await page.screenshot({path: path.join(captures, `complete-${testInfo.project.name}.png`), fullPage: true});
});

test("wallet control handles disconnected, declined, account-change, and disconnect events", async ({page}) => {
  await openFixture(page, "negotiating", "disconnected");
  await expect(page.getByRole("button", {name: "Wallet: Connect wallet"})).toBeVisible();
  await page.evaluate(({participantB}) => (window as any).__fixtureWallet.change(participantB, "fixture-participant-b"), {participantB});
  await expect(page.getByRole("button", {name: "Wallet: Account changed · Participant B"})).toBeVisible();
  await page.evaluate(() => (window as any).__fixtureWallet.disconnect());
  await expect(page.getByRole("button", {name: "Wallet: Disconnected"})).toBeVisible();
  await page.context().clearCookies();
});

test("declined wallet approval becomes an actionable alert", async ({page}) => {
  await openFixture(page, "negotiating", "declined");
  await page.getByRole("button", {name: "Wallet: Connect wallet"}).click();
  await expect(page.getByRole("button", {name: "Wallet: Approval declined"})).toBeVisible();
  await expect(page.locator(".errorNotice [role=alert]")).toContainText("Wallet approval declined");
});

test("timed-out signed writes expose raw ER verification and no retry", async ({page}, testInfo) => {
  await openFixture(page, "pending-timeout");
  await expect(page.getByRole("status").first()).toContainText("Verification timed out");
  await expect(page.getByRole("button", {name: "Verify signed outcome"})).toBeVisible();
  await expect(page.getByRole("button", {name: "Refresh authority only"})).toBeVisible();
  await expect(page.getByText(/Solana Explorer is not authoritative/)).toBeVisible();
  await expect(page.getByRole("button", {name: /Lock revision/})).toBeDisabled();
  await page.screenshot({path: path.join(captures, `pending-timeout-${testInfo.project.name}.png`), fullPage: true});
});

test("wallet geometry is fixed on desktop and contained on mobile", async ({page}, testInfo) => {
  await openFixture(page, "negotiating");
  const box = await page.locator(".walletControl").boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.height)).toBe(46);
  if (testInfo.project.name === "chromium") expect(Math.round(box!.width)).toBe(244);
  else {
    expect(box!.width).toBeLessThanOrEqual(390);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  }
});

test("unknown fixtures fail closed", async ({page}) => {
  const response = await page.goto("/test-fixtures/rooms/not-a-state");
  expect(response).not.toBeNull();
  await expect(page.getByRole("heading", {name: "This page could not be found."})).toBeVisible();
  await expect(page.getByText("Real interface.")).toHaveCount(0);
});
