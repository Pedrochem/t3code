/**
 * The reply-thread right panel surface: the reply thread's own ChatView,
 * embedded so the parent keeps its title bar, right panel, and shortcuts.
 * The thread is forked from its anchor run before the surface gets an id.
 */
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";

import ChatView from "./ChatView";

export default function ReplyThreadPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string | null;
}) {
  if (props.threadId === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        Starting reply thread…
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <ChatView
        key={props.threadId}
        environmentId={props.environmentId}
        threadId={ThreadId.make(props.threadId)}
        routeKind="server"
        embedded
        reserveTitleBarControlInset={false}
      />
    </div>
  );
}
