import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const now = "2026-01-01T00:00:00.000Z";

const modelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-fable-5",
};

const threadCreatedEvent = (input: {
  sequence: number;
  threadId: string;
  projectId: string;
  parentThreadId?: string;
  anchorTurnId?: string;
}) =>
  ({
    sequence: input.sequence,
    eventId: asEventId(`evt-${input.threadId}`),
    aggregateKind: "thread",
    aggregateId: asThreadId(input.threadId),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId(`cmd-${input.threadId}`),
    causationEventId: null,
    correlationId: asCommandId(`cmd-${input.threadId}`),
    metadata: {},
    payload: {
      threadId: asThreadId(input.threadId),
      projectId: asProjectId(input.projectId),
      title: `Thread ${input.threadId}`,
      modelSelection,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      ...(input.parentThreadId !== undefined && input.anchorTurnId !== undefined
        ? {
            parentThreadId: asThreadId(input.parentThreadId),
            anchorTurnId: asTurnId(input.anchorTurnId),
          }
        : {}),
      createdAt: now,
      updatedAt: now,
    },
  }) satisfies OrchestrationEvent;

// Project, parent thread with one completed turn ("turn-1"), and a sibling
// project to exercise the cross-project invariant.
const seedReadModel = Effect.gen(function* () {
  let readModel = createEmptyReadModel(now);
  let sequence = 0;
  const apply = (event: Omit<OrchestrationEvent, "sequence">) => {
    sequence += 1;
    return projectEvent(readModel, { ...event, sequence } as OrchestrationEvent).pipe(
      Effect.map((next) => {
        readModel = next;
        return next;
      }),
    );
  };

  for (const projectId of ["project-a", "project-b"]) {
    yield* apply({
      eventId: asEventId(`evt-${projectId}`),
      aggregateKind: "project",
      aggregateId: asProjectId(projectId),
      type: "project.created",
      occurredAt: now,
      commandId: asCommandId(`cmd-${projectId}`),
      causationEventId: null,
      correlationId: asCommandId(`cmd-${projectId}`),
      metadata: {},
      payload: {
        projectId: asProjectId(projectId),
        title: `Project ${projectId}`,
        workspaceRoot: `/tmp/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  yield* apply(threadCreatedEvent({ sequence: 0, threadId: "parent-1", projectId: "project-a" }));
  yield* apply({
    eventId: asEventId("evt-parent-1-turn-1-diff"),
    aggregateKind: "thread",
    aggregateId: asThreadId("parent-1"),
    type: "thread.turn-diff-completed",
    occurredAt: now,
    commandId: asCommandId("cmd-parent-1-turn-1-diff"),
    causationEventId: null,
    correlationId: asCommandId("cmd-parent-1-turn-1-diff"),
    metadata: {},
    payload: {
      threadId: asThreadId("parent-1"),
      turnId: asTurnId("turn-1"),
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.make("refs/t3/checkpoints/parent-1/turn/1"),
      status: "ready",
      files: [],
      assistantMessageId: MessageId.make("assistant-msg-1"),
      completedAt: now,
    },
  });

  return readModel;
});

const replyThreadCreateCommand = (input: {
  commandId: string;
  threadId: string;
  projectId?: string;
  parentThreadId?: string | null;
  anchorTurnId?: string | null;
}): Extract<OrchestrationCommand, { type: "thread.create" }> => ({
  type: "thread.create",
  commandId: asCommandId(input.commandId),
  threadId: asThreadId(input.threadId),
  projectId: asProjectId(input.projectId ?? "project-a"),
  title: `Reply ${input.threadId}`,
  modelSelection,
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required",
  branch: null,
  worktreePath: null,
  ...(input.parentThreadId !== undefined
    ? { parentThreadId: input.parentThreadId === null ? null : asThreadId(input.parentThreadId) }
    : {}),
  ...(input.anchorTurnId !== undefined
    ? { anchorTurnId: input.anchorTurnId === null ? null : asTurnId(input.anchorTurnId) }
    : {}),
  createdAt: now,
});

const applyDecided = (
  readModel: OrchestrationReadModel,
  decided:
    | Omit<OrchestrationEvent, "sequence">
    | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) =>
  Effect.gen(function* () {
    let next = readModel;
    let sequence = readModel.snapshotSequence;
    for (const event of Array.isArray(decided) ? decided : [decided]) {
      sequence += 1;
      next = yield* projectEvent(next, { ...event, sequence } as OrchestrationEvent);
    }
    return next;
  });

it.layer(NodeServices.layer)("decider reply threads", (it) => {
  it.effect("creates a reply thread anchored at a completed parent turn", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const decided = yield* decideOrchestrationCommand({
        command: replyThreadCreateCommand({
          commandId: "cmd-reply-create",
          threadId: "reply-1",
          parentThreadId: "parent-1",
          anchorTurnId: "turn-1",
        }),
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.created");
      expect(events[0]?.payload).toMatchObject({
        threadId: "reply-1",
        parentThreadId: "parent-1",
        anchorTurnId: "turn-1",
      });

      const next = yield* applyDecided(readModel, decided);
      const reply = next.threads.find((thread) => thread.id === "reply-1");
      expect(reply?.parentThreadId).toBe("parent-1");
      expect(reply?.anchorTurnId).toBe("turn-1");
    }),
  );

  it.effect("rejects a parent reference without an anchor turn", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: replyThreadCreateCommand({
            commandId: "cmd-reply-missing-anchor",
            threadId: "reply-1",
            parentThreadId: "parent-1",
          }),
          readModel,
        }),
      );
      expect(error.message).toContain("must be provided together");
    }),
  );

  it.effect("rejects an unknown parent thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: replyThreadCreateCommand({
            commandId: "cmd-reply-unknown-parent",
            threadId: "reply-1",
            parentThreadId: "parent-missing",
            anchorTurnId: "turn-1",
          }),
          readModel,
        }),
      );
      expect(error.message).toContain("does not exist");
    }),
  );

  it.effect("rejects an anchor turn the parent has not completed", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: replyThreadCreateCommand({
            commandId: "cmd-reply-bad-anchor",
            threadId: "reply-1",
            parentThreadId: "parent-1",
            anchorTurnId: "turn-unknown",
          }),
          readModel,
        }),
      );
      expect(error.message).toContain("not a completed turn");
    }),
  );

  it.effect("rejects a cross-project parent", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: replyThreadCreateCommand({
            commandId: "cmd-reply-cross-project",
            threadId: "reply-1",
            projectId: "project-b",
            parentThreadId: "parent-1",
            anchorTurnId: "turn-1",
          }),
          readModel,
        }),
      );
      expect(error.message).toContain("must match parent thread project");
    }),
  );

  it.effect("enforces one reply thread per anchor turn", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const withReply = yield* applyDecided(
        readModel,
        yield* decideOrchestrationCommand({
          command: replyThreadCreateCommand({
            commandId: "cmd-reply-create",
            threadId: "reply-1",
            parentThreadId: "parent-1",
            anchorTurnId: "turn-1",
          }),
          readModel,
        }),
      );
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: replyThreadCreateCommand({
            commandId: "cmd-reply-create-2",
            threadId: "reply-2",
            parentThreadId: "parent-1",
            anchorTurnId: "turn-1",
          }),
          readModel: withReply,
        }),
      );
      expect(error.message).toContain("already has a reply thread");
    }),
  );

  it.effect("frees the anchor when its reply thread is deleted", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const withReply = yield* applyDecided(
        readModel,
        yield* decideOrchestrationCommand({
          command: replyThreadCreateCommand({
            commandId: "cmd-reply-create",
            threadId: "reply-1",
            parentThreadId: "parent-1",
            anchorTurnId: "turn-1",
          }),
          readModel,
        }),
      );
      const afterDelete = yield* applyDecided(
        withReply,
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.delete",
            commandId: asCommandId("cmd-reply-delete"),
            threadId: asThreadId("reply-1"),
          },
          readModel: withReply,
        }),
      );
      const decided = yield* decideOrchestrationCommand({
        command: replyThreadCreateCommand({
          commandId: "cmd-reply-create-2",
          threadId: "reply-2",
          parentThreadId: "parent-1",
          anchorTurnId: "turn-1",
        }),
        readModel: afterDelete,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events[0]?.type).toBe("thread.created");
    }),
  );

  it.effect("rejects a reply thread whose parent is itself a reply thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      let withReply = yield* applyDecided(
        readModel,
        yield* decideOrchestrationCommand({
          command: replyThreadCreateCommand({
            commandId: "cmd-reply-create",
            threadId: "reply-1",
            parentThreadId: "parent-1",
            anchorTurnId: "turn-1",
          }),
          readModel,
        }),
      );
      // Give the reply thread a completed turn so only the depth rule can reject.
      withReply = yield* projectEvent(withReply, {
        sequence: withReply.snapshotSequence + 1,
        eventId: asEventId("evt-reply-1-turn-diff"),
        aggregateKind: "thread",
        aggregateId: asThreadId("reply-1"),
        type: "thread.turn-diff-completed",
        occurredAt: now,
        commandId: asCommandId("cmd-reply-1-turn-diff"),
        causationEventId: null,
        correlationId: asCommandId("cmd-reply-1-turn-diff"),
        metadata: {},
        payload: {
          threadId: asThreadId("reply-1"),
          turnId: asTurnId("reply-turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/reply-1/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: now,
        },
      });
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: replyThreadCreateCommand({
            commandId: "cmd-reply-nested",
            threadId: "reply-nested",
            parentThreadId: "reply-1",
            anchorTurnId: "reply-turn-1",
          }),
          readModel: withReply,
        }),
      );
      expect(error.message).toContain("cannot have reply threads of its own");
    }),
  );

  it.effect("cascades parent deletion to reply threads", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const withReply = yield* applyDecided(
        readModel,
        yield* decideOrchestrationCommand({
          command: replyThreadCreateCommand({
            commandId: "cmd-reply-create",
            threadId: "reply-1",
            parentThreadId: "parent-1",
            anchorTurnId: "turn-1",
          }),
          readModel,
        }),
      );
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: asCommandId("cmd-parent-delete"),
          threadId: asThreadId("parent-1"),
        },
        readModel: withReply,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => [event.type, event.aggregateId])).toEqual([
        ["thread.deleted", "reply-1"],
        ["thread.deleted", "parent-1"],
      ]);
    }),
  );

  it.effect("cascades a revert past the anchor into a reply thread delete", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const withReply = yield* applyDecided(
        readModel,
        yield* decideOrchestrationCommand({
          command: replyThreadCreateCommand({
            commandId: "cmd-reply-create",
            threadId: "reply-1",
            parentThreadId: "parent-1",
            anchorTurnId: "turn-1",
          }),
          readModel,
        }),
      );

      // Reverting to the anchor's turn count keeps the reply thread.
      const keepDecided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.revert.complete",
          commandId: asCommandId("cmd-revert-keep"),
          threadId: asThreadId("parent-1"),
          turnCount: 1,
          createdAt: now,
        },
        readModel: withReply,
      });
      const keepEvents = Array.isArray(keepDecided) ? keepDecided : [keepDecided];
      expect(keepEvents.map((event) => event.type)).toEqual(["thread.reverted"]);

      // Reverting past the anchor deletes the reply thread first.
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.revert.complete",
          commandId: asCommandId("cmd-revert-discard"),
          threadId: asThreadId("parent-1"),
          turnCount: 0,
          createdAt: now,
        },
        readModel: withReply,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => [event.type, event.aggregateId])).toEqual([
        ["thread.deleted", "reply-1"],
        ["thread.reverted", "parent-1"],
      ]);
    }),
  );

  it.effect("blocks a revert while any thread in the family runs a turn", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const withReply = yield* applyDecided(
        readModel,
        yield* decideOrchestrationCommand({
          command: replyThreadCreateCommand({
            commandId: "cmd-reply-create",
            threadId: "reply-1",
            parentThreadId: "parent-1",
            anchorTurnId: "turn-1",
          }),
          readModel,
        }),
      );
      // A running turn in the reply thread must block reverting the parent.
      const withRunningReply = {
        ...withReply,
        threads: withReply.threads.map((thread) =>
          thread.id === "reply-1"
            ? {
                ...thread,
                session: {
                  threadId: thread.id,
                  status: "running" as const,
                  providerName: "claudeAgent",
                  activeTurnId: null,
                  runtimeMode: "approval-required" as const,
                  lastError: null,
                  updatedAt: now,
                },
              }
            : thread,
        ),
      };
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.checkpoint.revert",
            commandId: asCommandId("cmd-parent-revert"),
            threadId: asThreadId("parent-1"),
            turnCount: 0,
            createdAt: now,
          },
          readModel: withRunningReply,
        }),
      );
      expect(error.message).toContain("has an active turn");
    }),
  );

  it.effect("cascades archive and unarchive through reply threads", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const withReply = yield* applyDecided(
        readModel,
        yield* decideOrchestrationCommand({
          command: replyThreadCreateCommand({
            commandId: "cmd-reply-create",
            threadId: "reply-1",
            parentThreadId: "parent-1",
            anchorTurnId: "turn-1",
          }),
          readModel,
        }),
      );

      const archiveDecided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-parent-archive"),
          threadId: asThreadId("parent-1"),
        },
        readModel: withReply,
      });
      const archiveEvents = Array.isArray(archiveDecided) ? archiveDecided : [archiveDecided];
      expect(archiveEvents.map((event) => [event.type, event.aggregateId])).toEqual([
        ["thread.archived", "reply-1"],
        ["thread.archived", "parent-1"],
      ]);

      const archived = yield* applyDecided(withReply, archiveDecided);
      const unarchiveDecided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unarchive",
          commandId: asCommandId("cmd-parent-unarchive"),
          threadId: asThreadId("parent-1"),
        },
        readModel: archived,
      });
      const unarchiveEvents = Array.isArray(unarchiveDecided)
        ? unarchiveDecided
        : [unarchiveDecided];
      expect(unarchiveEvents.map((event) => [event.type, event.aggregateId])).toEqual([
        ["thread.unarchived", "reply-1"],
        ["thread.unarchived", "parent-1"],
      ]);
    }),
  );
});
