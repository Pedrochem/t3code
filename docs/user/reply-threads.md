# Reply threads

Reply threads let you branch a side conversation off any completed turn, the way you would reply in a thread in Slack. The agent in a reply thread continues with the conversation context up to that turn, and nothing you discuss there enters the main thread's context.

Reply threads are currently available on Claude threads.

## Start a reply thread

Hover over a message and choose the reply icon, or use the same icon in the message's action row. A panel opens beside the conversation. The composer works exactly like the main thread's, including attachments and the context meter, minus the controls a reply thread locks. The reply thread is only created when you send the first message, so closing the panel without sending leaves nothing behind.

Each turn can have one reply thread. Once one exists, the reply icon in the message's action row becomes a reply count (one of your messages plus the agent's answer counts as one reply). Click it to reopen the conversation.

## What a reply thread inherits

A reply thread uses the same model, permission mode, and interaction mode as its main thread, and they stay locked to it. It also works in the same folder and branch as the main thread: file changes made in a reply thread are real changes in the same workspace, and the main thread's diff view will include them.

## Where reply threads live

Reply threads do not appear in the sidebar, the command palette, or search. The chip on their original message is the way back in. Archiving or deleting the main thread archives or deletes its reply threads with it, and reverting the main thread past a reply thread's starting point deletes that reply thread.
