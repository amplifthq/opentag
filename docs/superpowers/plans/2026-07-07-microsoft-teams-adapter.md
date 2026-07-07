# Microsoft Teams Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `packages/teams` adapter so a user can `@OpenTag` in a Microsoft Teams team channel and get a local coding-agent run replied back into the same thread, reusing the existing dispatcher/runner/binding loop.

**Architecture:** A self-contained `@opentag/teams` package (mirroring `@opentag/discord`) mounted directly into the `local-runtime` dispatcher — no `apps/teams-events` service. Inbound is a Bot Framework webhook receiving message activities that @mention the bot; outbound replies go through the Bot Connector REST API with an OAuth2 client-credentials token. All non-adapter concerns (run creation, action apply, binding) reuse the shared dispatcher contracts.

**Tech Stack:** TypeScript (ESM, Node ≥20), Hono (webhook app), `jose` (inbound Bot Framework JWT validation via JWKS), Node `fetch` (outbound), Vitest (tests), tsup + tsc (build). Reference package: `packages/discord`.

## Global Constraints

- Node engine: `>=20`. ESM only (`"type": "module"`).
- Package name `@opentag/teams`, version `0.4.0`, `license: MIT`, `publishConfig.access: public` — match `packages/discord/package.json` exactly except name/description/keywords.
- Do NOT add provider SDKs to `@opentag/core`. Teams-specific deps live in `packages/teams` only.
- `@opentag/core` provider strings are open; do NOT whitelist. The only core change allowed is extending `OpenTagPlatformId` + capability record.
- Reuse shared parsers: `commandFromRawText`, `parseThreadActionCommand`, `readRequestTextWithLimit` from `@opentag/core`. Do not reinvent command/action parsing.
- `threadKey` segments are `|`-delimited and MUST NOT contain `|`.
- Provider API non-2xx responses MUST become failures, never silent successes.
- v1 scope: team **channels only** (`conversationType === "channel"`), **plain-text/Markdown** replies (no Adaptive Cards), **@mention** trigger (no slash command).
- Repo gates before any PR: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`.
- Spec reference: `docs/superpowers/specs/2026-07-07-microsoft-teams-adapter-design.md`.

---

### Task 1: Scaffold `@opentag/teams` package + register `teams` in core capabilities

**Files:**
- Create: `packages/teams/package.json`
- Create: `packages/teams/tsconfig.json`
- Create: `packages/teams/tsup.config.ts`
- Create: `packages/teams/src/index.ts`
- Create: `packages/teams/README.md`
- Modify: `packages/core/src/capability.ts:1` (extend `OpenTagPlatformId`) and `packages/core/src/capability.ts:16-77` (add `teams` record entry)
- Test: `packages/core/test/capability.test.ts` (create if absent; otherwise add a case)

**Interfaces:**
- Produces: package `@opentag/teams` with an empty `src/index.ts` that re-exports submodules (added in later tasks). Produces core `OpenTagPlatformId` including `"teams"` and `OPEN_TAG_PLATFORM_CAPABILITIES.teams`.

- [ ] **Step 1: Write the failing test** for the core capability entry

Create/append `packages/core/test/capability.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { OPEN_TAG_PLATFORM_CAPABILITIES, isOpenTagPlatformId, shouldDeliverCallbackProgress } from "../src/capability.js";

describe("teams platform capability", () => {
  it("registers teams as a known platform", () => {
    expect(isOpenTagPlatformId("teams")).toBe(true);
  });
  it("uses the status_update liveness strategy so progress edits are delivered", () => {
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.teams.livenessStrategy).toBe("status_update");
    expect(shouldDeliverCallbackProgress("teams")).toBe(true);
  });
  it("requires explicit addressing (the bot must be @mentioned)", () => {
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.teams.requiresExplicitAddressing).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm --dir packages/core exec vitest run test/capability.test.ts`
Expected: FAIL — `teams` not assignable / property `teams` missing.

- [ ] **Step 3: Extend the core capability module**

In `packages/core/src/capability.ts`, line 1, add `"teams"`:

```ts
export type OpenTagPlatformId = "github" | "gitlab" | "slack" | "lark" | "telegram" | "discord" | "teams";
```

Add this entry to the `OPEN_TAG_PLATFORM_CAPABILITIES` record (after the `discord` entry, before the closing `}`):

```ts
  ,teams: {
    id: "teams",
    receivesEvents: true,
    repliesToSourceThread: true,
    supportsStatusUpdates: true,
    supportsRichPresentation: false,
    supportsActionReplies: true,
    requiresExplicitAddressing: true,
    livenessStrategy: "status_update"
  }
```

(`supportsRichPresentation: false` because v1 replies are plain text, not Adaptive Cards.)

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm --dir packages/core exec vitest run test/capability.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the package scaffold**

`packages/teams/package.json`:

```json
{
  "name": "@opentag/teams",
  "version": "0.4.0",
  "description": "Microsoft Teams activity normalization and callback rendering for OpenTag.",
  "type": "module",
  "engines": { "node": ">=20" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "development": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist", "README.md"],
  "publishConfig": { "access": "public" },
  "keywords": ["opentag", "teams", "microsoft-teams", "agents", "webhooks"],
  "license": "MIT",
  "scripts": {
    "build": "tsup && tsc -b tsconfig.json --emitDeclarationOnly --force",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@opentag/core": "workspace:*",
    "hono": "^4.6.15",
    "jose": "^5.9.6"
  },
  "devDependencies": {
    "tsup": "^8.5.1",
    "typescript": "^5.9.3"
  }
}
```

`packages/teams/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../core" }]
}
```

`packages/teams/tsup.config.ts`:

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  sourcemap: true,
  clean: true
});
```

`packages/teams/src/index.ts` (submodule re-exports are added by later tasks; start with a placeholder that keeps the build valid):

```ts
export {};
```

`packages/teams/README.md`:

```markdown
# @opentag/teams

Microsoft Teams activity normalization and callback rendering for OpenTag.

Receives Bot Framework message activities that @mention the bot in a team
channel, normalizes them into an `OpenTagEvent`, and posts replies back to the
source channel thread via the Bot Connector REST API. Mounted into the
`local-runtime` dispatcher (no standalone events app).

Scope (v1): team channels only, plain-text/Markdown replies, @mention trigger.
```

- [ ] **Step 6: Install and verify the workspace picks up the package**

Run: `corepack pnpm install`
Then: `corepack pnpm --dir packages/teams exec tsc --noEmit`
Expected: install succeeds; typecheck passes (empty module).

- [ ] **Step 7: Add teams to the root tsconfig project references if required**

Check `tsconfig.json` at repo root for a `references` array listing packages. If `packages/discord` is listed there, add `{ "path": "packages/teams" }` in the same style. If references are globbed/auto, skip.

Run: `corepack pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/teams packages/core/src/capability.ts packages/core/test/capability.test.ts tsconfig.json
git commit -m "feat(teams): scaffold @opentag/teams package and register teams capability"
```

---

### Task 2: Thread key codec (`thread-key.ts`)

**Files:**
- Create: `packages/teams/src/thread-key.ts`
- Modify: `packages/teams/src/index.ts`
- Test: `packages/teams/test/thread-key.test.ts`

**Interfaces:**
- Produces:
  - `encodeTeamsThreadKey(input: { serviceUrl: string; conversationId: string; activityId: string }): string`
  - `parseTeamsThreadKey(threadKey: string): { serviceUrl: string; conversationId: string; activityId: string }`

- [ ] **Step 1: Write the failing test**

`packages/teams/test/thread-key.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { encodeTeamsThreadKey, parseTeamsThreadKey } from "../src/thread-key.js";

describe("teams thread key", () => {
  const input = {
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    conversationId: "19:abc@thread.tacv2;messageid=1699",
    activityId: "1699000000001"
  };

  it("round-trips serviceUrl, conversationId, and activityId", () => {
    const key = encodeTeamsThreadKey(input);
    expect(parseTeamsThreadKey(key)).toEqual(input);
  });

  it("encodes as pipe-delimited segments", () => {
    expect(encodeTeamsThreadKey(input)).toBe(
      "https://smba.trafficmanager.net/amer/|19:abc@thread.tacv2;messageid=1699|1699000000001"
    );
  });

  it("throws on a key missing a segment", () => {
    expect(() => parseTeamsThreadKey("https://x|19:abc")).toThrow(/Invalid Teams thread key/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm --dir packages/teams exec vitest run test/thread-key.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `thread-key.ts`**

```ts
/** threadKey = `serviceUrl|conversationId|activityId`. Segments must not contain `|`.
 * Teams service URLs and conversation ids (e.g. `19:...@thread.tacv2;messageid=<root>`)
 * contain no `|`, so the split is unambiguous. */
export function encodeTeamsThreadKey(input: {
  serviceUrl: string;
  conversationId: string;
  activityId: string;
}): string {
  return [input.serviceUrl, input.conversationId, input.activityId].join("|");
}

export function parseTeamsThreadKey(threadKey: string): {
  serviceUrl: string;
  conversationId: string;
  activityId: string;
} {
  const [serviceUrl, conversationId, activityId] = threadKey.split("|");
  if (!serviceUrl || !conversationId || !activityId) {
    throw new Error(`Invalid Teams thread key: ${threadKey}`);
  }
  return { serviceUrl, conversationId, activityId };
}
```

- [ ] **Step 4: Re-export from index and run tests**

Add to `packages/teams/src/index.ts` (replace the `export {};` placeholder once the first real module exists):

```ts
export * from "./thread-key.js";
```

Run: `corepack pnpm --dir packages/teams exec vitest run test/thread-key.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/teams/src/thread-key.ts packages/teams/src/index.ts packages/teams/test/thread-key.test.ts
git commit -m "feat(teams): add thread key codec"
```

---

### Task 3: Normalize a Teams message activity (`normalize.ts`)

**Files:**
- Create: `packages/teams/src/normalize.ts`
- Modify: `packages/teams/src/index.ts`
- Test: `packages/teams/test/normalize.test.ts`

**Interfaces:**
- Consumes: `encodeTeamsThreadKey` (Task 2); `commandFromRawText`, `OpenTagEvent`, `OpenTagCommand`, `ContextPointer`, `PermissionGrant` from `@opentag/core`.
- Produces:
  - `type TeamsChannelBinding = { tenantId: string; teamId?: string; channelId?: string; conversationId: string; repoProvider?: string; owner: string; repo: string }`
  - `type TeamsActivityInput` (raw fields extracted from a Bot Framework activity — see Step 3)
  - `normalizeTeamsActivity(input: TeamsActivityInput): OpenTagEvent | null`
  - `extractTeamsMessage(activity: Record<string, unknown>): TeamsExtractedMessage | null` — pulls typed fields out of a raw activity payload, `null` when required fields are missing or it is not an addressed channel message.
  - `type TeamsExtractedMessage = { activityId: string; serviceUrl: string; conversationId: string; tenantId: string; teamId?: string; channelId?: string; userId: string; userName?: string; text: string; botId: string }`

- [ ] **Step 1: Write the failing tests**

`packages/teams/test/normalize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractTeamsMessage, normalizeTeamsActivity, type TeamsChannelBinding } from "../src/normalize.js";

