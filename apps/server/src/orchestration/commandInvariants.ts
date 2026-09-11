import type {
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireActiveProjectWorkspaceRootAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly workspaceRoot: string;
  readonly exceptProjectId?: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const normalizedWorkspaceRoot = normalizeProjectPathForComparison(input.workspaceRoot);
  const existingProject = input.readModel.projects.find(
    (project) =>
      project.deletedAt === null &&
      normalizeProjectPathForComparison(project.workspaceRoot) === normalizedWorkspaceRoot &&
      project.id !== input.exceptProjectId,
  );
  if (existingProject === undefined) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Active project '${existingProject.id}' already exists for workspace root '${normalizedWorkspaceRoot}'.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt !== null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt === null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  // Thread deletion is a soft delete and a draft keeps its client-minted id
  // across retries, so only a live row blocks creation. Projectors reset the
  // thread's rows when the id is created again.
  const existing = findThreadById(input.readModel, input.threadId);
  if (existing === undefined || existing.deletedAt !== null) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function listActiveReplyThreads(
  readModel: OrchestrationReadModel,
  parentThreadId: ThreadId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter(
    (thread) => thread.parentThreadId === parentThreadId && thread.deletedAt === null,
  );
}

/**
 * Validates the reply-thread half of thread.create: the parent must be a live
 * top-level thread in the same project, the anchor turn must have completed,
 * and the anchor must be free (one reply thread per anchor turn).
 */
export function requireReplyThreadCreatable(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
  readonly parentThreadId: ThreadId;
  readonly anchorTurnId: TurnId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread({
    readModel: input.readModel,
    command: input.command,
    threadId: input.parentThreadId,
  }).pipe(
    Effect.flatMap((parent) => {
      if (parent.deletedAt !== null) {
        return Effect.fail(
          invariantError(
            input.command.type,
            `Parent thread '${input.parentThreadId}' is deleted and cannot anchor a reply thread.`,
          ),
        );
      }
      if (parent.parentThreadId != null) {
        return Effect.fail(
          invariantError(
            input.command.type,
            `Thread '${input.parentThreadId}' is a reply thread and cannot have reply threads of its own.`,
          ),
        );
      }
      if (parent.projectId !== input.projectId) {
        return Effect.fail(
          invariantError(
            input.command.type,
            `Reply thread project '${input.projectId}' must match parent thread project '${parent.projectId}'.`,
          ),
        );
      }
      // The anchor must be a turn the read model knows about and must not be
      // the still running latest turn. Older turns are complete by
      // construction (turns are sequential), and checkpoints alone cannot be
      // the evidence: projects without git never record checkpoint summaries.
      const anchorKnown =
        parent.checkpoints.some((checkpoint) => checkpoint.turnId === input.anchorTurnId) ||
        parent.latestTurn?.turnId === input.anchorTurnId ||
        parent.messages.some((message) => message.turnId === input.anchorTurnId);
      const anchorIsUnfinishedLatestTurn =
        parent.latestTurn?.turnId === input.anchorTurnId && parent.latestTurn.completedAt === null;
      if (!anchorKnown || anchorIsUnfinishedLatestTurn) {
        return Effect.fail(
          invariantError(
            input.command.type,
            `Anchor turn '${input.anchorTurnId}' is not a completed turn of thread '${input.parentThreadId}'.`,
          ),
        );
      }
      const anchorTaken = input.readModel.threads.some(
        (thread) =>
          thread.parentThreadId === input.parentThreadId &&
          thread.anchorTurnId === input.anchorTurnId &&
          thread.deletedAt === null,
      );
      if (anchorTaken) {
        return Effect.fail(
          invariantError(
            input.command.type,
            `Anchor turn '${input.anchorTurnId}' already has a reply thread.`,
          ),
        );
      }
      return Effect.succeed(parent);
    }),
  );
}
