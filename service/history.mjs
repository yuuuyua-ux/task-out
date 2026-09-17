export const HISTORY_DAYS = Object.freeze([3, 7, 30]);
export const historyDays = value => HISTORY_DAYS.includes(value) ? value : 30;

// Activity timestamps come from the source log, never file mtime or scan time.
export function inHistory(updatedAt, days, now = Date.now()) {
  return typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt > 0 &&
    updatedAt <= now && updatedAt >= now - historyDays(days) * 86400000;
}

export function currentRecords(records, connections, now = Date.now()) {
  const configured = new Map(connections.map(connection => [connection.id, connection]));
  return records.filter(record => record.observations?.some(observation => {
    const connection = configured.get(observation.connectionId);
    // Pausing/offline changes reading, not the selected historical window.
    return connection && inHistory(record.updatedAt, connection.historyDays, now);
  }));
}
