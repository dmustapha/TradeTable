import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {test} from "node:test";

const rust = readFileSync("programs/tradetable/src/lib.rs", "utf8");
const envExample = readFileSync("../../.env.example", "utf8");
const source = [readFileSync("src/lib/tradetable.ts", "utf8"), readFileSync("scripts/ops.ts", "utf8")].join("\n");

test("tracked files contain no credential-shaped secrets and env files stay ignored", () => {
  const files = execFileSync("git", ["ls-files", "-z"], {cwd: "../.."}).toString().split("\0").filter(Boolean);
  const secret = /0x[a-fA-F0-9]{64}|sk-[\w-]{12,}|pk_[\w-]{12,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}/;
  const hits = files.filter(file => !file.endsWith("package-lock.json")).filter(file => secret.test(readFileSync(`../../${file}`, "utf8")));
  assert.deepEqual(hits, []);
  assert.deepEqual(files.filter(file => /(^|\/)\.env($|\.)/.test(file)), [".env.example"]);
  assert.match(execFileSync("git", ["check-ignore", "-v", "TradeTable/app/.env.local"], {cwd: "../.."}).toString(), /\.env\.\*/);
});

test("every referenced environment variable is documented", () => {
  const referenced = [...source.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map(match => match[1]);
  for (const name of new Set(referenced)) assert.match(envExample, new RegExp(`^${name}=`, "m"), name);
});

test("all thirteen state-changing instructions have an emitted audit event", () => {
  const instructions = [...rust.matchAll(/    pub fn (\w+)\(/g)].map(match => match[1]);
  assert.equal(instructions.length, 13);
  for (const name of ["initialize_room", "deposit_asset", "activate_and_delegate_live", "propose", "lock", "revoke_lock", "finalize", "finalize_commit_only", "return_asset"]) {
    assert.match(rust, new RegExp(`pub fn ${name}\\([\\s\\S]*?emit!\\(`), name);
  }
  assert.match(rust, /pub fn settle_action[\s\S]*?settle_from_accounts/);
  assert.match(rust, /pub fn settle_committed[\s\S]*?settle_from_accounts/);
  assert.match(rust, /fn settle_from_accounts[\s\S]*?emit!\(RoomSettled/);
  assert.match(rust, /pub fn cancel_by_participant[\s\S]*?cancel_core/);
  assert.match(rust, /pub fn cancel_expired[\s\S]*?cancel_core/);
  assert.match(rust, /fn cancel_core[\s\S]*?emit!\(RoomCancelled/);
});

test("unchecked settlement accounts are bound to owners, PDAs, or recorded identities", () => {
  assert.match(rust, /fn read_core[\s\S]*?require_keys_eq!\(\*account\.owner, crate::ID[\s\S]*?InvalidAccountPda/);
  assert.match(rust, /fn read_live[\s\S]*?require_keys_eq!\(\*account\.owner, expected_owner[\s\S]*?InvalidAccountPda/);
  assert.match(rust, /vault_authority[\s\S]*?seeds = \[VAULT_SEED/);
  assert.match(rust, /asset\.mint == accounts\.mints\[leg\]\.key\(\) && asset\.vault == accounts\.vaults\[leg\]\.key\(\)/);
  assert.match(rust, /destination\.owner == recipient && destination\.mint == accounts\.mints\[leg\]\.key\(\)/);
});

test("CPI surface is fixed and does not contain arbitrary low-level invocation", () => {
  assert.doesNotMatch(rust, /invoke_signed|invoke_unchecked|sol_invoke/);
  assert.match(rust, /Program<'info, Token>/);
  assert.match(rust, /token::transfer_checked/);
  assert.match(rust, /MagicIntentBundleBuilder::new/);
  assert.match(rust, /\#\[account\(address = crate::ID\)\] pub program_id/);
});