const binding: TeamsChannelBinding = {
  tenantId: "t1",
  teamId: "19:team",
  channelId: "19:chan",
  conversationId: "19:conv@thread.tacv2",
  owner: "acme",
  repo: "demo"
};

function channelActivity(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    id: "act-1",
    text: "<at>OpenTag</at> investigate this",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    from: { id: "29:user", name: "Alice", aadObjectId: "aad-1" },
    recipient: { id: "28:bot", name: "OpenTag" },
    conversation: { id: "19:conv@thread.tacv2", conversationType: "channel", tenantId: "t1" },
    channelData: { tenant: { id: "t1" }, team: { id: "19:team" }, channel: { id: "19:chan" } },
    entities: [{ type: "mention", mentioned: { id: "28:bot" }, text: "<at>OpenTag</at>" }],
    ...overrides
  } as Record<string, unknown>;
}

describe("extractTeamsMessage", () => {
  it("returns null for a non-message activity", () => {
    expect(extractTeamsMessage(channelActivity({ type: "conversationUpdate" }))).toBeNull();
  });

  it("returns null for a non-channel conversation", () => {
    expect(
      extractTeamsMessage(channelActivity({ conversation: { id: "19:conv", conversationType: "personal", tenantId: "t1" } }))
    ).toBeNull();
  });

  it("returns null when text is absent", () => {
    const activity = channelActivity();
    delete (activity as Record<string, unknown>).text;
    expect(extractTeamsMessage(activity)).toBeNull();
  });

  it("returns null when the bot is not mentioned", () => {
    expect(extractTeamsMessage(channelActivity({ entities: [] }))).toBeNull();
  });

  it("returns null when the sender is the bot itself", () => {
    expect(
      extractTeamsMessage(channelActivity({ from: { id: "28:bot", name: "OpenTag" } }))
    ).toBeNull();
  });

  it("strips the mention text and extracts required fields", () => {
    const extracted = extractTeamsMessage(channelActivity());
    expect(extracted).toMatchObject({
      activityId: "act-1",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      conversationId: "19:conv@thread.tacv2",
      tenantId: "t1",
      teamId: "19:team",
      channelId: "19:chan",
      userId: "aad-1",
      text: "investigate this",
      botId: "28:bot"
    });
  });

  it("keeps parsing when the General channel omits channel.id", () => {
    const extracted = extractTeamsMessage(
      channelActivity({ channelData: { tenant: { id: "t1" }, team: { id: "19:team" } } })
    );
    expect(extracted?.channelId).toBeUndefined();
    expect(extracted?.conversationId).toBe("19:conv@thread.tacv2");
  });
});

