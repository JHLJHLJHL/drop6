export type LogFields = Record<string, string | number | boolean>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/**
 * JSON-lines logger. Callers must only pass counters and static labels:
 * never SDP, ICE candidates, file info, room codes or TURN credentials.
 */
export const consoleLogger: Logger = {
  info: (event, fields) => console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), event, ...fields })),
  error: (event, fields) => console.error(JSON.stringify({ level: 'error', time: new Date().toISOString(), event, ...fields })),
};
