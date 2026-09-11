import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "message_count")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN message_count INTEGER
    `;
    yield* sql`
      UPDATE projection_threads
      SET message_count = (
        SELECT COUNT(*)
        FROM projection_thread_messages
        WHERE projection_thread_messages.thread_id = projection_threads.thread_id
      )
    `;
  }
});
