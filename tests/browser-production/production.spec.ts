import {expect, test, type Page} from "@playwright/test";

const room = "9uxuWPcyhqAh2U6zhVPQnMeHVsqjE1yvseErgboq6DTo";

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  return errors;
}

test("public landing exposes the exact contract and canonical room routes", async ({page}) => {
  const errors = collectConsoleErrors(page);
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.getByText("Six assets enter custody.")).toBeVisible();
  await expect(page.getByText(/selected three settle atomically/)).toBeVisible();
  await expect(page.getByRole("link", {name: /Create a room/}).first()).toHaveAttribute("href", "/create");
  await expect(page.getByRole("link", {name: /Open a room/}).first()).toHaveAttribute("href", "/open");
  await expect(page.getByRole("textbox", {name: "Participant B wallet"})).toHaveCount(0);
  await expect(page.getByRole("textbox", {name: "RoomCore address"})).toHaveCount(0);
  await expect(page.getByRole("link", {name: "Earned demo ↗"})).toHaveAttribute("href", `/rooms/${room}`);
  await expect(page.getByRole("link", {name: "Proof ledger ↗", exact: true})).toHaveAttribute("href", "/proof");
  expect(errors).toEqual([]);
});

test("compatibility proof retains the featured RoomCore", async ({page}) => {
  const response = await page.goto("/proof");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("link", {name: "OPEN ROOM PROOF ↗"})).toHaveAttribute("href", `/rooms/${room}/proof`);
  await expect(page.getByText(/commit-only ER finalization/)).toBeVisible();
});

test("open-room form validates malformed input and routes a canonical RoomCore", async ({page}) => {
  await page.goto("/open");
  const input = page.getByRole("textbox", {name: "RoomCore address"});
  await input.fill("not-a-room");
  await page.getByRole("button", {name: "OPEN VERIFIED ROOM"}).click();
  await expect(page.locator("#room-address-error")).toContainText("valid Solana RoomCore address");
  await input.fill(room);
  await page.getByRole("button", {name: "OPEN VERIFIED ROOM"}).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${room}$`));
  await expect(page.getByRole("region", {name: "Frozen room receipt"})).toBeVisible();
});

test("create-room form rejects malformed roster fields without opening a wallet", async ({page}) => {
  await page.goto("/create");
  await page.getByRole("textbox", {name: "Participant B wallet"}).fill("invalid-b");
  await page.getByRole("textbox", {name: "Participant C wallet"}).fill("invalid-c");
  await page.getByRole("spinbutton", {name: "Expiry in minutes"}).fill("21");
  await page.getByRole("button", {name: "CONNECT & CREATE ROOM"}).click();
  await expect(page.locator("#participant-b-error")).toBeVisible();
  await expect(page.locator("#participant-c-error")).toBeVisible();
  await expect(page.getByRole("button", {name: "CONNECT & CREATE ROOM"})).toBeEnabled();
});

test("featured workspace renders live authoritative terminal state without a wallet", async ({page}) => {
  const errors = collectConsoleErrors(page);
  const response = await page.goto(`/rooms/${room}`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("region", {name: "Frozen room receipt"})).toContainText("Complete · revision 1");
  await expect(page.getByText("0 · 2 · 4")).toBeVisible();
  await expect(page.locator("[data-lock-row][data-locked=true]")).toHaveCount(3);
  await expect(page.getByRole("radio")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("room proof keeps ER collaboration and base consequences separate", async ({page}) => {
  const response = await page.goto(`/rooms/${room}/proof`);
  expect(response?.status()).toBe(200);
  await expect(page.getByText("MAGICBLOCK ER / COLLABORATION")).toBeVisible();
  await expect(page.getByText("SOLANA BASE / CUSTODY + CONSEQUENCES")).toBeVisible();
  await expect(page.getByText("Selected-three settlement")).toBeVisible();
  await expect(page.getByText(/^Separate return/)).toHaveCount(3);
  await expect(page.getByText(/No Solana Explorer claim is made for an ER-only signature/)).toBeVisible();
  const erHref = await page.getByRole("link", {name: "RAW ER ENDPOINT ↗"}).getAttribute("href");
  expect(erHref).toBe("https://devnet-as.magicblock.app/");
});

test("malformed and foreign room addresses fail closed without demo substitution", async ({page}) => {
  const malformed = await page.goto("/rooms/not-a-public-key");
  expect(malformed).not.toBeNull();
  await expect(page.getByText("No TradeTable RoomCore exists at this address.")).toBeVisible();
  await expect(page.getByText(/never replaced with a featured room/)).toBeVisible();
  await expect(page.getByText("Authoritative state.")).toHaveCount(0);
  await page.goto("/rooms/11111111111111111111111111111111");
  await expect(page.locator(".notice[role=alert]")).toContainText("Nothing was replaced with demo state");
});

test("production has no reachable deterministic fixture route", async ({page}) => {
  await page.goto("/test-fixtures/rooms/negotiating");
  await expect(page.getByRole("heading", {name: "404"})).toBeVisible();
  await expect(page.getByRole("heading", {name: "This page could not be found."})).toBeVisible();
  await expect(page.locator("[data-ui-fixture]")).toHaveCount(0);
});

test("production pages do not overflow the viewport", async ({page}) => {
  for (const route of ["/", "/create", "/open", `/rooms/${room}`, `/rooms/${room}/proof`]) {
    await page.goto(route);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow, route).toBe(false);
  }
});
