import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Replaces message_count: the reply thread chip counts interactions (one user
// to assistant exchange), not raw messages, so the count matches what a
// reader perceives as one reply.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (columns.some((column) => column.name === "message_count")) {
    yield* sql`
      ALTER TABLE projection_threads
      DROP COLUMN message_count
    `;
  }

  if (!columns.some((column) => column.name === "interaction_count")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN interaction_count INTEGER
    `;
    yield* sql`
      UPDATE projection_threads
      SET interaction_count = (
        SELECT COUNT(*)
        FROM projection_thread_messages
        WHERE projection_thread_messages.thread_id = projection_threads.thread_id
          AND projection_thread_messages.role = 'user'
      )
    `;
  }
});
