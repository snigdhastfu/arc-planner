// Calendar files in and out (.ics). Parsing/writing happens in the Go core.
import { S, importEvents } from './state.js';
import { call } from './bridge.js';
import * as T from './time.js';
import { shareOrDownload } from './dom.js';

export async function readIcs(file) {
  const text = await file.text();
  return call('icsImport', { ics: text, tz: S.profile.tz, now: T.iso(T.now()), horizonDays: 120 });
}
export async function confirmImport(items) { return importEvents(items); }

export async function exportIcs(include) {
  const res = call('icsExport', { items: S.items.filter((i) => !i.deleted), plan: S.plan, profile: S.profile, include, now: T.iso(T.now()) });
  const blob = new Blob([res.ics], { type: 'text/calendar' });
  const name = `arc-${include.join('-')}-${T.dayKey()}.ics`;
  return shareOrDownload(blob, name, 'Arc calendar');
}
