# Reply threads

> For maintainers. Why reply threads are shaped the way they are.

A reply thread is a Slack style side conversation on one agent response. It is an ordinary
[thread fork](../orchestration-v2/thread-lineage-and-context-transfer.md) with a different
presentation, not a separate entity.

## Model

- A reply thread is a `thread.fork` from a run, dispatched with `presentation: "reply"`. The fork
  records `lineage.presentation = "reply"` next to `relationshipToParent: "fork"`.
- The anchor is the fork's own `forkedFrom: { type: "run" }`. There is no second anchor field.
- Context transfer is the fork's: native when the provider can fork, portable context otherwise.
  Reply threads are therefore available wherever "Fork from this response" is.

`relationshipToParent` stays `"fork"` on purpose. Merge back, MCP lineage, and provider
continuation treat reply threads as forks, which they are. Only places that list threads ask
[`isReplyThreadLineage`](../../packages/contracts/src/orchestrationV2.ts) and leave them out:
sidebar, command palette, navigation shells, thread relationships, and mobile thread lists.

## Decisions

1. **One level deep.** The fork service rejects a reply fork whose source is itself a reply thread.
2. **Eager fork, reused when unsent.** Clicking reply forks immediately: a fork only records lineage
   and resolves provider work on its first run, so it is cheap. An existing reply thread for the
   same anchor is reopened instead of forking again, and the chip appears only after the first
   reply, so an abandoned panel leaves nothing visible and at most one empty fork per anchor.
3. **One panel, swapped in place.** The `reply-thread` right panel surface is a singleton keyed by
   anchor run. Opening another anchor replaces it.
4. **The panel is the reply thread's own `ChatView`, embedded.** `embedded` drops the title bar,
   right panel, and window level listeners (shortcuts, paste, window focus, body scroll keys),
   which stay with the parent view. Any new window level listener in `ChatView` must skip
   `embedded`, or both views will handle the same event. The composer's `reply` variant hides
   the controls a fork inherits from its parent.
5. **Shared workspace.** Like any fork, a reply thread uses the parent's branch and worktree.

## Not yet

A reply count on the chip (the shell carries no per thread run count), archive and delete cascading
from the parent, and mobile UI. Mobile hides reply threads, so they are unreachable there for now.
