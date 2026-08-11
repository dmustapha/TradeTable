import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const cssUrl = new URL("../../src/app/globals.css", import.meta.url);
const layoutUrl = new URL("../../src/app/layout.tsx", import.meta.url);

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)?.map(value => parseInt(value, 16) / 255) ?? [];
  return channels.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
}

function contrast(left: string, right: string): number {
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}

test("declares the approved warm operational design tokens and type roles", async () => {
  const [css, layout] = await Promise.all([
    readFile(cssUrl, "utf8"),
    readFile(layoutUrl, "utf8"),
  ]);

  for (const token of ["--paper:", "--ink:", "--surface:", "--coral:", "--green:", "--shadow-pixel:", "--font-sans:", "--font-mono:"]) {
    assert.match(css, new RegExp(token), `missing ${token}`);
  }
  assert.match(css, /body\s*\{[^}]*font-family:\s*var\(--font-sans\)/s);
  assert.match(css, /:where\(code[^}]*font-family:\s*var\(--font-mono\)/s);
  assert.doesNotMatch(layout, /DM_Serif_Display|serif/i);
  assert.doesNotMatch(css, /(?:linear|radial|conic)-gradient/i);
});

test("keeps interaction geometry stable and accessible", async () => {
  const css = await readFile(cssUrl, "utf8");

  assert.match(css, /\.walletControl\s*\{[^}]*width:\s*244px[^}]*height:\s*46px/s);
  assert.match(css, /\.walletControl\s*\{[^}]*grid-template-columns:/s);
  assert.match(css, /@media\s*\(max-width:\s*600px\)[\s\S]*?\.walletControl\s*\{[^}]*width:\s*100%/s);
  assert.match(css, /:where\(button,\s*a,\s*input[^}]*min-height:\s*44px/s);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:/s);
  assert.match(css, /:where\(input,\s*select,\s*textarea\)\s*\{[^}]*font-size:\s*16px/s);
  assert.match(css, /\.assetChoice\s+input\[type="radio"\]/);
  assert.match(css, /\.cycleControl\s+input\[type="radio"\]/);
  assert.match(css, /\.walletControl\s+:focus-visible\s*\{[^}]*outline-offset:\s*-\d+px/s);
});

test("styles authority, conflict, pending, alert, and terminal states without color alone", async () => {
  const css = await readFile(cssUrl, "utf8");

  for (const selector of [".authorityBar", ".draftTray[data-conflict=\"true\"]", ".pendingPanel", "[role=\"alert\"]", ".receiptTable"]) {
    assert.ok(css.includes(selector), `missing ${selector}`);
  }
  assert.doesNotMatch(css, /\.stale::before/);
  assert.match(css, /\.authorityBar\[data-stale="true"\][^}]*strong::before[^}]*content:/s);
  assert.match(css, /\[role="alert"\]::before[^}]*content:/s);
  assert.match(css, /\.draftTray\[data-conflict="true"\]::before[^}]*content:/s);
});

test("uses a visible divider and keeps the room table near the top", async () => {
  const css = await readFile(cssUrl, "utf8");
  const paper = css.match(/--paper:\s*(#[0-9a-f]{6})/i)?.[1];
  const line = css.match(/--line:\s*(#[0-9a-f]{6})/i)?.[1];
  assert.ok(paper && line);
  assert.ok(contrast(paper, line) >= 3, `line contrast was ${contrast(paper, line)}`);
  assert.match(css, /\.roomHero\s*\{[^}]*padding:/s);
  assert.match(css, /\.roomHero\s+h1\s*\{[^}]*font-size:\s*clamp\(32px/s);
});

test("recomposes at phone width without hiding proof actions and respects reduced motion", async () => {
  const css = await readFile(cssUrl, "utf8");

  assert.match(css, /@media\s*\(max-width:\s*600px\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\*,\s*\*::before,\s*\*::after/s);
  assert.doesNotMatch(css, /\.timeline\s+li\s+a[^}]*display:\s*none/s);
  assert.doesNotMatch(css, /transition\s*:\s*all|\blinear\b|scale\(0\)/i);
  assert.doesNotMatch(css, /scroll-behavior:\s*smooth/i);
});
