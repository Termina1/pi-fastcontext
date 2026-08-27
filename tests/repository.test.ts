import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Repository } from "../src/repository.ts";

test("repository tools search and read relative source files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-fastcontext-repo-"));
  await mkdir(path.join(root, "src", "nested"), { recursive: true });
  await writeFile(path.join(root, "src", "auth.ts"), "export class AuthManager {}\nexport function login() {}\n");
  await writeFile(path.join(root, "src", "nested", "session.ts"), "export const session = true;\n");
  await mkdir(path.join(root, "..config"));
  await writeFile(path.join(root, "..config", "valid.ts"), "const validDotDotName = true;\n");

  const repository = await Repository.open(root);
  assert.equal(await repository.glob({ pattern: "src/**/*.ts" }), "src/auth.ts\nsrc/nested/session.ts");
  assert.match(await repository.grep({ pattern: "AuthManager" }), /src\/auth\.ts:1/);
  assert.match(await repository.read({ path: "src/auth.ts", offset: 1, limit: 1 }), /1:export class AuthManager/);
  assert.match(await repository.read({ path: "..config/valid.ts" }), /validDotDotName/);
  assert.match(await repository.grep({ pattern: "(a+)+$" }), /^No matches/);
});

test("repository rejects absolute paths, traversal, and symlinks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-fastcontext-safe-"));
  const outside = await mkdtemp(path.join(tmpdir(), "pi-fastcontext-outside-"));
  await writeFile(path.join(root, "inside.ts"), "const inside = true;\n");
  await writeFile(path.join(outside, "secret.ts"), "const secret = true;\n");
  await symlink(path.join(outside, "secret.ts"), path.join(root, "escape.ts"));

  const repository = await Repository.open(root);
  assert.match(await repository.read({ path: "/etc/passwd" }), /^ERR: path must be relative/);
  assert.match(await repository.read({ path: "../secret.ts" }), /^ERR: path must not contain/);
  assert.match(await repository.read({ path: "escape.ts" }), /^ERR: symbolic links are not allowed/);
  assert.doesNotMatch(await repository.glob({ pattern: "**/*.ts" }), /escape\.ts/);
});
