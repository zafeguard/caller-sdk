# CLAUDE.md

## Coding rules (project-wide)

These three rules are enforced across every TypeScript repo in this workspace. Surface them in code review, lint where possible, and refuse to land code that violates them without an explicit, comment-justified exception.

### 1. No literal string for fixed-value types — use enum

If a value belongs to a closed set (status, type, category, error code, event kind, role, plan tier), it MUST be an `enum` or a `const` object with `as const`. Inline string literals at usage sites are banned for these values.

```ts
// ❌ wrong
if (user.status === 'PENDING') {}
return { type: 'INVOICE', template: {} };

// ✅ right
if (user.status === EUserStatus.PENDING) {}
return { type: EmailType.INVOICE, template: {} };
```

Exempt: log/error messages, free-form user content, message-pattern routing keys when already centralised in a `const … as const` registry (e.g. `NOTIFICATION_PATTERNS.EMAIL_SEND`).

### 2. DTOs and Response classes use `readonly`

Every field on a class used as an inbound DTO (`@Body()`, `@Payload()`) or outbound Response is declared `readonly`. Mutation belongs to entities/services, not to the transport boundary. Class-level `@ApiProperty()` decorators remain on the readonly field.

```ts
// ❌ wrong
export class RegisterDTO {
  email: string;
  password: string;
}

// ✅ right
export class RegisterDTO {
  readonly email!: string;
  readonly password!: string;
}
```

### 3. No inline types, no `any`

- **No inline object types** in function signatures or returns. Extract to a named `type` / `interface`. Keeps signatures legible, types reusable, and refactors safe.
- **No `any`** anywhere. Use the real type. At boundaries where shape is genuinely unknown, prefer `unknown` and narrow inside the function. `any` only with a `// eslint-disable-next-line @typescript-eslint/no-explicit-any` comment that explains the unavoidable third-party-types reason.

```ts
// ❌ wrong
function send(opts: { to: string; subject: string }, payload: any) {}

// ✅ right
type SendOptions = { readonly to: string; readonly subject: string };
function send(opts: SendOptions, payload: unknown) {}
```

## Workflow rules

- **Commit by feature, always.** Each logical change is its own commit with a Conventional Commit subject (`feat:`, `fix:`, `refactor:`, `test:`, `chore:`, `docs:`, `ci:`, `build:`). Group related file changes together — never one giant "WIP" commit, never split a single feature across unrelated commits.
- **Pre-commit checks are mandatory.** Before every commit run, in order: type check (`tsc --noEmit -p tsconfig.json` or `npm run type-check`), the unit tests (`npm test` / `npm run test:cov`), and the production build (`npm run build`). If any fail, fix first — never commit known-broken code. If a check is genuinely impossible in this repo (e.g. requires a remote dep version not yet released), say so in the commit body and proceed only with explicit justification.
- **Be concise.** Short replies. Strong verbs. Skip filler. The output should leave room for the user to think, not refill their context with restated information.
- **Don't re-read files.** The conversation transcript and recent reads stay in context. Re-reading is wasted tokens and usually a signal to slow down and use what you already know.
- **No sycophantic openers or closing fluff.** Don't start with "Great question!" / "I'd be happy to" / "Hope this helps!" — just answer.
- **Keep it simple.** Smallest change that solves the problem. No premature abstraction, no speculative generality, no helper for code used once.
- **One focused coding pass.** Plan the edits, make them in order, verify once at the end. No write-then-rewrite cycles. If you find you're undoing your own work, stop and rethink before continuing.
