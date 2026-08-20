# Reply threads

> For maintainers. Design record for the reply thread feature, settled before implementation.

A reply thread is a conversation fork inside a thread, modeled on the Slack reply thread experience. It lets a user branch off from a completed turn, ask side questions or explore a direction, and leave the parent conversation context untouched. The mechanism underneath is a provider session fork, matching what Claude Code offers when a session is resumed as a fork.

## Model

A reply thread is a regular thread carrying two additive optional fields, `parentThreadId` and `anchorTurnId`. There is no new entity type, no new subscription machinery, and no new conversation surface in the contracts. Everything a thread can do, a reply thread can do, except where a decision below narrows it.

## Decisions

1. **Vocabulary.** The user facing and code facing term is "reply thread". The word "fork" is reserved for the provider session operation that seeds one. The turn a reply thread hangs off is its "anchor turn". Both terms are in the [glossary](./glossary.md).
2. **Anchor granularity.** Reply threads anchor to a completed turn, never to an individual message. The affordance may render on any message row but resolves to the containing turn.
3. **Anchor position.** Any completed past turn can be an anchor, not just the latest one.
4. **Cardinality.** One reply thread per anchor turn, enforced in the decider. Deleting the reply thread frees the anchor.
5. **Depth.** One level only. The decider rejects creating a thread whose parent already has a parent.
6. **Provider scope.** Claude only at launch, behind a `sessionFork` entry in the provider adapter capabilities. Providers without the capability simply never show the affordance. Codex and OpenCode have native fork primitives and can follow; Cursor and Grok speak ACP, which has no fork primitive.
7. **Inherited settings.** Model, runtime mode, and interaction mode are copied from the parent at fork time and locked. The reply thread composer hides those pickers entirely. Provider instance and continuation identity are always inherited, since the orchestration layer rejects children whose resume state is incompatible.
8. **Discoverability.** Reply threads are hidden everywhere: sidebar, command palette, search, and badges. The only way in is the chip on the anchor turn, which shows the reply count, where one user to assistant exchange counts as one reply, and recency.
9. **Lifecycle coupling.** Archiving or deleting the parent cascades to its reply threads. Snooze stays per thread. Reverting the parent past an anchor turn deletes the reply thread anchored there, and the revert confirmation says so.
10. **Creation flow.** Lazy. Clicking "Reply in sub-thread" opens the panel with an empty composer; the thread is created and the session forked only on first send, reusing the existing draft pattern. Closing the panel without sending leaves no trace.
11. **Concurrency.** Turns may run in parallel across a parent and its reply thread. Checkpoint git operations were already serialized by the checkpoint reactor's single worker fiber, which covers the capture race for free. Checkpoint revert is blocked while any turn in the family is running.
12. **Web presentation.** A single right panel surface, swapped in place when a different anchor chip is clicked, like the Slack panel. The anchor turn's assistant message is pinned at the top of the panel, and the composer is the main thread's composer in a reply variant: identical editing, attachments, approvals, and context meter, with the locked controls (model picker, extras menu, mode toggles) hidden. No peer tabs, no title generation; the panel is labeled from the parent.
13. **Mobile.** Deferred to a follow up. The data layer works there unchanged; until the follow up lands, mobile renders no chip and reply threads are unreachable from mobile.
14. **History before the feature.** Forking needs a per turn anchor recorded by the Claude adapter, captured only from launch onward. Turns that predate the feature never show the affordance. No backfill.

## Workspace sharing

This is the decision most worth explaining, because it will surprise a reader who expects Slack semantics to extend to files.

**Context.** Slack threads cannot interfere with each other because messages are inert text. Agent turns edit files. A reply thread that truly could not interfere with its parent would need an isolated worktree, which reinvents parallel session management and merge back complexity.

**Decision.** A reply thread forks conversation context only. It shares the parent workspace, branch, and worktree. File edits made in a reply thread land in the same working tree the parent sees.

**Consequences.** The parent full thread diff can include changes it did not make. Reverting a parent turn restores files to a state before reply thread edits that happened later. Both are accepted and surfaced in the UI rather than papered over: the diff panel hints when reply thread changes are included. Worktree isolation may arrive later as a per thread configuration; the primary use case, cheap side questions that rarely edit files, does not need it.

## Out of scope for the first version

Promoting a reply thread back into the parent as a summary message, worktree isolation as a configuration option, mobile UI, providers beyond Claude, and reply thread nesting. Each has a natural attachment point in the model above and none requires schema changes beyond what ships in the first version.
