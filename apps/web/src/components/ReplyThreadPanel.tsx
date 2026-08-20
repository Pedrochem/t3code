/**
 * ReplyThreadPanel — the Slack style side conversation beside a parent thread.
 *
 * Renders one reply thread (or a draft for a fresh anchor) inside the right
 * panel's singleton "reply-thread" surface. The thread is created lazily on
 * first send through the turn-start bootstrap, which forks the parent's
 * provider session at the anchor turn server side. Model and modes are locked
 * to the parent, so the composer here is deliberately minimal: text, send,
 * stop, and approval responses.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderApprovalDecision,
  ApprovalRequestId,
  ThreadId,
  TimestampFormat,
  TurnId,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { ArrowUp, MessagesSquare, Square } from "lucide-react";
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type { EnvironmentThread } from "@t3tools/client-runtime/state/models";
import { newMessageId, newThreadId, cn } from "~/lib/utils";
import {
  derivePendingApprovals,
  deriveTimelineEntries,
  deriveTurnPlans,
  deriveWorkLogEntries,
} from "~/session-logic";
import {
  useThread,
  useThreadActivities,
  useThreadMessages,
  useThreadProposedPlans,
} from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { ComposerPendingApprovalActions } from "./chat/ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./chat/ComposerPendingApprovalPanel";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { Button } from "./ui/button";

const EMPTY_MESSAGE_ID_MAP = new Map<never, never>();
const NOOP = () => {};

export interface ReplyThreadPanelTarget {
  readonly anchorTurnId: string;
  readonly threadId: string | null;
}

interface ReplyThreadPanelProps {
  environmentId: EnvironmentId;
  parentThread: EnvironmentThread;
  target: ReplyThreadPanelTarget;
  /** Swaps the surface to the created thread after the first send. */
  onThreadCreated: (threadId: ThreadId) => void;
  timestampFormat: TimestampFormat;
  resolvedTheme: "light" | "dark";
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
}

