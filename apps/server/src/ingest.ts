import { BatchSchema, type TelemetryEvent } from "@observatory/contracts";
import { tenant } from "./db.js";
import { invalidateAnalytics } from "./cache.js";

export async function ingest(userId: string, payload: unknown) {
  const batch = BatchSchema.parse(payload);
  const result = await tenant(userId, async db => {
    const acknowledged: string[] = [];
    for (const event of batch.events) {
      const inserted = await db.query("INSERT INTO events(user_id,event_id,installation_id,event) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_id", [userId, event.eventId, event.installationId, event]);
      if (inserted.rowCount) await db.query(`
        INSERT INTO entities(user_id,installation_id,kind,entity_id,instance_id,machine,project_id,session_id,message_id,observed_at,revision,historical,runtime,data)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT(user_id,installation_id,kind,entity_id) DO UPDATE SET
          instance_id=EXCLUDED.instance_id, machine=EXCLUDED.machine,
          project_id=COALESCE(EXCLUDED.project_id,entities.project_id), session_id=COALESCE(EXCLUDED.session_id,entities.session_id), message_id=COALESCE(EXCLUDED.message_id,entities.message_id),
          observed_at=LEAST(entities.observed_at,EXCLUDED.observed_at), revision=CASE WHEN EXCLUDED.historical AND NOT entities.historical THEN entities.revision ELSE EXCLUDED.revision END,
          historical=entities.historical AND EXCLUDED.historical,
          runtime=CASE WHEN EXCLUDED.historical AND NOT entities.historical THEN entities.runtime ELSE EXCLUDED.runtime END,
          data=CASE WHEN EXCLUDED.historical AND NOT entities.historical THEN entities.data ELSE entities.data || EXCLUDED.data END
        WHERE (EXCLUDED.revision > entities.revision OR (EXCLUDED.revision = entities.revision AND NOT EXCLUDED.historical))
          AND NOT (entities.data->>'status' IN ('completed','failed','cancelled') AND EXCLUDED.data->>'status'='running')
      `, values(userId, event));
      acknowledged.push(event.eventId);
    }
    return { acknowledged, receivedAt: Date.now() };
  });
  invalidateAnalytics(userId);
  return result;
}
function values(userId: string, e: TelemetryEvent) {
  return [userId,e.installationId,e.kind,e.entityId,e.instanceId,e.machine,e.projectId,e.sessionId,e.messageId,e.observedAt,e.revision,e.historical,e.runtime,e.data];
}
