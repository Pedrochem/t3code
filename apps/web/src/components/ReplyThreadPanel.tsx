/**
 * ReplyThreadPanel — the Slack style side conversation beside a parent thread.
 *
 * Renders one reply thread (or a draft for a fresh anchor) inside the right
 * panel's singleton "reply-thread" surface: the anchor turn's assistant
 * message pinned on top, the reply conversation below, and the real
 * ChatComposer in its "reply" variant, so typing feels identical to the main
 * thread while the locked controls (model, modes, extras) stay hidden. The
 * thread is created lazily on first send through the turn-start bootstrap,
 * which forks the parent's provider session at the anchor turn server side.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ApprovalRequestId,
  EnvironmentId,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  ServerProvider,
  ThreadId,
  TimestampFormat,
  TurnId,
} from "@t3tools/contracts";
import { applyClaudePromptEffortPrefix, resolvePromptInjectedEffort } from "@t3tools/shared/model";
import type { LegendListRef } from "@legendapp/list/react";
import { MessagesSquare } from "lucide-react";
import { memo, useCallback, useMemo, useRef, useState } from "react";

import type { EnvironmentThread } from "@t3tools/client-runtime/state/models";
import type { ComposerImageAttachment } from "~/composerDraftStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import type { ElementContextDraft } from "~/lib/elementContext";
import type { TerminalContextDraft } from "~/lib/terminalContext";
import { newDraftId, newMessageId, newThreadId } from "~/lib/utils";
import { getProviderInstanceEntry } from "~/providerInstances";
import { getProviderModelCapabilities } from "~/providerModels";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "~/pendingUserInput";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveTimelineEntries,
  deriveTurnPlans,
  deriveWorkLogEntries,
} from "~/session-logic";
import {
  useServerConfigs,
  useThread,
  useThreadActivities,
  useThreadMessages,
  useThreadProposedPlans,
} from "~/state/entities";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import ChatMarkdown from "./ChatMarkdown";
import { ChatComposer, type ChatComposerHandle } from "./chat/ChatComposer";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { readFileAsDataUrl } from "./ChatView.logic";

const EMPTY_MESSAGE_ID_MAP = new Map<never, never>();
const NOOP = () => {};

// Mirrors ChatView's image-only bootstrap prompt so an attachment-only reply
// behaves the same as one in the main composer.
const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";

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
  /**
   * Measured height of the main thread's composer overlay (padding, shell,
   * and any attached banner). The panel reserves the same height with the
   * composer anchored on top, so both composers top-align across the divider.
   */
  mainComposerHeight: number;
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
  mainComposerHeight,
}: ReplyThreadPanelProps) {
  const parentRef = useMemo(
    () => scopeThreadRef(environmentId, parentThread.id),
    [environmentId, parentThread.id],
  );
  const threadRef = useMemo(
    () =>
      target.threadId === null ? null : scopeThreadRef(environmentId, target.threadId as ThreadId),
    [environmentId, target.threadId],
  );
  const thread = useThread(threadRef, { waitForShell: true });
  const messages = useThreadMessages(threadRef);
  const activities = useThreadActivities(threadRef);
  const proposedPlans = useThreadProposedPlans(threadRef);

  const settings = useEnvironmentSettings(environmentId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const serverConfigs = useServerConfigs();
  const providerStatuses = useMemo(
    () => serverConfigs.get(environmentId)?.providers ?? [],
    [environmentId, serverConfigs],
  );

  const listRef = useRef<LegendListRef | null>(null);
  const [isSendBusy, setIsSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Reply drafts before the thread exists key their composer state off a
  // stable draft id; after creation the child thread ref takes over.
  const [replyDraftId] = useState(() => newDraftId());
  const composerDraftTarget = threadRef ?? replyDraftId;

  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const composerElementContextsRef = useRef<ElementContextDraft[]>([]);
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const sendInFlightRef = useRef(false);

  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const respondToApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToUserInput = useAtomCommand(threadEnvironment.respondToUserInput, {
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
  const pendingUserInputs = useMemo(() => derivePendingUserInputs(activities), [activities]);
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const [respondingApprovalIds, setRespondingApprovalIds] = useState<
    ReadonlyArray<ApprovalRequestId>
  >([]);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});

  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ?? {})
        : {},
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ReadonlyArray<ApprovalRequestId>
  >([]);
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;

  const phase = derivePhase(thread?.session ?? null);
  const isRunning = phase === "running";
  const isWorking = isRunning || phase === "connecting" || isSendBusy;
  const routeThreadKey = threadRef
    ? scopedThreadKey(threadRef)
    : `${scopedThreadKey(parentRef)}:reply-draft`;

  // Locked to the parent: reply threads inherit model and modes
  // (docs/internals/reply-threads.md).
  const runtimeMode = parentThread.runtimeMode;
  const interactionMode = parentThread.interactionMode;
  const lockedModelSelection = thread?.modelSelection ?? parentThread.modelSelection;
  const lockedProvider =
    getProviderInstanceEntry(providerStatuses as ServerProvider[], lockedModelSelection.instanceId)
      ?.driverKind ?? null;

  // Slack pins the message you replied to on top of the thread panel.
  const anchorMessage = useMemo(() => {
    let anchor = null;
    for (const message of parentThread.messages) {
      if (message.role === "assistant" && message.turnId === target.anchorTurnId) {
        anchor = message;
      }
    }
    return anchor;
  }, [parentThread.messages, target.anchorTurnId]);

  const handleSend = useCallback(async () => {
    if (sendInFlightRef.current || isSendBusy) return;
    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable) return;
    const prompt = sendCtx.prompt.trim();
    if (prompt.length === 0 && sendCtx.images.length === 0) return;

    const caps = getProviderModelCapabilities(
      sendCtx.selectedProviderModels,
      sendCtx.selectedModel,
      sendCtx.selectedProvider,
    );
    const outgoingText = applyClaudePromptEffortPrefix(
      prompt || IMAGE_ONLY_BOOTSTRAP_PROMPT,
      resolvePromptInjectedEffort(caps, sendCtx.selectedPromptEffort),
    );
    if (composerRef.current?.validateProviderInput(outgoingText) === false) {
      return;
    }

    setSendError(null);
    sendInFlightRef.current = true;
    setIsSendBusy(true);
    const createdAt = new Date().toISOString();
    const attachments = await Promise.all(
      sendCtx.images.map(async (image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file),
      })),
    );
    const targetThreadId = (target.threadId as ThreadId | null) ?? newThreadId();
    const result = await startThreadTurn({
      environmentId,
      input: {
        threadId: targetThreadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: outgoingText,
          attachments,
        },
        modelSelection: lockedModelSelection,
        runtimeMode,
        interactionMode,
        ...(target.threadId === null
          ? {
              bootstrap: {
                createThread: {
                  projectId: parentThread.projectId,
                  title: `Reply · ${parentThread.title}`.slice(0, 120),
                  modelSelection: lockedModelSelection,
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
    sendInFlightRef.current = false;
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
    promptRef.current = "";
    clearComposerDraftContent(composerDraftTarget);
    composerRef.current?.resetCursorState();
    if (target.threadId === null) {
      onThreadCreated(targetThreadId);
    }
  }, [
    clearComposerDraftContent,
    composerDraftTarget,
    environmentId,
    interactionMode,
    isSendBusy,
    lockedModelSelection,
    onThreadCreated,
    parentThread,
    runtimeMode,
    startThreadTurn,
    target.anchorTurnId,
    target.threadId,
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
      const result = await respondToApproval({
        environmentId,
        input: {
          threadId: target.threadId as ThreadId,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        },
      });
      setRespondingApprovalIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    },
    [environmentId, respondToApproval, target.threadId],
  );

  const handleRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: ProviderUserInputAnswers) => {
      if (target.threadId === null) return;
      setRespondingUserInputRequestIds((existing) => [...existing, requestId]);
      await respondToUserInput({
        environmentId,
        input: {
          threadId: target.threadId as ThreadId,
          requestId,
          answers,
          createdAt: new Date().toISOString(),
        },
      });
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [environmentId, respondToUserInput, target.threadId],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) return;
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) return;
      setPendingUserInputAnswersByRequestId((existing) => {
        const question =
          (activePendingProgress?.activeQuestion?.id === questionId
            ? activePendingProgress.activeQuestion
            : undefined) ??
          activePendingUserInput.questions.find((entry) => entry.id === questionId);
        if (!question) return existing;
        return {
          ...existing,
          [activePendingUserInput.requestId]: {
            ...existing[activePendingUserInput.requestId],
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[activePendingUserInput.requestId]?.[questionId],
              optionLabel,
            ),
          },
        };
      });
      promptRef.current = "";
      composerRef.current?.resetCursorState({ cursor: 0 });
    },
    [activePendingProgress?.activeQuestion, activePendingUserInput],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      _cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInput) return;
      promptRef.current = value;
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingUserInput.requestId]?.[questionId],
            value,
          ),
        },
      }));
      const snapshot = composerRef.current?.readSnapshot();
      if (
        snapshot?.value !== value ||
        snapshot.cursor !== nextCursor ||
        snapshot.expandedCursor !== expandedCursor
      ) {
        composerRef.current?.focusAt(nextCursor);
      }
    },
    [activePendingUserInput],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || !activePendingProgress) return;
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void handleRespondToUserInput(
          activePendingUserInput.requestId,
          activePendingResolvedAnswers,
        );
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    handleRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) return;
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  const focusComposer = useCallback(() => {
    composerRef.current?.focusAtEnd();
  }, []);
  const scheduleComposerFocus = useCallback(() => {
    requestAnimationFrame(() => composerRef.current?.focusAtEnd());
  }, []);
  const setThreadError = useCallback((_threadId: ThreadId | null, error: string | null) => {
    setSendError(error);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <MessagesSquare className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">Reply thread</p>
          <p className="truncate text-xs text-muted-foreground">{parentThread.title}</p>
        </div>
      </div>

      {anchorMessage ? (
        <div className="shrink-0 border-b border-border/60">
          <div className="max-h-56 overflow-y-auto px-4 py-3">
            <ChatMarkdown
              text={anchorMessage.text}
              cwd={markdownCwd}
              threadRef={parentRef}
              isStreaming={false}
              lineBreaks={false}
            />
          </div>
          <p className="border-t border-border/40 px-4 py-1.5 text-xs text-muted-foreground">
            {timelineEntries.length === 0 ? "Reply below to start the thread" : "Replies"}
          </p>
        </div>
      ) : null}

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

      <div
        className="flex shrink-0 flex-col px-3 pt-1.5 sm:px-5 sm:pt-2"
        style={mainComposerHeight > 0 ? { minHeight: mainComposerHeight } : undefined}
      >
        {sendError !== null ? (
          <p className="px-2 pb-1 text-xs text-destructive">{sendError}</p>
        ) : null}
        {/* Same visual shell that wraps the main thread's composer. */}
        <div className="chat-composer-glass-shell relative mx-auto w-full max-w-3xl">
          <div className="chat-composer-glass-host relative z-10 w-full rounded-[22px]">
            <ChatComposer
              variant="reply"
              composerDraftTarget={composerDraftTarget}
              environmentId={environmentId}
              routeKind="server"
              routeThreadRef={threadRef ?? parentRef}
              draftId={null}
              activeThreadId={(target.threadId as ThreadId | null) ?? null}
              activeThreadEnvironmentId={environmentId}
              activeThread={thread ?? undefined}
              isServerThread={threadRef !== null}
              isLocalDraftThread={threadRef === null}
              forceExpandedOnMobile={false}
              projectSelectionRequired={false}
              phase={phase}
              isConnecting={phase === "connecting"}
              isSendBusy={isSendBusy}
              sendDisabledReason={null}
              isPreparingWorktree={false}
              externalDrawerAttached={false}
              environmentUnavailable={null}
              activePendingApproval={activePendingApproval}
              pendingApprovals={pendingApprovals}
              pendingUserInputs={pendingUserInputs}
              activePendingProgress={activePendingProgress}
              activePendingResolvedAnswers={activePendingResolvedAnswers}
              activePendingIsResponding={activePendingIsResponding}
              activePendingDraftAnswers={activePendingDraftAnswers}
              activePendingQuestionIndex={activePendingQuestionIndex}
              respondingRequestIds={[...respondingApprovalIds]}
              showPlanFollowUpPrompt={false}
              activeProposedPlan={null}
              activeTasksProgress={null}
              activeTaskSteps={null}
              runtimeMode={runtimeMode}
              interactionMode={interactionMode}
              lockedProvider={lockedProvider}
              providerStatuses={providerStatuses as ServerProvider[]}
              activeProjectDefaultModelSelection={null}
              activeThreadModelSelection={lockedModelSelection}
              activeThreadActivities={activities}
              resolvedTheme={resolvedTheme}
              settings={settings}
              keybindings={keybindings}
              terminalOpen={false}
              gitCwd={markdownCwd ?? null}
              promptRef={promptRef}
              composerImagesRef={composerImagesRef}
              composerTerminalContextsRef={composerTerminalContextsRef}
              composerElementContextsRef={composerElementContextsRef}
              composerRef={composerRef}
              onSend={(event) => {
                event?.preventDefault();
                void handleSend();
              }}
              onInterrupt={handleInterrupt}
              onImplementPlanInNewThread={NOOP}
              onRespondToApproval={handleRespondToApproval}
              onSelectActivePendingUserInputOption={onSelectActivePendingUserInputOption}
              onAdvanceActivePendingUserInput={onAdvanceActivePendingUserInput}
              onPreviousActivePendingUserInputQuestion={onPreviousActivePendingUserInputQuestion}
              onChangeActivePendingUserInputCustomAnswer={
                onChangeActivePendingUserInputCustomAnswer
              }
              onProviderModelSelect={NOOP}
              getModelDisabledReason={() => null}
              toggleInteractionMode={NOOP}
              handleRuntimeModeChange={NOOP}
              handleInteractionModeChange={NOOP}
              focusComposer={focusComposer}
              scheduleComposerFocus={scheduleComposerFocus}
              setThreadError={setThreadError}
              onExpandImage={NOOP}
            />
          </div>
        </div>
      </div>
    </div>
  );
});
