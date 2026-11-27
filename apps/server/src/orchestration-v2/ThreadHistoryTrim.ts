import {
  type NodeId,
  type OrchestrationV2DomainEvent,
  type RunId,
  type ThreadHistoryTrimReport,
  ThreadHistoryTrimDisabledError,
  type ThreadHistoryTrimStatus,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as ServerSettingsModule from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class ThreadHistoryTrimError extends Schema.TaggedError<ThreadHistoryTrimError>()(
  "ThreadHistoryTrimError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class ThreadHistoryTrim extends Context.Service<
  ThreadHistoryTrim,
  {
    /** What the next pass would remove under the current setting. Changes nothing. */
    readonly preview: Effect.Effect<ThreadHistoryTrimReport, ThreadHistoryTrimError>;
    /**
     * Queues a pass and returns at once. The counts are zero: estimating again would scan every
     * candidate once more, and a client that wants them already has them from `preview`.
     * Fails when the setting is off, since the pass would return without removing anything.
     */
    readonly trimNow: Effect.Effect<
      ThreadHistoryTrimReport,
      ThreadHistoryTrimError | ThreadHistoryTrimDisabledError
    >;
    /** When the last pass finished and when the next one is due. */
    readonly status: Stream.Stream<ThreadHistoryTrimStatus>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadHistoryTrim") {}

const DAY_MS = 24 * 60 * 60 * 1_000;
const PASS_INTERVAL_MS = 30 * DAY_MS;
const LAST_PASS = "thread-history-trim-last-pass";
const DELETE_PAGE_SIZE = 200;
const NOTICE_SIGNAL = "history-trim";
// Work the reader skips: `file_change` stays because it is small and names what a run touched,
// and so does output the timeline always shows inline (`inline_work_output`).
const TRIMMED_ITEM_TYPES = [
  "command_execution",
  "dynamic_tool",
  "reasoning",
  "file_search",
  "web_search",
] as const;
// A failed run's retry reads its "Preparing workspace" row, so that row is never removed.
const keepsPreparationRow = (alias: string) =>
  `NOT (${alias}type = 'command_execution' AND json_extract(${alias}payload_json, '$.input') = 'Preparing workspace')`;
const TRIMMED_NODE_KINDS = ["tool_call", "reasoning"] as const;
const LIVE_ITEM_STATUSES = ["pending", "running", "waiting"] as const;
const LIVE_NODE_STATUSES = ["pending", "starting", "running", "waiting"] as const;
const LIVE_RUN_STATUSES = ["queued", "preparing", "starting", "running", "waiting"] as const;

type Candidate = {
  readonly threadId: ThreadId;
  /** The newest run the timeline still shows; null when every run was rolled back. */
  readonly noticeRunId: RunId | null;
  readonly runOrdinal: number;
  readonly updatedAt: string;
};
// "enabled" is a pass the setting asked for by turning trimming on or shortening the window, so
// the 30-day wait since the last pass does not apply; it still keeps to the background duty.
type Mode = "background" | "enabled" | "manual";

const sumBytes = (rows: ReadonlyArray<{ readonly bytes: number }>) =>
  rows.reduce((total, row) => total + row.bytes, 0);

// Space a row gives back: its payload plus each copy of its ids in the row, its indexes and its position row.
const ITEM_BYTES = `(octet_length(payload_json) + 5 * length(turn_item_id) + 8 * length(thread_id)
  + 3 * COALESCE(length(run_id), 0) + 2 * COALESCE(length(node_id), 0)
  + 2 * COALESCE(length(provider_turn_id), 0) + COALESCE(length(provider_thread_id), 0)
  + COALESCE(length(parent_item_id), 0))`;
const nodeBytes = (alias: string) =>
  `(octet_length(${alias}payload_json) + 2 * length(${alias}node_id) + 3 * length(${alias}thread_id)
  + length(${alias}root_node_id) + 2 * COALESCE(length(${alias}run_id), 0)
  + 2 * COALESCE(length(${alias}parent_node_id), 0) + 2 * COALESCE(length(${alias}provider_turn_id), 0)
  + COALESCE(length(${alias}provider_thread_id), 0))`;

// The English fallback for clients that read `message`; the clients that know `historyTrim` word it themselves.
function trimNoticeMessage(afterDays: number): string {
  return `Tool output and reasoning above this point were removed to save space after ${afterDays} ${afterDays === 1 ? "day" : "days"} without use. Messages, plans and file changes are kept.`;
}

/** Ids no kept row points at, children first, so a pass that stops early never orphans a row. */
function unreferenced<Row extends { readonly id: string; readonly parent: string | null }>(
  rows: ReadonlyArray<Row>,
  removable: (row: Row) => boolean,
  referenced: Iterable<string>,
): ReadonlyArray<Row> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const kept = new Set<string>();
  const keep = (id: string | null) => {
    for (let current = id; current !== null && !kept.has(current);) {
      kept.add(current);
      current = byId.get(current)?.parent ?? null;
    }
  };
  for (const id of referenced) keep(id);
  for (const row of rows) if (!removable(row)) keep(row.id);
  const depth = (row: Row) => {
    let count = 0;
    for (let current = row.parent; current !== null; current = byId.get(current)?.parent ?? null)
      count += 1;
    return count;
  };
  return rows
    .filter((row) => !kept.has(row.id))
    .map((row) => ({ row, depth: depth(row) }))
    .toSorted((left, right) => right.depth - left.depth)
    .map(({ row }) => row);
}

/** Drops each id that a row outside `removable` still hangs off, until none does. */
function withoutParentsOfKept(
  removable: ReadonlyArray<string>,
  children: ReadonlyArray<{ readonly id: string; readonly parent: string }>,
  blocked: Iterable<string>,
): ReadonlySet<string> {
  const removed = new Set(removable);
  for (const id of blocked) removed.delete(id);
  for (let changed = true; changed;) {
    changed = false;
    for (const child of children) {
      if (removed.has(child.parent) && !removed.has(child.id)) {
        removed.delete(child.parent);
        changed = true;
      }
    }
  }
  return removed;
}

/** Run-forks by the thread they hang off, as the pass read them. */
interface ForkTable {
  readonly children: ReadonlyMap<
    ThreadId,
    ReadonlyArray<{ readonly id: ThreadId; readonly deleted: boolean }>
  >;
  /** The same rows as `[id, parent, deleted]` triples, for a query to join. */
  readonly json: string;
  /** The thread table's newest rowid when this was read; a larger one means a thread was made since. */
  readonly maxRowid: number;
}

function makeForkTable(
  rows: ReadonlyArray<{
    readonly id: ThreadId;
    readonly parent: ThreadId | null;
    readonly deleted: number;
  }>,
  maxRowid: number,
): ForkTable {
  const children = new Map<ThreadId, Array<{ id: ThreadId; deleted: boolean }>>();
  const triples: Array<readonly [ThreadId, ThreadId, number]> = [];
  for (const row of rows) {
    if (row.parent === null) continue;
    const siblings = children.get(row.parent) ?? [];
    siblings.push({ id: row.id, deleted: row.deleted !== 0 });
    children.set(row.parent, siblings);
    triples.push([row.id, row.parent, row.deleted !== 0 ? 1 : 0]);
  }
  return { children, json: JSON.stringify(triples), maxRowid };
}

/** Live forks that show this thread's rows, at any depth; a deleted fork still passes them on. */
function liveForksOf(table: ForkTable, threadId: ThreadId): ReadonlyArray<ThreadId> {
  const seen = new Set<ThreadId>([threadId]);
  const live: Array<ThreadId> = [];
  const pending = [threadId];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const fork of table.children.get(next) ?? []) {
      if (seen.has(fork.id)) continue;
      seen.add(fork.id);
      pending.push(fork.id);
      if (!fork.deleted) live.push(fork.id);
    }
  }
  return live;
}

