/** 工具改动提醒后，通知所属会话刷新列表与定时器。 */
export interface ReminderController {
  refresh: () => void;
}

const controllers = new Map<string, ReminderController>();

export function registerReminderController(
  sessionId: string,
  controller: ReminderController,
): void {
  controllers.set(sessionId, controller);
}

export function unregisterReminderController(sessionId: string): void {
  controllers.delete(sessionId);
}

/** 工具在磁盘上改了提醒后调用；没有活跃连接时安静失败。 */
export function refreshReminderSession(sessionId: string): void {
  controllers.get(sessionId)?.refresh();
}