describe("normalizeTeamsActivity", () => {
  const base = {
    activityId: "act-1",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    conversationId: "19:conv@thread.tacv2",
    tenantId: "t1",
    teamId: "19:team",
    channelId: "19:chan",
    userId: "aad-1",
    userName: "Alice",
    text: "investigate this",
    binding,
    receivedAt: "2026-07-07T00:00:00.000Z"
  };

  it("returns null for an empty command body", () => {
    expect(normalizeTeamsActivity({ ...base, text: "   " })).toBeNull();
  });

  it("produces a stable, well-formed event for a review-intent mention", () => {
    const event = normalizeTeamsActivity(base)!;
    expect(event.id).toBe("evt_teams_act-1");
    expect(event.source).toBe("teams");
    expect(event.sourceEventId).toBe("act-1");
    expect(event.actor).toMatchObject({ provider: "teams", providerUserId: "aad-1", handle: "Alice", organizationId: "19:team" });
    expect(event.callback).toEqual({
      provider: "teams",
      uri: "https://smba.trafficmanager.net/amer/",
      threadKey: "https://smba.trafficmanager.net/amer/|19:conv@thread.tacv2|act-1"
    });
    expect(event.metadata).toMatchObject({
      tenantId: "t1", teamId: "19:team", channelId: "19:chan",
      conversationId: "19:conv@thread.tacv2",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      repoProvider: "github", owner: "acme", repo: "demo"
    });
    // review intent → no write permissions
    expect(event.permissions.some((p) => p.scope === "repo:write")).toBe(false);
  });

  it("adds write permissions for a fix intent", () => {
    const event = normalizeTeamsActivity({ ...base, text: "fix the flaky test" })!;
    const scopes = event.permissions.map((p) => p.scope);
    expect(scopes).toEqual(expect.arrayContaining(["repo:read", "repo:write", "pr:create"]));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `corepack pnpm --dir packages/teams exec vitest run test/normalize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `normalize.ts`**

```ts
import {
  commandFromRawText,
  type ContextPointer,
  type OpenTagCommand,
  type OpenTagEvent,
  type PermissionGrant
} from "@opentag/core";
import { encodeTeamsThreadKey } from "./thread-key.js";

/** Channel → repository binding, keyed on the dispatcher by
 * `("teams", tenantId, conversationId)`. `channelId` may be absent for the
 * team's General channel, so `conversationId` is the reliable key. */
export type TeamsChannelBinding = {
  tenantId: string;
  teamId?: string;
  channelId?: string;
  conversationId: string;
  repoProvider?: string;
  owner: string;
  repo: string;
};

export type TeamsExtractedMessage = {
  activityId: string;
  serviceUrl: string;
  conversationId: string;
  tenantId: string;
  teamId?: string;
  channelId?: string;
  userId: string;
  userName?: string;
  /** Text with the bot mention removed and trimmed. May be empty. */
  text: string;
  /** The bot's channel id (recipient.id) — used later to route replies/actions. */
  botId: string;
};

export type TeamsActivityInput = {
  activityId: string;
  serviceUrl: string;
  conversationId: string;
  tenantId: string;
  teamId?: string;
  channelId?: string;
  userId: string;
  userName?: string;
  /** Mention already stripped; caller guards emptiness (normalize also guards). */
  text: string;
  binding: TeamsChannelBinding;
  receivedAt?: string;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stripMention(text: string, mentionText: string): string {
  if (!mentionText) return text.trim();
  // Remove every occurrence of the exact mention markup, then collapse whitespace.
  return text.split(mentionText).join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Extract typed fields from a raw Bot Framework activity, returning `null` when
 * the activity is not an addressed team-channel message we should act on:
 * - not a `message`;
 * - not a `channel` conversation (personal/groupChat are out of scope for v1);
 * - `text` missing;
 * - no `mention` entity targeting the bot (`recipient.id`);
 * - authored by the bot itself.
 * The returned `text` has the bot mention removed (may be empty — the caller
 * decides whether an empty command means "ignore").
 */
export function extractTeamsMessage(activity: Record<string, unknown>): TeamsExtractedMessage | null {
  if (activity.type !== "message") return null;

  const conversation = activity.conversation as { id?: unknown; conversationType?: unknown; tenantId?: unknown } | undefined;
  if (conversation?.conversationType !== "channel") return null;
  const conversationId = asString(conversation?.id);

  const recipient = activity.recipient as { id?: unknown } | undefined;
  const botId = asString(recipient?.id);

  const from = activity.from as { id?: unknown; name?: unknown; aadObjectId?: unknown } | undefined;
  const fromId = asString(from?.id);

  const rawText = asString(activity.text);
  const activityId = asString(activity.id);
  const serviceUrl = asString(activity.serviceUrl);

  const channelData = activity.channelData as
    | { tenant?: { id?: unknown }; team?: { id?: unknown }; channel?: { id?: unknown } }
    | undefined;
  const tenantId = asString(channelData?.tenant?.id) ?? asString(conversation?.tenantId);
  const teamId = asString(channelData?.team?.id);
  const channelId = asString(channelData?.channel?.id);

  if (!botId || !fromId || !rawText || !activityId || !serviceUrl || !conversationId || !tenantId) {
    return null;
  }
  if (fromId === botId) return null; // defence-in-depth: never act on our own messages.

  const entities = Array.isArray(activity.entities) ? (activity.entities as Array<Record<string, unknown>>) : [];
  const botMention = entities.find(
    (e) => e.type === "mention" && (e.mentioned as { id?: unknown } | undefined)?.id === botId
  );
  if (!botMention) return null; // bot was not addressed.

  const text = stripMention(rawText, asString(botMention.text) ?? "");
  const userId = asString(from?.aadObjectId) ?? fromId;
  const userName = asString(from?.name);

  return {
    activityId,
    serviceUrl,
    conversationId,
    tenantId,
    ...(teamId ? { teamId } : {}),
    ...(channelId ? { channelId } : {}),
    userId,
    ...(userName ? { userName } : {}),
    text,
    botId
  };
}

function permissionsForIntent(intent: OpenTagCommand["intent"]): PermissionGrant[] {
  const permissions: PermissionGrant[] = [
    { scope: "chat:postMessage", reason: "reply in the originating Teams channel thread" },
    { scope: "runner:local", reason: "execute the run on a paired local daemon" }
  ];
  if (intent === "fix" || intent === "run") {
    permissions.push(
      { scope: "repo:read", reason: "inspect the repository in the paired local checkout" },
      { scope: "repo:write", reason: "commit code changes on an isolated run branch" },
      { scope: "pr:create", reason: "open a pull request for completed code changes" }
    );
  }
  return permissions;
}

function referenceTitle(reference: NonNullable<OpenTagCommand["parsed"]>["references"][number]): string {
  return reference.title ?? "Command file reference";
}

function contextPointersForCommand(command: OpenTagCommand): ContextPointer[] {
  const context: ContextPointer[] = [];
  for (const reference of command.parsed?.references ?? []) {
    if (reference.kind === "url") {
      context.push({ kind: "url", uri: reference.uri, visibility: "organization", title: reference.title ?? "Command URL reference" });
      continue;
    }
    if (reference.kind === "file" || reference.kind === "path") {
      context.push({
        kind: "file",
        uri: reference.uri,
        ...(reference.line ? { line: reference.line } : {}),
        ...(reference.startLine ? { startLine: reference.startLine } : {}),
        ...(reference.endLine ? { endLine: reference.endLine } : {}),
        visibility: "organization",
        title: referenceTitle(reference)
      });
    }
  }
  return context;
}

function commandMetadata(command: OpenTagCommand): Record<string, unknown> {
  if (!command.parsed) return {};
  return {
    commandParser: command.parsed.version,
    commandDiagnostics: command.parsed.diagnostics,
    ...(command.parsed.approval ? { approval: command.parsed.approval } : {}),
    ...(command.parsed.network ? { network: command.parsed.network } : {})
  };
}

/**
 * Normalize an addressed Teams channel message into an `OpenTagEvent`. Returns
 * `null` when the command body is empty after trimming. `workItem` is omitted —
 * a channel mention is a pure chat mention, not a canonical external work item
 * (same as the Discord/Telegram adapters).
 */
export function normalizeTeamsActivity(input: TeamsActivityInput): OpenTagEvent | null {
  const rawText = input.text.trim();
  if (!rawText) return null;

  const command = commandFromRawText(rawText);

  return {
    id: `evt_teams_${input.activityId}`,
    source: "teams",
    sourceEventId: input.activityId,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    actor: {
      provider: "teams",
      providerUserId: input.userId,
      ...(input.userName ? { handle: input.userName } : {}),
      ...(input.teamId ? { organizationId: input.teamId } : {})
    },
    target: {
      mention: "@opentag",
      agentId: "opentag",
      ...(command.parsed?.executorHint ? { executorHint: command.parsed.executorHint } : {})
    },
    command,
    context: [
      {
        provider: "teams",
        kind: "message",
        uri: `teams://team/${input.teamId ?? "unknown"}/channel/${input.channelId ?? input.conversationId}/message/${input.activityId}`,
        visibility: "organization",
        title: "Teams message"
      },
      ...contextPointersForCommand(command)
    ],
    permissions: permissionsForIntent(command.intent),
    callback: {
      provider: "teams",
      uri: input.serviceUrl,
      threadKey: encodeTeamsThreadKey({
        serviceUrl: input.serviceUrl,
        conversationId: input.conversationId,
        activityId: input.activityId
      })
    },
    metadata: {
      tenantId: input.tenantId,
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.channelId ? { channelId: input.channelId } : {}),
      conversationId: input.conversationId,
      serviceUrl: input.serviceUrl,
      ...commandMetadata(command),
      repoProvider: input.binding.repoProvider ?? "github",
      owner: input.binding.owner,
      repo: input.binding.repo
    }
  };
}
```

- [ ] **Step 4: Re-export and run tests**

Add to `packages/teams/src/index.ts`:

```ts
export * from "./normalize.js";
```

Run: `corepack pnpm --dir packages/teams exec vitest run test/normalize.test.ts`
Expected: PASS. If a `PermissionGrant.scope` or `OpenTagCommand.intent` type mismatch appears, align scope strings with `packages/discord/src/normalize.ts` (they share the vocabulary).

- [ ] **Step 5: Commit**

```bash
git add packages/teams/src/normalize.ts packages/teams/src/index.ts packages/teams/test/normalize.test.ts
git commit -m "feat(teams): normalize addressed channel messages into OpenTagEvent"
```

---

### Task 4: Inbound Bot Framework JWT validation (`auth.ts`)

**Files:**
- Create: `packages/teams/src/auth.ts`
- Modify: `packages/teams/src/index.ts`
- Test: `packages/teams/test/auth.test.ts`

**Interfaces:**
- Consumes: `jose` (`createRemoteJWKSet`, `jwtVerify`).
- Produces:
  - `type TeamsAuthConfig = { appId: string; openIdMetadataUrl?: string; jwksClient?: JwksClient }` where `JwksClient` is the callable returned by `createRemoteJWKSet` (injected in tests).
  - `createTeamsAuthenticator(config: TeamsAuthConfig): { verify(input: { authorizationHeader: string | undefined; bodyServiceUrl: string }): Promise<TeamsAuthResult> }`
  - `type TeamsAuthResult = { ok: true } | { ok: false; reason: string }`

- [ ] **Step 1: Write the failing test** (inject a fake JWKS + sign tokens locally so no network is needed)

`packages/teams/test/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { createTeamsAuthenticator } from "../src/auth.js";

const ISSUER = "https://api.botframework.com";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  const jwksClient: JWTVerifyGetKey = async () => publicKey;
  async function mint(claims: Record<string, unknown>) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setExpirationTime("5m")
      .sign(privateKey);
  }
  return { jwksClient, mint };
}

describe("teams inbound JWT authentication", () => {
  it("accepts a token whose audience is our appId and serviceUrl matches", async () => {
    const { jwksClient, mint } = await setup();
    const auth = createTeamsAuthenticator({ appId: "app-123", jwksClient });
    const token = await mint({ aud: "app-123", serviceUrl: "https://smba/" });
    const result = await auth.verify({ authorizationHeader: `Bearer ${token}`, bodyServiceUrl: "https://smba/" });
    expect(result.ok).toBe(true);
  });

  it("rejects a token whose audience is a different app", async () => {
    const { jwksClient, mint } = await setup();
    const auth = createTeamsAuthenticator({ appId: "app-123", jwksClient });
    const token = await mint({ aud: "someone-else", serviceUrl: "https://smba/" });
    const result = await auth.verify({ authorizationHeader: `Bearer ${token}`, bodyServiceUrl: "https://smba/" });
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/audience/i) });
  });

  it("rejects when the token serviceUrl claim does not match the body serviceUrl", async () => {
    const { jwksClient, mint } = await setup();
    const auth = createTeamsAuthenticator({ appId: "app-123", jwksClient });
    const token = await mint({ aud: "app-123", serviceUrl: "https://evil/" });
    const result = await auth.verify({ authorizationHeader: `Bearer ${token}`, bodyServiceUrl: "https://smba/" });
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/serviceUrl/i) });
  });

  it("rejects a missing Authorization header", async () => {
    const { jwksClient } = await setup();
    const auth = createTeamsAuthenticator({ appId: "app-123", jwksClient });
    const result = await auth.verify({ authorizationHeader: undefined, bodyServiceUrl: "https://smba/" });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm --dir packages/teams exec vitest run test/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `auth.ts`**

```ts
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** Bot Framework OpenID metadata; the signing keys live behind this document. */
const DEFAULT_OPENID_METADATA_URL = "https://login.botframework.com/v1/.well-known/keys";
const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";

export type TeamsAuthResult = { ok: true } | { ok: false; reason: string };

export type TeamsAuthConfig = {
  /** Our Microsoft App ID; inbound token `aud` must equal this. */
  appId: string;
  /** Override the JWKS document URL (defaults to the Bot Framework keys endpoint). */
  openIdMetadataUrl?: string;
  /** Injectable key resolver (tests provide a local key; production builds one from the URL). */
  jwksClient?: JWTVerifyGetKey;
};

export function createTeamsAuthenticator(config: TeamsAuthConfig) {
  const jwks =
    config.jwksClient ??
    createRemoteJWKSet(new URL(config.openIdMetadataUrl ?? DEFAULT_OPENID_METADATA_URL));

  return {
    async verify(input: { authorizationHeader: string | undefined; bodyServiceUrl: string }): Promise<TeamsAuthResult> {
      const header = input.authorizationHeader ?? "";
      const match = /^Bearer\s+(.+)$/i.exec(header.trim());
      if (!match) return { ok: false, reason: "missing_bearer_token" };
      const token = match[1];

      let payload: Record<string, unknown>;
      try {
        const verified = await jwtVerify(token, jwks, {
          issuer: BOT_FRAMEWORK_ISSUER,
          audience: config.appId
        });
        payload = verified.payload as Record<string, unknown>;
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid_token";
        // jose reports audience/issuer failures here; surface a stable reason.
        if (/audience/i.test(message)) return { ok: false, reason: "audience_mismatch" };
        if (/issuer/i.test(message)) return { ok: false, reason: "issuer_mismatch" };
        return { ok: false, reason: "invalid_token" };
      }

      const tokenServiceUrl = typeof payload.serviceUrl === "string" ? payload.serviceUrl : undefined;
      if (tokenServiceUrl && normalizeUrl(tokenServiceUrl) !== normalizeUrl(input.bodyServiceUrl)) {
        return { ok: false, reason: "serviceUrl_mismatch" };
      }
      return { ok: true };
    }
  };
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}
```

- [ ] **Step 4: Re-export and run tests**

Add to `packages/teams/src/index.ts`:

```ts
export * from "./auth.js";
```

Run: `corepack pnpm --dir packages/teams exec vitest run test/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/teams/src/auth.ts packages/teams/src/index.ts packages/teams/test/auth.test.ts
git commit -m "feat(teams): validate inbound Bot Framework JWTs (jwks + audience + serviceUrl)"
```

---

### Task 5: Outbound OAuth2 token acquisition (`token.ts`)

**Files:**
- Create: `packages/teams/src/token.ts`
- Modify: `packages/teams/src/index.ts`
- Test: `packages/teams/test/token.test.ts`

**Interfaces:**
- Produces:
  - `type FetchLike = typeof fetch`
  - `createTeamsTokenProvider(input: { appId: string; appPassword: string; tenantId?: string; fetchImpl?: FetchLike; now?: () => number }): { getToken(): Promise<string> }`
  - Caches the token and refreshes 60s before `expires_in`.

- [ ] **Step 1: Write the failing test**

`packages/teams/test/token.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createTeamsTokenProvider } from "../src/token.js";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("teams outbound token provider", () => {
  it("requests a client-credentials token with the Bot Connector scope", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "tok-1", expires_in: 3600 }));
    const provider = createTeamsTokenProvider({ appId: "app", appPassword: "secret", fetchImpl });
    const token = await provider.getToken();
    expect(token).toBe("tok-1");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token");
    const body = new URLSearchParams((init as RequestInit).body as string);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("app");
    expect(body.get("client_secret")).toBe("secret");
    expect(body.get("scope")).toBe("https://api.botframework.com/.default");
  });

  it("uses the tenant authority when a tenantId is configured", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "tok", expires_in: 3600 }));
    const provider = createTeamsTokenProvider({ appId: "app", appPassword: "secret", tenantId: "t1", fetchImpl });
    await provider.getToken();
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://login.microsoftonline.com/t1/oauth2/v2.0/token");
  });

  it("caches the token until near expiry", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "tok", expires_in: 3600 }));
    const provider = createTeamsTokenProvider({ appId: "a", appPassword: "s", fetchImpl, now: () => now });
    await provider.getToken();
    now = 1000 * 1000; // still within validity
    await provider.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 3600 * 1000; // past refresh window
    await provider.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws on a non-2xx token response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const provider = createTeamsTokenProvider({ appId: "a", appPassword: "s", fetchImpl });
    await expect(provider.getToken()).rejects.toThrow(/token request failed/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm --dir packages/teams exec vitest run test/token.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `token.ts`**

```ts
export type FetchLike = typeof fetch;

const REFRESH_MARGIN_MS = 60_000;

export function createTeamsTokenProvider(input: {
  appId: string;
  appPassword: string;
  tenantId?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => Date.now());
  const authority = input.tenantId ?? "botframework.com";
  const url = `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`;

  let cached: { token: string; expiresAt: number } | null = null;

  return {
    async getToken(): Promise<string> {
      if (cached && now() < cached.expiresAt - REFRESH_MARGIN_MS) {
        return cached.token;
      }
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: input.appId,
        client_secret: input.appPassword,
        scope: "https://api.botframework.com/.default"
      });
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString()
      });
      if (!response.ok) {
        throw new Error(`Teams token request failed with status ${response.status}`);
      }
      const json = (await response.json()) as { access_token?: string; expires_in?: number };
      if (!json.access_token) {
        throw new Error("Teams token response missing access_token");
      }
      const expiresInMs = (json.expires_in ?? 3600) * 1000;
      cached = { token: json.access_token, expiresAt: now() + expiresInMs };
      return cached.token;
    }
  };
}
```

- [ ] **Step 4: Re-export and run tests**

Add to `packages/teams/src/index.ts`:

```ts
export * from "./token.js";
```

Run: `corepack pnpm --dir packages/teams exec vitest run test/token.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/teams/src/token.ts packages/teams/src/index.ts packages/teams/test/token.test.ts
git commit -m "feat(teams): add cached client-credentials token provider"
```

---

### Task 6: Reply rendering (`render.ts`)

**Files:**
- Create: `packages/teams/src/render.ts`
- Modify: `packages/teams/src/index.ts`
- Test: `packages/teams/test/render.test.ts`

**Interfaces:**
- Consumes: `createFinalSummaryPresentation`, `OpenTagFinalSummaryPresentation`, `OpenTagRunResult` from `@opentag/core`.
- Produces:
  - `renderTeamsAcknowledgement(runId: string): string`
  - `renderTeamsProgress(message: string): string`
  - `renderTeamsFinalResult(result: OpenTagRunResult, options?: { auditRunId?: string }): string`

- [ ] **Step 1: Write the failing test**

`packages/teams/test/render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderTeamsAcknowledgement, renderTeamsFinalResult, renderTeamsProgress } from "../src/render.js";