const DUTY_REST_FACTOR = 9;
const MAX_DUTY_REST_MS = 60_000;

// Rests nine times as long as the work since the last rest (a 10% duty), timed on the monotonic
// clock since the wall clock jumps. Capped so a long slice cannot hold the serial worker for hours.
export const makeDutyRest = Effect.gen(function* () {
  let sliceStarted = yield* Clock.monotonicTimeNanos;
  return Effect.gen(function* () {
    const elapsedMs = Number((yield* Clock.monotonicTimeNanos) - sliceStarted) / 1_000_000;
    if (elapsedMs <= 0) return;
    yield* Effect.sleep(Math.min(MAX_DUTY_REST_MS, elapsedMs * DUTY_REST_FACTOR));
    sliceStarted = yield* Clock.monotonicTimeNanos;
  });
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const settingsService = yield* ServerSettingsModule.ServerSettingsService;

  // Every run-fork in the thread table, read once per pass (no index on a fork's parent, so each
  // read is a full scan). Deleted forks stay in to pass the link on. A later fork waits a pass.
  // The max rowid stands in for "newest thread" (one b-tree seek; created_at has no index). Read
  // before the rows, so a thread made between the two reads counts as new, not as missed.
  const readMaxThreadRowid = sql<{ readonly maxRowid: number | null }>`
    SELECT MAX(rowid) AS "maxRowid" FROM orchestration_v2_projection_threads
  `.pipe(
    NodeSqliteClient.readOnly,
    Effect.map((rows) => rows[0]?.maxRowid ?? 0),
  );
  const readForkTable = Effect.fn("ThreadHistoryTrim.readForkTable")(function* () {
    const maxRowid = yield* readMaxThreadRowid;
    const rows = yield* sql<{
      readonly id: ThreadId;
      readonly parent: ThreadId | null;
      readonly deleted: number;
    }>`
      SELECT fork.thread_id AS id,
        json_extract(fork.payload_json, '$.forkedFrom.threadId') AS parent,
        fork.deleted_at IS NOT NULL AS deleted
      FROM orchestration_v2_projection_threads AS fork
      WHERE json_extract(fork.payload_json, '$.forkedFrom.type') = 'run'
        AND COALESCE(json_extract(fork.payload_json, '$.lineage.sideChat'), 0) = 0
    `.pipe(NodeSqliteClient.readOnly);
    return makeForkTable(rows, maxRowid);
  });

  // The forks of each thread at any depth, from the table read above. Handed to the query as JSON,
  // so the walk joins that small set and never touches the thread table.
  const forkLinks = (forks: ForkTable, threadId: ThreadId | undefined) => sql`
    fork_rows(thread_id, parent_id, deleted) AS MATERIALIZED (
      SELECT json_extract(entry.value, '$[0]'), json_extract(entry.value, '$[1]'),
        json_extract(entry.value, '$[2]')
      FROM json_each(${forks.json}) AS entry
    ),
    forks(root_id, thread_id, deleted) AS (
      SELECT fork.parent_id, fork.thread_id, fork.deleted
      FROM fork_rows AS fork
      ${
        threadId === undefined
          ? sql``
          : // Walk down from this thread and from the thread its subagent hangs off.
            sql`WHERE fork.parent_id IN (
        SELECT ${threadId}
        UNION
        SELECT json_extract(own.payload_json, '$.lineage.rootThreadId')
        FROM orchestration_v2_projection_threads AS own
        WHERE own.thread_id = ${threadId}
          AND json_extract(own.payload_json, '$.lineage.relationshipToParent') = 'subagent'
      )`
      }
      UNION
      SELECT forks.root_id, fork.thread_id, fork.deleted
      FROM fork_rows AS fork
      JOIN forks ON fork.parent_id = forks.thread_id
    )`;

  // A subagent has no user of its own, so it ages with the thread that started it. With a
  // `threadId` and `ignoreForks` this is the cheap re-check inside a write: it reads only that
  // thread and its anchor. The forks' use (a JSON field, no index) is checked outside the write,
  // once before a thread's pages, by the call given the pass's fork table.
  const readCandidates = (
    input: {
      readonly idleBefore: string;
      readonly now: string;
      readonly threadId?: ThreadId;
    } & ({ readonly ignoreForks: true } | { readonly forks: ForkTable }),
  ) => sql<Candidate>`
    ${"forks" in input ? sql`WITH RECURSIVE ${forkLinks(input.forks, input.threadId)}` : sql``}
    SELECT
      thread.thread_id AS "threadId",
      -- A rolled-back run's items are hidden, and the notice would go with them.
      (
        SELECT shown.run_id FROM orchestration_v2_projection_runs AS shown
        WHERE shown.thread_id = thread.thread_id AND shown.status <> 'rolled_back'
        ORDER BY shown.ordinal DESC LIMIT 1
      ) AS "noticeRunId",
      run.ordinal AS "runOrdinal",
      thread.updated_at AS "updatedAt"
    FROM orchestration_v2_projection_threads AS thread
    JOIN orchestration_v2_projection_threads AS anchor ON anchor.thread_id = CASE
      WHEN json_extract(thread.payload_json, '$.lineage.relationshipToParent') = 'subagent'
        THEN COALESCE(json_extract(thread.payload_json, '$.lineage.rootThreadId'), thread.thread_id)
      ELSE thread.thread_id
    END
    JOIN orchestration_v2_projection_runs AS run ON run.run_id = (
      SELECT latest.run_id FROM orchestration_v2_projection_runs AS latest
      WHERE latest.thread_id = thread.thread_id
      ORDER BY latest.ordinal DESC LIMIT 1
    )
    WHERE ${input.threadId === undefined ? sql`1` : sql`thread.thread_id = ${input.threadId}`}
      AND thread.deleted_at IS NULL
      -- Restoring a shared worktree reads a side chat's tool items to learn whether it wrote there.
      AND COALESCE(json_extract(thread.payload_json, '$.lineage.sideChat'), 0) = 0
      -- A workflow run reads its agent steps' output after the fact.
      AND COALESCE(json_extract(thread.payload_json, '$.lineage.workflowStep'), 0) = 0
      AND anchor.created_at < ${input.idleBefore}
      AND COALESCE(json_extract(anchor.payload_json, '$.lastVisitedAt'), '') < ${input.idleBefore}
      AND json_extract(anchor.payload_json, '$.pinnedAt') IS NULL
      AND COALESCE(json_extract(anchor.payload_json, '$.snoozedUntil'), '') <= ${input.now}
      AND NOT EXISTS (
        SELECT 1 FROM json_each(anchor.payload_json, '$.pullRequests') AS link
        WHERE COALESCE(json_extract(link.value, '$.snapshot.state'), 'open') = 'open'
          AND COALESCE(json_extract(link.value, '$.source'), '') <> 'stack-dismissed'
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_messages AS message
        WHERE message.thread_id = anchor.thread_id
          AND message.role = 'user'
          AND message.updated_at >= ${input.idleBefore}
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs AS recent
        WHERE recent.thread_id IN (thread.thread_id, anchor.thread_id)
          AND (
            recent.status IN ${sql.in(LIVE_RUN_STATUSES)}
            OR recent.requested_at >= ${input.idleBefore}
            OR COALESCE(recent.completed_at, '') >= ${input.idleBefore}
          )
      )
      ${"forks" in input
        ? sql`
      -- A live fork shows this thread's rows, so its use keeps them too.
      AND NOT EXISTS (
        SELECT 1 FROM forks AS link
        JOIN orchestration_v2_projection_threads AS fork ON fork.thread_id = link.thread_id
        WHERE link.root_id IN (thread.thread_id, anchor.thread_id)
          AND link.deleted = 0
          AND (
            fork.created_at >= ${input.idleBefore}
            OR COALESCE(json_extract(fork.payload_json, '$.lastVisitedAt'), '') >= ${input.idleBefore}
            OR EXISTS (
              SELECT 1 FROM orchestration_v2_projection_messages AS message
              WHERE message.thread_id = fork.thread_id
                AND message.role = 'user'
                AND message.updated_at >= ${input.idleBefore}
            )
            OR EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runs AS recent
              WHERE recent.thread_id = fork.thread_id
                AND (
                  recent.status IN ${sql.in(LIVE_RUN_STATUSES)}
                  OR recent.requested_at >= ${input.idleBefore}
                  OR COALESCE(recent.completed_at, '') >= ${input.idleBefore}
                )
            )
          )
      )`
        : sql``}
      AND (${input.threadId !== undefined ? sql`1` : sql`0`} OR EXISTS (
        SELECT 1 FROM orchestration_v2_projection_turn_items AS item
        WHERE item.thread_id = thread.thread_id
          AND item.type IN ${sql.in(TRIMMED_ITEM_TYPES)}
          AND item.inline_work_output = 0
          AND item.status NOT IN ${sql.in(LIVE_ITEM_STATUSES)}
          AND ${sql.literal(keepsPreparationRow("item."))}
          -- A trimmed thread keeps the tool items its kept items hang off.
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_turn_items AS child
            WHERE child.thread_id = item.thread_id AND child.parent_item_id = item.turn_item_id
          )
      ))
    ORDER BY thread.thread_id ASC
  `;

  const window = Effect.gen(function* () {
    // Null is off, as for every other storage cleanup rule; 0 below means the same.
    const afterDays =
      (yield* settingsService.getSettings).storageCleanup.threadHistoryAfterDays ?? 0;
    const nowMs = yield* Clock.currentTimeMillis;
    return {
      afterDays,
      now: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      idleBefore: DateTime.formatIso(DateTime.makeUnsafe(nowMs - afterDays * DAY_MS)),
    };
  });

  // Rows other than turn items and nodes that keep a node.
  const nodeReferences = (threadId: ThreadId) => sql`
    SELECT node_id AS id FROM orchestration_v2_projection_messages
      WHERE thread_id = ${threadId} AND node_id IS NOT NULL
    UNION SELECT node_id FROM orchestration_v2_projection_plans
      WHERE thread_id = ${threadId} AND node_id IS NOT NULL
    UNION SELECT parent_node_id FROM orchestration_v2_projection_subagents
      WHERE thread_id = ${threadId}
    UNION SELECT node_id FROM orchestration_v2_projection_runtime_requests
      WHERE thread_id = ${threadId} AND node_id IS NOT NULL
    UNION SELECT node_id FROM orchestration_v2_projection_checkpoints
      WHERE thread_id = ${threadId}
    UNION SELECT node_id FROM orchestration_v2_projection_checkpoint_scopes
      WHERE thread_id = ${threadId} AND node_id IS NOT NULL
    UNION SELECT node_id FROM orchestration_v2_projection_provider_turns
      WHERE thread_id = ${threadId}
    UNION SELECT root_node_id FROM orchestration_v2_projection_run_attempts
      WHERE thread_id = ${threadId} AND root_node_id IS NOT NULL
    UNION SELECT owner_node_id FROM orchestration_v2_projection_provider_threads
      WHERE thread_id = ${threadId} AND owner_node_id IS NOT NULL
  `;

  const select = Effect.fn("ThreadHistoryTrim.select")(function* (candidate: Candidate) {
    const { threadId } = candidate;
    const items = yield* sql<{
      readonly id: string;
      readonly parent: string | null;
      readonly node: string | null;
      readonly type: string;
      readonly status: string;
      readonly inline: number;
      readonly removable: number;
      readonly bytes: number;
    }>`
      SELECT
        turn_item_id AS id,
        parent_item_id AS parent,
        node_id AS node,
        type,
        status,
        inline_work_output AS inline,
        ${sql.literal(keepsPreparationRow(""))} AS removable,
        ${sql.literal(ITEM_BYTES)} AS bytes
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId}
    `;
    const trimmedItemTypes: ReadonlyArray<string> = TRIMMED_ITEM_TYPES;
    const liveItemStatuses: ReadonlyArray<string> = LIVE_ITEM_STATUSES;
    const removedItems = unreferenced(
      items,
      (item) =>
        trimmedItemTypes.includes(item.type) &&
        item.inline === 0 &&
        item.removable === 1 &&
        !liveItemStatuses.includes(item.status),
      [],
    );
    const removedItemIds = new Set(removedItems.map((item) => item.id));

    const nodes = yield* sql<{
      readonly id: string;
      readonly parent: string | null;
      readonly kind: string;
      readonly status: string;
      readonly settled: number;
      readonly bytes: number;
    }>`
      SELECT
        node.node_id AS id,
        node.parent_node_id AS parent,
        node.kind,
        node.status,
        COALESCE(run.ordinal <= ${candidate.runOrdinal}, 0) AS settled,
        ${sql.literal(nodeBytes("node."))} AS bytes
      FROM orchestration_v2_projection_nodes AS node
      LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = node.run_id
      WHERE node.thread_id = ${threadId}
    `;
    const referencedNodes = yield* sql<{ readonly id: string }>`${nodeReferences(threadId)}`;
    const trimmedNodeKinds: ReadonlyArray<string> = TRIMMED_NODE_KINDS;
    const liveNodeStatuses: ReadonlyArray<string> = LIVE_NODE_STATUSES;
    const removedNodes = unreferenced(
      nodes,
      (node) =>
        node.settled === 1 &&
        trimmedNodeKinds.includes(node.kind) &&
        !liveNodeStatuses.includes(node.status),
      [
        ...items.flatMap((item) =>
          item.node === null || removedItemIds.has(item.id) ? [] : [item.node],
        ),
        ...referencedNodes.map((row) => row.id),
      ],
    );
    return { items: removedItems, nodes: removedNodes };
  });

  const estimate = Effect.fn("ThreadHistoryTrim.estimate")(function* (dryRun: boolean) {
    const { afterDays, now, idleBefore } = yield* window;
    const candidates =
      afterDays <= 0
        ? []
        : yield* readCandidates({ idleBefore, now, forks: yield* readForkTable() });
    let threadCount = 0;
    let itemCount = 0;
    let estimatedBytes = 0;
    for (const candidate of candidates) {
      const selection = yield* select(candidate);
      // A candidate with nothing to remove is not counted, as a pass skips it.
      if (selection.items.length > 0 || selection.nodes.length > 0) threadCount += 1;
      itemCount += selection.items.length;
      estimatedBytes += sumBytes(selection.items) + sumBytes(selection.nodes);
      yield* Effect.yieldNow;
    }
    return {
      dryRun,
      afterDays,
      threadCount,
      itemCount,
      estimatedBytes,
    } satisfies ThreadHistoryTrimReport;
  });

  // Without a visible run the notice belongs to the thread, and the timeline shows it.
  const noticeItemId = (candidate: Candidate) =>
    candidate.noticeRunId === null
      ? TurnItemId.make(`turn-item:thread:${candidate.threadId}:signal:${NOTICE_SIGNAL}`)
      : ids.derive.runSignalTurnItem({ runId: candidate.noticeRunId, signal: NOTICE_SIGNAL });

  const noticeEvent = Effect.fn("ThreadHistoryTrim.noticeEvent")(function* (
    candidate: Candidate,
    afterDays: number,
  ) {
    const now = yield* DateTime.now;
    return {
      id: yield* ids.allocate.event({ threadId: candidate.threadId }),
      type: "turn-item.updated",
      threadId: candidate.threadId,
      ...(candidate.noticeRunId === null ? {} : { runId: candidate.noticeRunId }),
      // Every event stamps the thread with its time; reusing the thread's own keeps a trimmed
      // thread where it was in lists sorted by activity.
      occurredAt: DateTime.makeUnsafe(candidate.updatedAt),
      payload: {
        id: noticeItemId(candidate),
        threadId: candidate.threadId,
        runId: candidate.noticeRunId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        // EventSink allocates the real position, after the run's existing items.
        ordinal: 0,
        status: "completed",
        title: "Older detail was trimmed",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "system_notice",
        message: trimNoticeMessage(afterDays),
        // Clients show a notice with no level as a warning.
        level: "info",
        historyTrim: { afterDays },
      },
    } satisfies OrchestrationV2DomainEvent;
  });

  // Removes one page in a transaction that first confirms the thread itself is idle and trimming
  // on. A fork's use is not read here: `pass` checked it before the first page, and a later start
  // is caught by the next pass. The copy to forks still waits on their queued snapshots.
  const trimPage = Effect.fn("ThreadHistoryTrim.trimPage")(function* (
    threadId: ThreadId,
    page: { readonly itemIds: ReadonlyArray<string>; readonly nodeIds: ReadonlyArray<string> },
  ) {
    // Assigned inside the transaction, which narrowing cannot see.
    let outcome = "trimmed" as "trimmed" | "thread-in-use" | "trimming-off";
    let removed: { readonly itemIds: ReadonlySet<string>; readonly nodeIds: ReadonlySet<string> } =
      {
        itemIds: new Set(),
        nodeIds: new Set(),
      };
    yield* eventSink.writeBuilt(
      Effect.gen(function* () {
        const { afterDays, now, idleBefore } = yield* window;
        if (afterDays <= 0) {
          outcome = "trimming-off";
          return [];
        }
        const current = (yield* readCandidates({
          idleBefore,
          now,
          threadId,
          ignoreForks: true,
        }))[0];
        if (current === undefined) {
          outcome = "thread-in-use";
          return [];
        }
        const itemIds =
          page.itemIds.length === 0
            ? []
            : yield* sql<{ readonly id: TurnItemId }>`
          SELECT turn_item_id AS id FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND turn_item_id IN ${sql.in(page.itemIds)}
            AND status NOT IN ${sql.in(LIVE_ITEM_STATUSES)} AND inline_work_output = 0
            AND ${sql.literal(keepsPreparationRow(""))}
        `;
        const itemChildren =
          page.itemIds.length === 0
            ? []
            : yield* sql<{
                readonly id: string;
                readonly parent: string;
              }>`
          SELECT turn_item_id AS id, parent_item_id AS parent
          FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND parent_item_id IN ${sql.in(page.itemIds)}
        `;
        const items = withoutParentsOfKept(
          itemIds.map((row) => row.id),
          itemChildren,
          [],
        );

        const nodeIds =
          page.nodeIds.length === 0
            ? []
            : yield* sql<{ readonly id: NodeId }>`
          SELECT node_id AS id FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId} AND node_id IN ${sql.in(page.nodeIds)}
            AND status NOT IN ${sql.in(LIVE_NODE_STATUSES)}
        `;
        const nodeChildren =
          page.nodeIds.length === 0
            ? []
            : yield* sql<{
                readonly id: string;
                readonly parent: string;
              }>`
          SELECT node_id AS id, parent_node_id AS parent FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId} AND parent_node_id IN ${sql.in(page.nodeIds)}
        `;
        const nodeHolders =
          page.nodeIds.length === 0
            ? []
            : yield* sql<{
                readonly id: string;
                readonly node: string;
              }>`
          SELECT turn_item_id AS id, node_id AS node FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND node_id IN ${sql.in(page.nodeIds)}
        `;
        const otherReferences =
          page.nodeIds.length === 0
            ? []
            : yield* sql<{ readonly id: string }>`
          SELECT id FROM (${nodeReferences(threadId)}) WHERE id IN ${sql.in(page.nodeIds)}
        `;
        const nodes = withoutParentsOfKept(
          nodeIds.map((row) => row.id),
          nodeChildren,
          [
            ...nodeHolders.flatMap((row) => (items.has(row.id) ? [] : [row.node])),
            ...otherReferences.map((row) => row.id),
          ],
        );
        if (items.size === 0 && nodes.size === 0) return [];
        removed = { itemIds: items, nodeIds: nodes };
        const noticeId = noticeItemId(current);
        // The notice follows the newest visible run, so one made under an earlier run is replaced.
        const notices = yield* sql<{ readonly id: TurnItemId; readonly days: number | null }>`
          SELECT turn_item_id AS id, json_extract(payload_json, '$.historyTrim.afterDays') AS days
          FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND type = 'system_notice'
            AND json_extract(payload_json, '$.historyTrim') IS NOT NULL
        `;
        const staleNoticeIds = notices.flatMap((row) => (row.id === noticeId ? [] : [row.id]));
        const noticed = notices.some((row) => row.id === noticeId && row.days === afterDays);
        const events: Array<OrchestrationV2DomainEvent> = noticed
          ? []
          : [yield* noticeEvent(current, afterDays)];
        const occurredAt = yield* DateTime.now;
        events.push({
          id: yield* ids.allocate.event({ threadId }),
          type: "thread.history-trimmed",
          threadId,
          occurredAt,
          payload: {
            sourceThreadId: threadId,
            turnItemIds: [
              ...itemIds.flatMap((row) => (items.has(row.id) ? [row.id] : [])),
              ...staleNoticeIds,
            ],
            nodeIds: nodeIds.flatMap((row) => (nodes.has(row.id) ? [row.id] : [])),
          },
        });
        return events;
      }),
      [threadId],
    );
    return { outcome, removed };
  });

  // A fork made since the table was read inherited rows this trim removes, and may already be in
  // use. A newer thread means the table is read again, and the rest of the pass uses that one.
  const currentForkTable = Effect.fn("ThreadHistoryTrim.currentForkTable")(function* (
    forkTableRef: Ref.Ref<ForkTable>,
  ) {
    const known = yield* Ref.get(forkTableRef);
    if ((yield* readMaxThreadRowid) === known.maxRowid) return known;
    const fresh = yield* readForkTable();
    yield* Ref.set(forkTableRef, fresh);
    return fresh;
  });

  /**
   * Moves each live fork's revision once per thread, after its last page: every copy makes a
   * subscribed fork re-read and resend its whole snapshot, so one per page would repeat that.
   */
  const copyToForks = Effect.fn("ThreadHistoryTrim.copyToForks")(function* (
    threadId: ThreadId,
    forkTableRef: Ref.Ref<ForkTable>,
  ) {
    const forkTable = yield* currentForkTable(forkTableRef);
    // A fork may have started a run during the rests between pages, so the write waits for the
    // provider snapshots queued for each fork, as any write to that thread does.
    const forks = liveForksOf(forkTable, threadId).map((id) => ({ id }));
    if (forks.length === 0) return;
    yield* eventSink.writeBuilt(
      Effect.gen(function* () {
        const occurredAt = yield* DateTime.now;
        const events: Array<OrchestrationV2DomainEvent> = [];
        for (const { id: fork } of forks) {
          events.push({
            id: yield* ids.allocate.event({ threadId: fork }),
            type: "thread.history-trimmed",
            threadId: fork,
            occurredAt,
            payload: { sourceThreadId: threadId, turnItemIds: [], nodeIds: [] },
          });
        }
        return events;
      }),
      forks.map((fork) => fork.id),
    );
  });

  const trimPages = Effect.fn("ThreadHistoryTrim.trimPages")(function* (
    candidate: Candidate,
    rest: Effect.Effect<void>,
    progress: { removedAny: boolean },
    stillIdle: Effect.Effect<boolean, SqlError>,
  ) {
    const selection = yield* select(candidate).pipe(NodeSqliteClient.readOnly);
    const rows = [
      ...selection.items.map((row) => ({ ...row, kind: "item" as const })),
      ...selection.nodes.map((row) => ({ ...row, kind: "node" as const })),
    ];
    let itemCount = 0;
    let bytes = 0;
    for (let offset = 0; offset < rows.length; offset += DELETE_PAGE_SIZE) {
      const page = rows.slice(offset, offset + DELETE_PAGE_SIZE);
      // A fork may have been used during the rest after the last page; the write below skips forks.
      if (offset > 0 && !(yield* stillIdle)) {
        return { outcome: "thread-in-use" as const, itemCount, bytes };
      }
      const { outcome, removed } = yield* trimPage(candidate.threadId, {
        itemIds: page.flatMap((row) => (row.kind === "item" ? [row.id] : [])),
        nodeIds: page.flatMap((row) => (row.kind === "node" ? [row.id] : [])),
      });
      progress.removedAny ||= removed.itemIds.size > 0 || removed.nodeIds.size > 0;
      if (outcome !== "trimmed") return { outcome, itemCount, bytes };
      for (const row of page) {
        if (!(row.kind === "item" ? removed.itemIds : removed.nodeIds).has(row.id)) continue;
        if (row.kind === "item") itemCount += 1;
        bytes += row.bytes;
      }
      // Never hold the writer across a rest: foreground commits run between pages.
      yield* rest;
    }
    return { outcome: "trimmed" as const, itemCount, bytes };
  });

  const trimThread = Effect.fn("ThreadHistoryTrim.trimThread")(function* (
    candidate: Candidate,
    rest: Effect.Effect<void>,
    forkTableRef: Ref.Ref<ForkTable>,
    stillIdle: Effect.Effect<boolean, SqlError>,
  ) {
    const progress = { removedAny: false };
    return yield* trimPages(candidate, rest, progress, stillIdle).pipe(
      // A later page can fail after earlier ones removed rows, and a fork's subscribers would
      // keep those rows. The failure itself still reaches the caller; a failed copy only logs.
      Effect.onExit((exit) =>
        Effect.suspend(() =>
          !progress.removedAny || (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
            ? Effect.void
            : copyToForks(candidate.threadId, forkTableRef).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Copying a history trim to forks failed", {
                    threadId: candidate.threadId,
                    cause: Cause.pretty(cause),
                  }),
                ),
              ),
        ),
      ),
    );
  });

  const readLastPass = sql<{ readonly updated_at: string }>`
    SELECT updated_at FROM orchestration_v2_projection_metadata WHERE projection_name = ${LAST_PASS}
  `.pipe(Effect.map((rows) => rows[0]?.updated_at ?? null));
  const statusOf = (lastTrimmedAt: string | null): ThreadHistoryTrimStatus => ({
    lastTrimmedAt,
    nextTrimAt:
      lastTrimmedAt === null
        ? null
        : DateTime.formatIso(DateTime.makeUnsafe(Date.parse(lastTrimmedAt) + PASS_INTERVAL_MS)),
  });
  const statusRef = yield* SubscriptionRef.make(
    statusOf(yield* readLastPass.pipe(Effect.orElseSucceed(() => null))),
  );
  const recordPass = Effect.gen(function* () {
    const finishedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO orchestration_v2_projection_metadata (
        projection_name, schema_version, last_sequence, updated_at
      )
      VALUES (
        ${LAST_PASS}, ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION}, 0, ${finishedAt}
      )
      ON CONFLICT(projection_name) DO UPDATE SET updated_at = excluded.updated_at
    `;
    yield* SubscriptionRef.set(statusRef, statusOf(finishedAt));
  });

  // Requested trims queued or running. The worker is serial, so a background sweep's rests would
  // otherwise hold a requested trim behind them for as long as the sweep takes.
  const manualPendingRef = yield* Ref.make(0);
  const manualQueued = yield* Latch.make();

  const pass = Effect.fn("ThreadHistoryTrim.pass")(function* (mode: Mode) {
    const { afterDays, now, idleBefore } = yield* window;
    if (afterDays <= 0) return;
    if (mode === "background") {
      // Checked here, behind the queue, so a requested trim that just finished counts.
      const last = yield* readLastPass;
      if (last !== null && Date.parse(now) - Date.parse(last) < PASS_INTERVAL_MS) return;
    }
    // The sweep keeps to a 10% duty so a backlog never competes with a turn. A requested trim does
    // not rest, and cuts short the rests of a sweep it is queued behind.
    const rest =
      mode === "manual"
        ? Effect.yieldNow
        : (yield* makeDutyRest).pipe(Effect.raceFirst(manualQueued.await));
    // Read once for the whole pass (again only if a thread is made before a copy to forks): the
    // candidate list, each candidate's re-check, and the copies all use it.
    const forkTableRef = yield* Ref.make(yield* readForkTable());
    const candidates = yield* readCandidates({
      idleBefore,
      now,
      forks: yield* Ref.get(forkTableRef),
    }).pipe(
      NodeSqliteClient.readOnly,
    );
    if (mode !== "manual" && candidates.length > 0) {
      yield* Effect.logInfo("Idle thread history due for trimming", {
        threadCount: candidates.length,
      });
    }
    let threadCount = 0;
    let itemCount = 0;
    let estimatedBytes = 0;
    for (const listed of candidates) {
      // A requested trim sweeps these threads next and records the pass.
      if (mode !== "manual" && (yield* Ref.get(manualPendingRef)) > 0) return;
      // A long pass outlives its list: a thread used since is no longer one. This read-side call
      // is the only one that checks the thread's forks; the page writes check the thread alone.
      const current = yield* readCandidates({
        idleBefore,
        now,
        threadId: listed.threadId,
        forks: yield* Ref.get(forkTableRef),
      }).pipe(NodeSqliteClient.readOnly);
      const candidate = current[0];
      if (candidate === undefined) continue;
      // Outside any write, with the fork table refreshed if a thread was made: as when listing.
      const stillIdle = currentForkTable(forkTableRef).pipe(
        Effect.flatMap((forks) =>
          readCandidates({ idleBefore, now, threadId: listed.threadId, forks }).pipe(
            NodeSqliteClient.readOnly,
          ),
        ),
        Effect.map((rows) => rows.length > 0),
      );
      const removed = yield* trimThread(candidate, rest, forkTableRef, stillIdle).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("Trimming a thread's history failed", {
              threadId: candidate.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(null)),
        ),
      );
      if (removed === null) continue;
      if (removed.outcome === "trimming-off") return;
      if (removed.itemCount === 0 && removed.bytes === 0) continue;
      threadCount += 1;
      itemCount += removed.itemCount;
      estimatedBytes += removed.bytes;
    }
    if (threadCount > 0) {
      yield* Effect.logInfo("Trimmed idle thread history", {
        mode,
        afterDays,
        threadCount,
        itemCount,
        estimatedBytes,
      });
    }
    yield* recordPass;
  });

  const worker = yield* makeDrainableWorker((mode: Mode) =>
    mode === "manual"
      ? pass(mode).pipe(
          Effect.ensuring(
            Ref.updateAndGet(manualPendingRef, (pending) => pending - 1).pipe(
              Effect.flatMap((pending) => (pending === 0 ? manualQueued.close : Effect.void)),
            ),
          ),
        )
      : pass(mode),
  );

  const mapError =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new ThreadHistoryTrimError({ operation, cause })));

  // A pass is due 30 days after the last one finished, or at once when none has. Checking every
  // six hours catches a due date that passes while running; one long timer overflows and drifts
  // across machine sleep.
  yield* forkParked(
    Effect.sleep("5 minutes").pipe(
      Effect.andThen(
        worker
          .enqueue("background")
          .pipe(Effect.andThen(worker.drain), Effect.repeat(Schedule.spaced("6 hours"))),
      ),
    ),
  );

  // The check above ends at once while the setting is off, so turning it on later would wait up to
  // six hours for the next one. A switch from off to on, or to a shorter window, queues one pass,
  // as the start does; the 30-day wait would otherwise hold back a window that now reaches more threads.
  const changes = yield* settingsService.subscribeChanges;
  const initial = yield* settingsService.getSettings.pipe(Effect.orDie);
  let days = initial.storageCleanup.threadHistoryAfterDays ?? 0;
  yield* forkParked(
    changes.pipe(
      Stream.filter((settings) => {
        const next = settings.storageCleanup.threadHistoryAfterDays ?? 0;
        const widened = next > 0 && (days <= 0 || next < days);
        days = next;
        return widened;
      }),
      Stream.switchMap(() =>
        Stream.fromEffect(
          Effect.sleep("5 minutes").pipe(Effect.andThen(worker.enqueue("enabled"))),
        ),
      ),
      Stream.runDrain,
    ),
  );

  return ThreadHistoryTrim.of({
    preview: estimate(true).pipe(NodeSqliteClient.readOnly, mapError("preview")),
    trimNow: Effect.gen(function* () {
      const { afterDays } = yield* window.pipe(mapError("trim"));
      if (afterDays <= 0) return yield* new ThreadHistoryTrimDisabledError();
      yield* Ref.update(manualPendingRef, (pending) => pending + 1).pipe(
        Effect.andThen(manualQueued.open),
        Effect.andThen(worker.enqueue("manual")),
        Effect.uninterruptible,
      );
      return {
        dryRun: false,
        afterDays,
        threadCount: 0,
        itemCount: 0,
        estimatedBytes: 0,
      } satisfies ThreadHistoryTrimReport;
    }),
    status: SubscriptionRef.changes(statusRef),
    drain: worker.drain,
  });
});

export const layer = Layer.effect(ThreadHistoryTrim, make);