export const ReplyThreadPanel = memo(function ReplyThreadPanel({
  environmentId,
  parentThread,
  target,
  onThreadCreated,
  timestampFormat,
  resolvedTheme,
  markdownCwd,
  workspaceRoot,
}: ReplyThreadPanelProps) {
  const threadRef = useMemo(
    () =>
      target.threadId === null ? null : scopeThreadRef(environmentId, target.threadId as ThreadId),
    [environmentId, target.threadId],
  );
  const thread = useThread(threadRef, { waitForShell: true });
  const messages = useThreadMessages(threadRef);
  const activities = useThreadActivities(threadRef);
  const proposedPlans = useThreadProposedPlans(threadRef);

  const listRef = useRef<LegendListRef | null>(null);
  const [draftText, setDraftText] = useState("");
  const [isSendBusy, setIsSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const respondToApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });

  const turnPlans = useMemo(() => deriveTurnPlans(activities), [activities]);
  const workLogEntries = useMemo(() => deriveWorkLogEntries(activities), [activities]);
  const timelineEntries = useMemo(
    () => deriveTimelineEntries(messages, proposedPlans, workLogEntries, turnPlans),
    [messages, proposedPlans, turnPlans, workLogEntries],
  );
  const pendingApprovals = useMemo(() => derivePendingApprovals(activities), [activities]);
  const activePendingApproval = pendingApprovals[0] ?? null;
  const [respondingApprovalIds, setRespondingApprovalIds] = useState<
    ReadonlyArray<ApprovalRequestId>
  >([]);

  const sessionStatus = thread?.session?.status ?? null;
  const isRunning = sessionStatus === "running" || sessionStatus === "starting";
  const isWorking = isRunning || isSendBusy;
  const routeThreadKey = threadRef
    ? scopedThreadKey(threadRef)
    : `${scopedThreadKey(scopeThreadRef(environmentId, parentThread.id))}:reply-draft`;

  const handleSend = useCallback(async () => {
    const text = draftText.trim();
    if (text.length === 0 || isSendBusy) return;
    setSendError(null);
    setIsSendBusy(true);
    const createdAt = new Date().toISOString();
    // Locked to the parent: the reply thread inherits model and modes and the
    // composer offers no way to change them (docs/internals/reply-threads.md).
    const runtimeMode = parentThread.runtimeMode;
    const interactionMode = parentThread.interactionMode;
    const modelSelection = thread?.modelSelection ?? parentThread.modelSelection;
    const targetThreadId = (target.threadId as ThreadId | null) ?? newThreadId();
    const result = await startThreadTurn({
      environmentId,
      input: {
        threadId: targetThreadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text,
          attachments: [],
        },
        modelSelection,
        runtimeMode,
        interactionMode,
        ...(target.threadId === null
          ? {
              bootstrap: {
                createThread: {
                  projectId: parentThread.projectId,
                  title: `Reply · ${parentThread.title}`.slice(0, 120),
                  modelSelection,
                  runtimeMode,
                  interactionMode,
                  branch: parentThread.branch,
                  worktreePath: parentThread.worktreePath,
                  parentThreadId: parentThread.id,
                  anchorTurnId: target.anchorTurnId as TurnId,
                  createdAt,
                },
              },
            }
          : {}),
        createdAt,
      },
    });
    setIsSendBusy(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setSendError(
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Could not send the reply. Try again.",
      );
      return;
    }
    setDraftText("");
    if (target.threadId === null) {
      onThreadCreated(targetThreadId);
    }
  }, [
    draftText,
    environmentId,
    isSendBusy,
    onThreadCreated,
    parentThread,
    startThreadTurn,
    target.anchorTurnId,
    target.threadId,
    thread?.modelSelection,
  ]);

  const handleInterrupt = useCallback(() => {
    if (target.threadId === null) return;
    void interruptThreadTurn({
      environmentId,
      input: { threadId: target.threadId as ThreadId, createdAt: new Date().toISOString() },
    });
  }, [environmentId, interruptThreadTurn, target.threadId]);

  const handleRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (target.threadId === null) return;
      setRespondingApprovalIds((existing) => [...existing, requestId]);
      await respondToApproval({
        environmentId,
        input: {
          threadId: target.threadId as ThreadId,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        },
      });
      setRespondingApprovalIds((existing) => existing.filter((id) => id !== requestId));
    },
    [environmentId, respondToApproval, target.threadId],
  );

  const handleComposerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <MessagesSquare className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">Reply thread</p>
          <p className="truncate text-xs text-muted-foreground">{parentThread.title}</p>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {timelineEntries.length === 0 && !isWorking ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <p className="text-placeholder text-sm">
              Start a side conversation from this point. The agent continues with the conversation
              context up to here, and nothing said in this reply thread reaches the main thread.
            </p>
          </div>
        ) : (
          <MessagesTimeline
            isWorking={isWorking}
            activeTurnStartedAt={thread?.latestTurn?.startedAt ?? null}
            listRef={listRef}
            timelineEntries={timelineEntries}
            latestTurn={thread?.latestTurn ?? null}
            runningTurnId={
              thread?.session?.status === "running" ? thread.session.activeTurnId : null
            }
            turnDiffSummaryByAssistantMessageId={EMPTY_MESSAGE_ID_MAP}
            routeThreadKey={routeThreadKey}
            onOpenTurnDiff={NOOP}
            revertTurnCountByUserMessageId={EMPTY_MESSAGE_ID_MAP}
            onRevertUserMessage={NOOP}
            isRevertingCheckpoint={false}
            onImageExpand={NOOP}
            activeThreadEnvironmentId={environmentId}
            markdownCwd={markdownCwd}
            resolvedTheme={resolvedTheme}
            timestampFormat={timestampFormat}
            workspaceRoot={workspaceRoot}
            anchorMessageId={null}
            onAnchorReady={NOOP}
            contentInsetEndAdjustment={0}
            liveFollowEnabled
            onIsAtEndChange={NOOP}
            onManualNavigation={NOOP}
            hideEmptyPlaceholder
          />
        )}
      </div>

      <div className="border-t border-border/60 p-2">
        {activePendingApproval !== null && target.threadId !== null ? (
          <div className="mb-2 rounded-lg border border-border/70 p-2">
            <ComposerPendingApprovalPanel
              approval={activePendingApproval}
              pendingCount={pendingApprovals.length}
            />
            <ComposerPendingApprovalActions
              requestId={activePendingApproval.requestId}
              isResponding={respondingApprovalIds.includes(activePendingApproval.requestId)}
              onRespondToApproval={handleRespondToApproval}
            />
          </div>
        ) : null}
        {sendError !== null ? (
          <p className="mb-1.5 px-1 text-xs text-destructive">{sendError}</p>
        ) : null}
        <div className="flex items-end gap-1.5">
          <textarea
            value={draftText}
            onChange={(event) => setDraftText(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="Reply…"
            rows={2}
            className={cn(
              "min-h-[3.25rem] w-full resize-none rounded-xl border border-border/70 bg-background px-3 py-2 text-sm",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
            )}
          />
          {isRunning ? (
            <Button
              type="button"
              size="icon"
              variant="outline"
              onClick={handleInterrupt}
              aria-label="Stop the reply thread's turn"
            >
              <Square className="size-3.5" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              disabled={draftText.trim().length === 0 || isSendBusy}
              onClick={() => void handleSend()}
              aria-label="Send reply"
            >
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
});
