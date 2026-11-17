import { randomUUID } from 'node:crypto';
import type { Repository } from '../../persistence/src/repository.js';
import type { Settings } from '../../contracts/src/index.js';
export type OutboxEvent = { id: string; event_key: string; type: string; title: string; body: string; created_at: string; delivered: boolean };
export type NotificationRecord = { id: string; event_id: string; channel: 'IN_APP' | 'DESKTOP'; title: string; body: string; read: boolean; state: 'PENDING' | 'DELIVERED' | 'FAILED'; attempts: number; next_attempt_at: string; error: string | null; created_at: string };
export interface DesktopChannel { send(title: string, body: string, eventId: string): Promise<void> }
export function shanghaiHour(time: Date) { return Number(new Intl.DateTimeFormat('en-US', {timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23'}).format(time)); }
export function inHours(hour: number, hours: {start: number; end: number} | null) { return hours !== null && (hours.start === hours.end || (hours.start < hours.end ? hour >= hours.start && hour < hours.end : hour >= hours.start || hour < hours.end)); }
export class Notifications {
  constructor(private store: Repository, private settings: () => Settings, private desktop?: DesktopChannel) {}
  emit(eventKey: string, type: string, title: string, body: string) {
    if (this.store.find<OutboxEvent>('outbox', e => e.event_key === eventKey)) return;
    this.store.put('outbox', { id: randomUUID(), event_key: eventKey, type, title, body, created_at: new Date().toISOString(), delivered: false });
  }
  async flush() {
    const settings = this.settings();
    for (const event of this.store.all<OutboxEvent>('outbox').filter(e => !e.delivered)) {
      this.store.transaction(() => {
        for (const channel of settings.desktop_enabled ? ['IN_APP','DESKTOP'] as const : ['IN_APP'] as const) {
          if (!this.store.find<NotificationRecord>('notifications', n => n.event_id === event.id && n.channel === channel)) this.store.put('notifications', {
            id: randomUUID(), event_id: event.id, channel, title: event.title, body: channel === 'DESKTOP' && !settings.body_preview ? '打开招聘助手查看详情' : event.body,
            read: false, state: channel === 'IN_APP' ? 'DELIVERED' : 'PENDING', attempts: 0, next_attempt_at: event.created_at, error: null, created_at: event.created_at
          });
        }
        this.store.put('outbox', {...event, delivered: true});
      });
    }
    if (!settings.desktop_enabled || inHours(shanghaiHour(new Date()), settings.quiet_hours)) return;
    for (const delivery of this.store.all<NotificationRecord>('notifications').filter(n => n.channel === 'DESKTOP' && n.state !== 'DELIVERED' && n.attempts < 5 && n.next_attempt_at <= new Date().toISOString())) {
      try {
        if (!this.desktop) throw new Error('桌面通知渠道未运行，请启动桌面壳；站内通知已保存');
        await this.desktop.send(delivery.title, delivery.body, delivery.event_id);
        this.store.put('notifications', {...delivery, state: 'DELIVERED', error: null});
      } catch (error) {
        this.store.put('notifications', {...delivery, state: 'FAILED', attempts: delivery.attempts + 1, next_attempt_at: new Date(Date.now() + 2 ** delivery.attempts * 30000).toISOString(), error: error instanceof Error ? error.message : 'NOTIFICATION_FAILED'});
      }
    }
  }
}