describe("teams render", () => {
  it("acknowledges with the run id", () => {
    expect(renderTeamsAcknowledgement("run-1")).toContain("run-1");
  });

  it("summarizes progress without leaking internal agent chatter", () => {
    expect(renderTeamsProgress("starting codex")).toBe("Thinking...");
    expect(renderTeamsProgress("uploading artifact")).toBe("Working...");
  });

  it("renders a final result with outcome, summary, and audit line", () => {
    const text = renderTeamsFinalResult(
      { outcome: "success", summary: "Opened PR #12", verification: [], nextActions: [] } as never,
      { auditRunId: "run-1" }
    );
    expect(text).toContain("success");
    expect(text).toContain("Opened PR #12");
    expect(text).toContain("opentag status --run run-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm --dir packages/teams exec vitest run test/render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `render.ts`** (adapts `packages/discord/src/render.ts`; Teams accepts Markdown so bullet lists render natively)

```ts
import { createFinalSummaryPresentation, type OpenTagFinalSummaryPresentation, type OpenTagRunResult } from "@opentag/core";

export type TeamsRenderOptions = { auditRunId?: string };

export function renderTeamsAcknowledgement(runId: string): string {
  return `Received. OpenTag is working.\nRun: ${runId}`;
}

export function renderTeamsProgress(message: string): string {
  if (/starting codex|starting claude --print|thinking/i.test(message)) {
    return "Thinking...";
  }
  return "Working...";
}

export function renderTeamsFinalResult(result: OpenTagRunResult, options: TeamsRenderOptions = {}): string {
  return renderTeamsFinalSummaryPresentation(
    createFinalSummaryPresentation({
      result,
      ...(options.auditRunId ? { auditRunId: options.auditRunId } : {})
    })
  );
}

export function renderTeamsFinalSummaryPresentation(presentation: OpenTagFinalSummaryPresentation): string {
  const lines = [`Finished with ${presentation.outcome}.`, "", presentation.summary];
  if (presentation.verification?.length) {
    lines.push("", "Verification:");
    for (const check of presentation.verification) {
      lines.push(`- ${check.command}: ${check.outcome}`);
    }
  }
  if (presentation.nextActions?.length) {
    lines.push("", `Next action: ${presentation.nextActions[0]}`);
  }
  if (presentation.auditRunId) {
    lines.push("", `Audit: opentag status --run ${presentation.auditRunId}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Re-export and run tests**

Add to `packages/teams/src/index.ts`:

```ts
export * from "./render.js";
```

Run: `corepack pnpm --dir packages/teams exec vitest run test/render.test.ts`
Expected: PASS. If `OpenTagRunResult` shape differs, copy the exact test fixture used in `packages/discord/test/render.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/teams/src/render.ts packages/teams/src/index.ts packages/teams/test/render.test.ts
git commit -m "feat(teams): add reply rendering helpers"
```

---

### Task 7: Bot Connector reply client (`connector.ts`)

**Files:**
- Create: `packages/teams/src/connector.ts`
- Modify: `packages/teams/src/index.ts`
- Test: `packages/teams/test/connector.test.ts`

**Interfaces:**
- Consumes: `FetchLike` (Task 5).
- Produces:
  - `type TeamsConnector = { postMessage(input: { serviceUrl: string; conversationId: string; text: string }): Promise<{ activityId: string }>; updateMessage(input: { serviceUrl: string; conversationId: string; activityId: string; text: string }): Promise<void> }`
  - `createTeamsConnector(input: { getToken: () => Promise<string>; fetchImpl?: FetchLike }): TeamsConnector`

- [ ] **Step 1: Write the failing test**

`packages/teams/test/connector.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createTeamsConnector } from "../src/connector.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("teams connector", () => {
  it("POSTs a new activity and returns its id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "reply-1" }, 201));
    const connector = createTeamsConnector({ getToken: async () => "tok", fetchImpl });
    const result = await connector.postMessage({
      serviceUrl: "https://smba/",
      conversationId: "19:conv",
      text: "hello"
    });
    expect(result).toEqual({ activityId: "reply-1" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://smba/v3/conversations/19:conv/activities");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as any).headers.authorization).toBe("Bearer tok");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ type: "message", text: "hello" });
  });

  it("PUTs an update to an existing activity", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 200));
    const connector = createTeamsConnector({ getToken: async () => "tok", fetchImpl });
    await connector.updateMessage({ serviceUrl: "https://smba/", conversationId: "19:conv", activityId: "reply-1", text: "edited" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://smba/v3/conversations/19:conv/activities/reply-1");
    expect((init as RequestInit).method).toBe("PUT");
  });

  it("throws on a non-2xx response (never a silent success)", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const connector = createTeamsConnector({ getToken: async () => "tok", fetchImpl });
    await expect(
      connector.postMessage({ serviceUrl: "https://smba/", conversationId: "19:conv", text: "x" })
    ).rejects.toThrow(/403/);
  });

  it("joins serviceUrl and path without a double slash", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "r" }, 200));
    const connector = createTeamsConnector({ getToken: async () => "tok", fetchImpl });
    await connector.postMessage({ serviceUrl: "https://smba/amer/", conversationId: "19:c", text: "x" });
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://smba/amer/v3/conversations/19:c/activities");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm --dir packages/teams exec vitest run test/connector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `connector.ts`**

```ts
import type { FetchLike } from "./token.js";

export type TeamsConnector = {
  postMessage(input: { serviceUrl: string; conversationId: string; text: string }): Promise<{ activityId: string }>;
  updateMessage(input: { serviceUrl: string; conversationId: string; activityId: string; text: string }): Promise<void>;
};

function activitiesUrl(serviceUrl: string, conversationId: string): string {
  const base = serviceUrl.endsWith("/") ? serviceUrl : `${serviceUrl}/`;
  return `${base}v3/conversations/${conversationId}/activities`;
}

export function createTeamsConnector(input: { getToken: () => Promise<string>; fetchImpl?: FetchLike }): TeamsConnector {
  const fetchImpl = input.fetchImpl ?? fetch;

  async function send(url: string, method: "POST" | "PUT", text: string): Promise<Record<string, unknown>> {
    const token = await input.getToken();
    const response = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "message", text })
    });
    if (!response.ok) {
      throw new Error(`Teams connector ${method} ${url} failed with status ${response.status}`);
    }
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  return {
    async postMessage({ serviceUrl, conversationId, text }) {
      const json = await send(activitiesUrl(serviceUrl, conversationId), "POST", text);
      const activityId = typeof json.id === "string" ? json.id : "";
      return { activityId };
    },
    async updateMessage({ serviceUrl, conversationId, activityId, text }) {
      await send(`${activitiesUrl(serviceUrl, conversationId)}/${activityId}`, "PUT", text);
    }
  };
}
```

- [ ] **Step 4: Re-export and run tests**

Add to `packages/teams/src/index.ts`:

```ts
export * from "./connector.js";
```

Run: `corepack pnpm --dir packages/teams exec vitest run test/connector.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/teams/src/connector.ts packages/teams/src/index.ts packages/teams/test/connector.test.ts
git commit -m "feat(teams): add Bot Connector post/update reply client"
```

---

### Task 8: Webhook app (`webhook-app.ts`)

**Files:**
- Create: `packages/teams/src/webhook-app.ts`
- Modify: `packages/teams/src/index.ts`
- Test: `packages/teams/test/webhook-app.test.ts`

**Interfaces:**
- Consumes: `extractTeamsMessage`, `normalizeTeamsActivity`, `encodeTeamsThreadKey`, `TeamsChannelBinding` (Tasks 2–3); `createTeamsAuthenticator` result (Task 4); `parseThreadActionCommand`, `readRequestTextWithLimit`, `RequestBodyTooLargeError`, `OpenTagEvent` from `@opentag/core`; `Hono`.
- Produces:
  - `type TeamsThreadActionInput = { id: string; rawText: string; actor: { provider: "teams"; providerUserId: string; handle: string }; callback: { provider: "teams"; uri: string; threadKey: string }; metadata: Record<string, unknown> }`
  - `type TeamsWebhookAppInput` (see Step 3)
  - `createTeamsWebhookApp(input: TeamsWebhookAppInput): Hono`

- [ ] **Step 1: Write the failing tests**

`packages/teams/test/webhook-app.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createTeamsWebhookApp } from "../src/webhook-app.js";

function baseInput(overrides: Partial<Parameters<typeof createTeamsWebhookApp>[0]> = {}) {
  return {
    authenticator: { verify: vi.fn(async () => ({ ok: true as const })) },
    resolveChannelBinding: vi.fn(async () => ({
      tenantId: "t1", teamId: "19:team", channelId: "19:chan",
      conversationId: "19:conv@thread.tacv2", owner: "acme", repo: "demo"
    })),
    createRun: vi.fn(async () => ({ runId: "run-1" })),
    submitThreadAction: vi.fn(async () => ({})),
    notifyConversation: vi.fn(async () => {}),
    now: () => "2026-07-07T00:00:00.000Z",
    ...overrides
  };
}

function channelActivity(text: string) {
  return {
    type: "message", id: "act-1", text, serviceUrl: "https://smba/",
    from: { id: "29:user", name: "Alice", aadObjectId: "aad-1" },
    recipient: { id: "28:bot", name: "OpenTag" },
    conversation: { id: "19:conv@thread.tacv2", conversationType: "channel", tenantId: "t1" },
    channelData: { tenant: { id: "t1" }, team: { id: "19:team" }, channel: { id: "19:chan" } },
    entities: [{ type: "mention", mentioned: { id: "28:bot" }, text: "<at>OpenTag</at>" }]
  };
}

async function post(app: ReturnType<typeof createTeamsWebhookApp>, body: unknown, headers: Record<string, string> = {}) {
  return app.request("/teams/messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer x", ...headers },
    body: JSON.stringify(body)
  });
}

describe("teams webhook app", () => {
  it("returns 401 when authentication fails", async () => {
    const input = baseInput({ authenticator: { verify: vi.fn(async () => ({ ok: false as const, reason: "audience_mismatch" })) } });
    const res = await post(createTeamsWebhookApp(input), channelActivity("<at>OpenTag</at> investigate"));
    expect(res.status).toBe(401);
    expect(input.createRun).not.toHaveBeenCalled();
  });

  it("acknowledges a mention with 200 and creates a run", async () => {
    const input = baseInput();
    const res = await post(createTeamsWebhookApp(input), channelActivity("<at>OpenTag</at> investigate this"));
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(input.createRun).toHaveBeenCalledTimes(1));
    const event = input.createRun.mock.calls[0][0];
    expect(event.source).toBe("teams");
    expect(event.id).toBe("evt_teams_act-1");
  });

  it("routes `apply N` to submitThreadAction, not createRun", async () => {
    const input = baseInput();
    const res = await post(createTeamsWebhookApp(input), channelActivity("<at>OpenTag</at> apply 1"));
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(input.submitThreadAction).toHaveBeenCalledTimes(1));
    expect(input.createRun).not.toHaveBeenCalled();
  });

  it("ignores a non-mention message with 200 and no run", async () => {
    const input = baseInput();
    const activity = channelActivity("just chatting");
    (activity as any).entities = [];
    const res = await post(createTeamsWebhookApp(input), activity);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(input.createRun).not.toHaveBeenCalled();
  });

  it("notifies the conversation when it is unbound", async () => {
    const input = baseInput({ resolveChannelBinding: vi.fn(async () => null) });
    await post(createTeamsWebhookApp(input), channelActivity("<at>OpenTag</at> investigate"));
    await vi.waitFor(() => expect(input.notifyConversation).toHaveBeenCalledTimes(1));
    expect(input.createRun).not.toHaveBeenCalled();
  });

  it("returns 413 for an over-limit body", async () => {
    const input = baseInput();
    const big = { ...channelActivity("<at>OpenTag</at> x"), padding: "z".repeat(1_100_000) };
    const res = await post(createTeamsWebhookApp(input), big);
    expect(res.status).toBe(413);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `corepack pnpm --dir packages/teams exec vitest run test/webhook-app.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `webhook-app.ts`** (mirrors `packages/discord/src/interactions-app.ts` control flow: size limit → auth → parse → ignore/act; deferred work after a 200)

```ts
import { createHash } from "node:crypto";
import { parseThreadActionCommand, readRequestTextWithLimit, RequestBodyTooLargeError, type OpenTagEvent } from "@opentag/core";
import { Hono } from "hono";
import { extractTeamsMessage, normalizeTeamsActivity, type TeamsChannelBinding } from "./normalize.js";
import { encodeTeamsThreadKey } from "./thread-key.js";
import type { TeamsAuthResult } from "./auth.js";

export type TeamsThreadActionInput = {
  id: string;
  rawText: string;
  actor: { provider: "teams"; providerUserId: string; handle: string };
  callback: { provider: "teams"; uri: string; threadKey: string };
  metadata: Record<string, unknown>;
};

export type TeamsWebhookAppInput = {
  authenticator: { verify(input: { authorizationHeader: string | undefined; bodyServiceUrl: string }): Promise<TeamsAuthResult> };
  webhookPath?: string;
  resolveChannelBinding(input: { tenantId: string; conversationId: string }): Promise<TeamsChannelBinding | null>;
  createRun(event: OpenTagEvent): Promise<{ runId?: string }>;
  submitThreadAction?(action: TeamsThreadActionInput): Promise<unknown>;
  /** Posts a plain notice back to a conversation (unbound / failure paths). */
  notifyConversation?(input: { serviceUrl: string; conversationId: string; text: string }): Promise<void>;
  onBackgroundError?(error: unknown): void;
  now(): string;
};

const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

function parseJsonPayload(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawBody);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function actionId(activityId: string, rawBody: string): string {
  const bodyHash = createHash("sha256").update(rawBody).digest("hex").slice(0, 12);
  return `approval_teams_${activityId}_${bodyHash}`;
}

export function createTeamsWebhookApp(input: TeamsWebhookAppInput) {
  const app = new Hono();
  const webhookPath = input.webhookPath ?? "/teams/messages";
  if (!webhookPath.startsWith("/")) {
    throw new Error("Teams webhook path must start with /.");
  }
  const reportBackgroundError =
    input.onBackgroundError ??
    ((error: unknown) => {
      console.error("Teams webhook background task failed:", error);
    });
  const safelyReport = (error: unknown) => {
    try {
      reportBackgroundError(error);
    } catch (reportError) {
      console.error("Teams webhook background error reporter failed:", reportError);
    }
  };

  app.post(webhookPath, async (c) => {
    let rawBody: string;
    try {
      rawBody = await readRequestTextWithLimit(c.req.raw, { maxBytes: MAX_WEBHOOK_BODY_BYTES });
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return c.json({ error: "payload_too_large" }, 413);
      }
      throw error;
    }

    const payload = parseJsonPayload(rawBody);
    if (!payload) {
      return c.json({ error: "invalid_json" }, 400);
    }

    const bodyServiceUrl = typeof payload.serviceUrl === "string" ? payload.serviceUrl : "";
    const auth = await input.authenticator.verify({
      authorizationHeader: c.req.header("authorization"),
      bodyServiceUrl
    });
    if (!auth.ok) {
      return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    }

    const message = extractTeamsMessage(payload);
    // Non-actionable activities (not a channel message / not addressed / no text)
    // are acknowledged with 200 so Bot Framework does not retry.
    if (!message || !message.text.trim()) {
      return c.body(null, 200);
    }

    const deferred = (work: () => Promise<void>, failureNotice: string) => {
      void Promise.resolve()
        .then(work)
        .catch((error) => {
          safelyReport(error);
          input
            .notifyConversation?.({ serviceUrl: message.serviceUrl, conversationId: message.conversationId, text: failureNotice })
            .catch(safelyReport);
        });
    };

    if (parseThreadActionCommand(message.text)) {
      const submitThreadAction = input.submitThreadAction;
      if (!submitThreadAction) {
        deferred(async () => {
          await input.notifyConversation?.({
            serviceUrl: message.serviceUrl,
            conversationId: message.conversationId,
            text: "Thread actions are not supported on this dispatcher."
          });
        }, "Sorry, that action couldn't be processed. Please try again.");
        return c.body(null, 200);
      }
      const action: TeamsThreadActionInput = {
        id: actionId(message.activityId, rawBody),
        rawText: message.text,
        actor: { provider: "teams", providerUserId: message.userId, handle: message.userName ?? message.userId },
        callback: {
          provider: "teams",
          uri: message.serviceUrl,
          threadKey: encodeTeamsThreadKey({
            serviceUrl: message.serviceUrl,
            conversationId: message.conversationId,
            activityId: message.activityId
          })
        },
        metadata: {
          repoProvider: "teams",
          tenantId: message.tenantId,
          conversationId: message.conversationId,
          ...(message.teamId ? { teamId: message.teamId } : {}),
          ...(message.channelId ? { channelId: message.channelId } : {})
        }
      };
      deferred(async () => {
        await submitThreadAction(action);
      }, "Sorry, that action couldn't be processed. Please try again.");
      return c.body(null, 200);
    }

    deferred(async () => {
      const binding = await input.resolveChannelBinding({ tenantId: message.tenantId, conversationId: message.conversationId });
      if (!binding) {
        await input.notifyConversation?.({
          serviceUrl: message.serviceUrl,
          conversationId: message.conversationId,
          text: "This channel is not bound to a repository. Bind it before mentioning OpenTag."
        });
        return;
      }
      const event = normalizeTeamsActivity({
        activityId: message.activityId,
        serviceUrl: message.serviceUrl,
        conversationId: message.conversationId,
        tenantId: message.tenantId,
        ...(message.teamId ? { teamId: message.teamId } : {}),
        ...(message.channelId ? { channelId: message.channelId } : {}),
        userId: message.userId,
        ...(message.userName ? { userName: message.userName } : {}),
        text: message.text,
        binding,
        receivedAt: input.now()
      });
      if (event) {
        await input.createRun(event);
      }
    }, "Sorry, OpenTag couldn't start this run. Please try again.");

    return c.body(null, 200);
  });

  return app;
}
```

- [ ] **Step 4: Re-export and run tests**

Add to `packages/teams/src/index.ts`:

```ts
export * from "./webhook-app.js";
```

Run: `corepack pnpm --dir packages/teams exec vitest run test/webhook-app.test.ts`
Expected: PASS. (If the 413 test does not trip, confirm `readRequestTextWithLimit` streams the body; the padded fixture is ~1.1 MB > the 1 MB cap.)

- [ ] **Step 5: Full package gate**

Run: `corepack pnpm --dir packages/teams exec vitest run`
Then: `corepack pnpm --dir packages/teams exec tsc --noEmit`
Expected: all tests PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/teams/src/webhook-app.ts packages/teams/src/index.ts packages/teams/test/webhook-app.test.ts
git commit -m "feat(teams): add Bot Framework webhook app (auth, ignore, run, action)"
```

---

### Task 9: Callback sink (`createTeamsCallbackSink`)

**Files:**
- Modify: `packages/dispatcher/src/callbacks.ts` (add the Teams sink next to `createDiscordCallbackSink`)
- Test: `packages/dispatcher/test/callbacks.teams.test.ts` (create; follow the existing Discord sink test if one exists)

**Interfaces:**
- Consumes: `parseTeamsThreadKey` (Task 2), `createTeamsConnector` (Task 7), `createTeamsTokenProvider` (Task 5), `renderTeams*` (Task 6) from `@opentag/teams`; the existing `CallbackSink` / `FetchLike` types in `callbacks.ts`.
- Produces: `createTeamsCallbackSink(input: { appId: string; appPassword: string; tenantId?: string; fetchImpl?: FetchLike }): CallbackSink`

- [ ] **Step 1: Read the existing Discord sink first**

Read `packages/dispatcher/src/callbacks.ts` around `createDiscordCallbackSink` (approx lines 212–260) to copy the exact `CallbackSink` interface, message-kind switch (`acknowledgement` / `progress` / `final`), and the in-memory edit-chain pattern (`existingMessageId` → POST first, edit after; serialized via a `current` promise chain that swallows prior errors so one failure does not break the chain).

- [ ] **Step 2: Write the failing test**

`packages/dispatcher/test/callbacks.teams.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createTeamsCallbackSink } from "../src/callbacks.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const threadKey = "https://smba/|19:conv@thread.tacv2|act-1";

describe("teams callback sink", () => {
  it("posts the first message then edits the same activity for later updates", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/oauth2/")) return jsonResponse({ access_token: "tok", expires_in: 3600 });
      if (init?.method === "POST") return jsonResponse({ id: "reply-1" }, 201);
      return jsonResponse({}, 200);
    });
    const sink = createTeamsCallbackSink({ appId: "app", appPassword: "s", fetchImpl });

    await sink.deliver({ kind: "acknowledgement", runId: "run-1", threadKey, provider: "teams", message: "ack" } as never);
    await sink.deliver({ kind: "final", runId: "run-1", threadKey, provider: "teams", result: { outcome: "success", summary: "done", verification: [], nextActions: [] } } as never);

    const connectorCalls = fetchImpl.mock.calls.filter(([u]) => String(u).includes("/v3/conversations/"));
    expect(connectorCalls[0][1]?.method).toBe("POST");
    expect(connectorCalls[1][1]?.method).toBe("PUT");
    expect(String(connectorCalls[1][0])).toContain("/activities/reply-1");
  });

  it("surfaces a non-2xx connector response as an error", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/oauth2/")) return jsonResponse({ access_token: "tok", expires_in: 3600 });
      return new Response("forbidden", { status: 403 });
    });
    const onError = vi.fn();
    const sink = createTeamsCallbackSink({ appId: "app", appPassword: "s", fetchImpl });
    // Adapt this to however the existing sink surfaces errors (return value, throw,
    // or an onError hook). Mirror the Discord sink test's assertion style.
    await expect(
      sink.deliver({ kind: "acknowledgement", runId: "run-x", threadKey, provider: "teams", message: "ack" } as never)
    ).rejects.toThrow(/403/);
  });
});
```

Note: adjust the `deliver` message shape and error assertion to match the real `CallbackSink` contract you read in Step 1 — the exact field names (`message` vs `text`, how `final` carries the result) come from the existing code, not this sketch.

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm --dir packages/dispatcher exec vitest run test/callbacks.teams.test.ts`
Expected: FAIL — `createTeamsCallbackSink` not exported.

- [ ] **Step 4: Implement `createTeamsCallbackSink`** in `packages/dispatcher/src/callbacks.ts`

Add near `createDiscordCallbackSink`. Use the exact `CallbackSink` shape from the file; the body below is the intent — align field access with the real message type:

```ts
import { parseTeamsThreadKey, createTeamsConnector, createTeamsTokenProvider, renderTeamsAcknowledgement, renderTeamsProgress, renderTeamsFinalResult } from "@opentag/teams";

export function createTeamsCallbackSink(input: { appId: string; appPassword: string; tenantId?: string; fetchImpl?: FetchLike }): CallbackSink {
  const tokenProvider = createTeamsTokenProvider({
    appId: input.appId,
    appPassword: input.appPassword,
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
  const connector = createTeamsConnector({
    getToken: () => tokenProvider.getToken(),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
  // Per-run edit chain: activityId of the first reply, keyed by threadKey.
  const firstActivityId = new Map<string, string>();

  return {
    async deliver(message) {
      const { serviceUrl, conversationId } = parseTeamsThreadKey(message.threadKey);
      const text =
        message.kind === "final"
          ? renderTeamsFinalResult(message.result, message.runId ? { auditRunId: message.runId } : {})
          : message.kind === "progress"
            ? renderTeamsProgress(message.message ?? "")
            : renderTeamsAcknowledgement(message.runId ?? "");

      const existing = firstActivityId.get(message.threadKey);
      if (!existing) {
        const { activityId } = await connector.postMessage({ serviceUrl, conversationId, text });
        if (activityId) firstActivityId.set(message.threadKey, activityId);
        return;
      }
      await connector.updateMessage({ serviceUrl, conversationId, activityId: existing, text });
    }
  };
}
```

If the file's real `CallbackSink` serializes deliveries through a shared promise chain and swallows prior errors (the Discord sink does), replicate that so a transient failure does not break later updates for the same run.

- [ ] **Step 5: Run tests to verify they pass**

Run: `corepack pnpm --dir packages/dispatcher exec vitest run test/callbacks.teams.test.ts`
Expected: PASS.

- [ ] **Step 6: Add `@opentag/teams` as a dispatcher dependency**

In `packages/dispatcher/package.json`, add `"@opentag/teams": "workspace:*"` to `dependencies` (matching how `@opentag/discord` is listed). Add `{ "path": "../teams" }` to `packages/dispatcher/tsconfig.json` `references` if Discord is referenced there.

Run: `corepack pnpm install && corepack pnpm --dir packages/dispatcher exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/dispatcher/src/callbacks.ts packages/dispatcher/test/callbacks.teams.test.ts packages/dispatcher/package.json packages/dispatcher/tsconfig.json
git commit -m "feat(teams): add Teams callback sink with edit-chain replies"
```

---

### Task 10: Wire the webhook app + sink into `local-runtime`

**Files:**
- Modify: `packages/local-runtime/src/dispatcher.ts` (imports ~line 5–18; config type ~lines 64–67; env population ~lines 374–416; sink registration ~lines 573–600; a new Teams mount block modeled on the Discord webhook branch ~lines 782–887)
- Modify: `packages/local-runtime/package.json` (add `@opentag/teams` dependency)
- Test: `packages/local-runtime/test/dispatcher.teams.test.ts` (create; assert the Teams route mounts and a signed-through request creates a run, using an injected authenticator/fetch)

**Interfaces:**
- Consumes: `createTeamsWebhookApp` (Task 8), `createTeamsAuthenticator` (Task 4), `createTeamsCallbackSink` (Task 9).
- Produces: dispatcher config fields `teamsAppId`, `teamsAppPassword`, `teamsTenantId`, `teamsWebhookPath`; a mounted Teams webhook route when Teams is configured; a `createTeamsCallbackSink` entry inside the composite sink.

- [ ] **Step 1: Read the Discord wiring first**

Read `packages/local-runtime/src/dispatcher.ts` Discord sections: imports, the `discordMode/discordPublicKey/discordBotToken/discordWebhookPath` config fields, their env population, the composite-sink `createDiscordCallbackSink({...})` entry, and the mount block (`app.route("/", createDiscordInteractionsApp({...}))`). The Teams wiring mirrors these one-to-one.

- [ ] **Step 2: Write the failing integration test**

`packages/local-runtime/test/dispatcher.teams.test.ts` — assert that when `teamsAppId`/`teamsAppPassword` are configured, POSTing an addressed channel activity to the Teams webhook path resolves a binding and calls `createRun`. Model the harness on the existing Discord dispatcher test (find it via `ls packages/local-runtime/test`); inject a stub authenticator (`verify` → `{ ok: true }`) and a `resolveChannelBinding` that returns a fixed binding so the test needs no real JWT.

```ts
import { describe, expect, it, vi } from "vitest";
// Import the dispatcher factory the same way the Discord test does; the exact
// export name and setup come from the existing test file you are mirroring.

describe("local-runtime teams wiring", () => {
  it("mounts the teams webhook and creates a run for an addressed channel message", async () => {
    // 1. Build the dispatcher with teams config + injected authenticator/binding/createRun spy.
    // 2. POST a channel activity mentioning the bot to the teams webhook path.
    // 3. Expect 200 and (await) createRun called once with source "teams".
    expect(true).toBe(true); // replace with the mirrored Discord-test assertions
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm --dir packages/local-runtime exec vitest run test/dispatcher.teams.test.ts`
Expected: FAIL (before wiring) once real assertions replace the placeholder.

- [ ] **Step 4: Add config fields**

In the dispatcher config type (near the Discord fields), add:

```ts
  teamsAppId?: string;
  teamsAppPassword?: string;
  teamsTenantId?: string;
  teamsWebhookPath?: string;
```

Populate them from env alongside the Discord env block:

```ts
  teamsAppId: process.env.OPENTAG_TEAMS_APP_ID,
  teamsAppPassword: process.env.OPENTAG_TEAMS_APP_PASSWORD,
  teamsTenantId: process.env.OPENTAG_TEAMS_TENANT_ID,
  teamsWebhookPath: process.env.OPENTAG_TEAMS_WEBHOOK_PATH,
```

- [ ] **Step 5: Register the sink**

Add to the `createCompositeCallbackSink([...])` array (guard on config presence the same way the other platform sinks are guarded):

```ts
      ...(config.teamsAppId && config.teamsAppPassword
        ? [createTeamsCallbackSink({
            appId: config.teamsAppId,
            appPassword: config.teamsAppPassword,
            ...(config.teamsTenantId ? { tenantId: config.teamsTenantId } : {})
          })]
        : []),
```

- [ ] **Step 6: Mount the webhook app**

Add a Teams mount block modeled on the Discord webhook branch:

```ts
    if (config.teamsAppId && config.teamsAppPassword) {
      const teamsApp = createTeamsWebhookApp({
        authenticator: createTeamsAuthenticator({ appId: config.teamsAppId }),
        ...(config.teamsWebhookPath ? { webhookPath: config.teamsWebhookPath } : {}),
        resolveChannelBinding: async ({ tenantId, conversationId }) => {
          // Reuse the same binding resolution the other platforms use; key on
          // (tenantId, conversationId). Return null when unbound.
          return resolveTeamsBinding({ tenantId, conversationId });
        },
        createRun: (event) => dispatcherClient.createRun(event),
        submitThreadAction: (action) => dispatcherClient.submitThreadAction(action),
        notifyConversation: async ({ serviceUrl, conversationId, text }) => {
          const token = await teamsTokenProvider.getToken();
          await createTeamsConnector({ getToken: async () => token }).postMessage({ serviceUrl, conversationId, text });
        },
        now: () => new Date().toISOString()
      });
      app.route("/", teamsApp);
    }
```

Use the same `dispatcherClient`, binding resolver, and `submitThreadAction` wiring the Discord branch uses (copy the exact helper names from that block). Add the imports:

```ts
import { createTeamsWebhookApp, createTeamsAuthenticator, createTeamsCallbackSink, createTeamsConnector, createTeamsTokenProvider } from "@opentag/teams";
```

(If `createTeamsCallbackSink` lives in `@opentag/dispatcher`, import it from there as the Discord sink is imported.)

- [ ] **Step 7: Add the dependency and run tests**

In `packages/local-runtime/package.json`, add `"@opentag/teams": "workspace:*"`.

Run: `corepack pnpm install`
Then: `corepack pnpm --dir packages/local-runtime exec vitest run test/dispatcher.teams.test.ts`
Then: `corepack pnpm --dir packages/local-runtime exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/local-runtime/src/dispatcher.ts packages/local-runtime/package.json packages/local-runtime/test/dispatcher.teams.test.ts
git commit -m "feat(teams): mount Teams webhook and sink in local-runtime dispatcher"
```

---

### Task 11: CLI setup + platform catalog

**Files:**
- Modify: `packages/cli/src/catalogs/platforms.ts` (`PlatformId` union line 3; `PLATFORM_SETUP_GUIDE_FILES`; `PLATFORM_CATALOG` add a `teams` entry; `parsePlatformId` list ~lines 83–86)
- Modify: `packages/cli/src/setup/types.ts` (add `TeamsSetupInput`/mode types near the Discord ones)
- Modify: `packages/cli/src/setup/flow.ts` (prompts + CLI flags; add `DEFAULT_TEAMS_WEBHOOK_PATH = "/teams/messages"`)
- Modify: `packages/cli/src/setup/builders.ts` (write `platforms.teams.{appId,appPassword,tenantId,webhookPath}` into config)
- Modify: `packages/cli/src/setup/guides.ts` (Teams credential help text + doc link)
- Modify: `packages/cli/src/setup/defaults.ts`, `summary.ts` (recall + summary lines, mirroring Discord)
- Create: `packages/cli/src/platforms/teams/display.ts` (status display, mirror `platforms/discord/display.ts`)
- Test: `packages/cli/test/setup.teams.test.ts` (create; assert `parsePlatformId("teams")` works and a scripted setup writes the Teams config block)

**Interfaces:**
- Consumes: nothing from earlier tasks (CLI writes config keys the dispatcher reads in Task 10).
- Produces: `PlatformId` including `"teams"`; config shape `platforms.teams = { appId, appPassword, tenantId?, webhookPath? }`; `--platform teams --teams-app-id --teams-app-password [--teams-tenant-id]` flags.

- [ ] **Step 1: Read the Discord CLI wiring first**

Read every Discord touchpoint in `packages/cli/src` (grep `discord`): `catalogs/platforms.ts`, `setup/types.ts`, `setup/flow.ts`, `setup/builders.ts`, `setup/guides.ts`, `setup/defaults.ts`, `setup/summary.ts`, `platforms/discord/display.ts`. The Teams changes mirror these; copy the structure, swap the fields (Teams has no `publicKey`/gateway `mode`; it has `appId`, `appPassword`, optional `tenantId`, `webhookPath`).

- [ ] **Step 2: Write the failing test**

`packages/cli/test/setup.teams.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parsePlatformId } from "../src/catalogs/platforms.js";

describe("teams platform catalog", () => {
  it("parses teams as a known platform id", () => {
    expect(parsePlatformId("teams")).toBe("teams");
  });
});
```

Add a second test that mirrors the Discord builder test (find it by grepping `discord` under `packages/cli/test`) asserting a scripted Teams setup writes `platforms.teams.appId` / `appPassword`.

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm --dir packages/cli exec vitest run test/setup.teams.test.ts`
Expected: FAIL — `parsePlatformId("teams")` throws / returns undefined.

- [ ] **Step 4: Add `teams` to the platform catalog**

In `packages/cli/src/catalogs/platforms.ts`:
- Add `| "teams"` to `PlatformId`.
- Add `teams: "platforms/teams.en.md"` (and the zh-CN variant if the map carries both) to `PLATFORM_SETUP_GUIDE_FILES`.
- Add the catalog entry mirroring Discord:

```ts
  { id: "teams", label: "Microsoft Teams", status: "setup_ready", startable: true },
```

- Add `"teams"` to the `parsePlatformId` accepted list / error message.

- [ ] **Step 5: Add setup types, flow, builder, guide, defaults, summary, display**

Mirror each Discord change with Teams fields (`appId`, `appPassword`, optional `tenantId`, `webhookPath` defaulting to `/teams/messages`). In `builders.ts`, write:

```ts
  platforms.teams = {
    appId: input.teams.appId,
    appPassword: input.teams.appPassword,
    ...(input.teams.tenantId ? { tenantId: input.teams.tenantId } : {}),
    webhookPath: input.teams.webhookPath ?? "/teams/messages"
  };
```

The dispatcher (Task 10) reads these via `OPENTAG_TEAMS_*` env; ensure the CLI's config→env mapping (wherever Discord's `OPENTAG_DISCORD_*` values are exported to the runtime) also exports `OPENTAG_TEAMS_APP_ID`, `OPENTAG_TEAMS_APP_PASSWORD`, `OPENTAG_TEAMS_TENANT_ID`, `OPENTAG_TEAMS_WEBHOOK_PATH`. Grep for `OPENTAG_DISCORD_` to find that mapping and add the Teams keys beside it.

- [ ] **Step 6: Run tests to verify they pass**

Run: `corepack pnpm --dir packages/cli exec vitest run test/setup.teams.test.ts`
Then: `corepack pnpm --dir packages/cli exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src packages/cli/test/setup.teams.test.ts
git commit -m "feat(teams): add Teams to CLI setup and platform catalog"
```

---

### Task 12: Platform docs + final repo gates

**Files:**
- Create: `docs/platforms/teams.en.md`
- Create: `docs/platforms/teams.zh-CN.md`
- Modify: `docs/platforms/README.md` (add Teams to the platform table)
- Modify: `README.md` and `README.zh-CN.md` (add Teams to the platform tutorial table + package list rows for `@opentag/teams`)

**Interfaces:**
- Consumes: everything above (docs describe the finished setup).
- Produces: user-facing setup guides.

- [ ] **Step 1: Write `docs/platforms/teams.en.md`**

Cover, mirroring `docs/platforms/discord.en.md`'s structure:
- Create an Azure Bot / Bot Framework registration; note the **F0 free tier**.
- Copy the **Microsoft App ID** and create a **client secret** (the `appPassword`).
- Single-tenant vs multi-tenant: set `tenantId` for single-tenant.
- Expose the local dispatcher endpoint via a **dev tunnel** (`devtunnel` / `ngrok`) and set the bot's **messaging endpoint** to `https://<tunnel>/teams/messages`.
- Install the bot into a **team** and add it to the target **channel** (note the tenant-admin approval that org tenants may require).
- Bind the channel to a repo; explain the `(tenantId, conversationId)` binding.
- Setup command: `opentag setup --platform teams --teams-app-id <id> --teams-app-password <secret> [--teams-tenant-id <tenant>]`.
- v1 limits: channels only, plain-text replies, `@OpenTag` mention (and `@OpenTag apply N`).

- [ ] **Step 2: Write `docs/platforms/teams.zh-CN.md`** — the same content in Simplified Chinese, matching the tone of `discord.zh-CN.md`.

- [ ] **Step 3: Update the tables**

Add a Teams row to `docs/platforms/README.md`, `README.md`, and `README.zh-CN.md` (platform tutorial table). Add `@opentag/teams` to the package tables in both READMEs:

```
| [`@opentag/teams`](https://www.npmjs.com/package/@opentag/teams) | Microsoft Teams Bot Framework ingest, channel replies, and action apply |
```

- [ ] **Step 4: Run the full repo gates**

Run: `corepack pnpm install`
Run: `corepack pnpm test`
Run: `corepack pnpm typecheck`
Run: `corepack pnpm lint`
Run: `corepack pnpm build`
Expected: all PASS. Fix any failures before committing.

- [ ] **Step 5: Commit**

```bash
git add docs/platforms/teams.en.md docs/platforms/teams.zh-CN.md docs/platforms/README.md README.md README.zh-CN.md
git commit -m "docs(teams): add Microsoft Teams setup guides and package tables"
```

---

## Post-implementation

- Real-provider verification: follow `docs/real-integration-smoke-test.md` end-to-end — @mention the bot in a real team channel, confirm the reply lands in the correct thread (verify `conversation.id` threading), and confirm `@OpenTag apply N` routes to an action.
- Out of scope (do not implement here): Adaptive Cards / clickable Apply buttons, personal & group chats, any standalone `apps/teams-events` service.
