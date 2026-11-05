import { useMemo } from 'react';
import { normalizeAppLanguage } from '../i18n';
import { useAppStore } from '../store';
import type { AppLanguage } from '../types';
import { UI_STRINGS, type UiStringKey } from './strings';

/** The interface language of the new interface: zh (Simplified Chinese) or en (English). */
export type UiLang = 'zh' | 'en';
export type UiParams = Record<string, string | number>;
export type UiText = (key: UiStringKey, params?: UiParams) => string;

export const uiLangOf = (language: unknown): UiLang => normalizeAppLanguage(language) === 'zh-CN' ? 'zh' : 'en';
export const appLanguageOf = (lang: UiLang): AppLanguage => lang === 'zh' ? 'zh-CN' : 'en-US';

/** Numbers in the interface: grouped digits, no grouping for years or ids (pass those as strings). */
export function formatNumber(value: number, lang: UiLang) {
  return Number.isFinite(value) ? value.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US') : '';
}

/** {name} placeholders: numbers are grouped for the language, strings are used as they are, a missing value is empty. */
export function fillUiText(template: string, params: UiParams | undefined, lang: UiLang) {
  if (!params) return template;
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name: string) => {
    const value = params[name];
    return typeof value === 'number' ? formatNumber(value, lang) : typeof value === 'string' ? value : '';
  });
}

/** English singulars: a key may have a `<key>.one` form used when params.n (or params.f) is 1. */
export function uiText(lang: UiLang, key: UiStringKey, params?: UiParams): string {
  const one = params && (params.n === 1 || params.f === 1) ? (UI_STRINGS as Record<string, readonly [string, string]>)[`${key}.one`] : undefined;
  const pair = one ?? UI_STRINGS[key] as readonly [string, string] | undefined;
  if (!pair) return key;
  return fillUiText(pair[lang === 'zh' ? 0 : 1], params, lang);
}

/** The current interface language (from the saved settings) and its text function. */
export function useUiText() {
  const language = useAppStore(state => state.settings?.language);
  const lang = uiLangOf(language);
  return useMemo(() => ({ lang, language: appLanguageOf(lang), t: ((key, params) => uiText(lang, key, params)) as UiText }), [lang]);
}

/** Bytes as "15.6 MB" (1000-based units, one decimal from KB on). */
export function formatBytes(bytes: number, lang: UiLang) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1000) return `${formatNumber(bytes, lang)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 1, minimumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

const pad = (value: number) => String(value).padStart(2, '0');
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A calendar day relative to now: 今天 / 昨天 / 11 月 1 日 (2025 年 11 月 1 日 in another year); Today / Yesterday / Nov 1 (Nov 1, 2025). */
export function formatDay(value: Date | string | number, lang: UiLang, now: Date = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return uiText(lang, 'c.today');
  if (days === 1) return uiText(lang, 'c.yesterday');
  const params = { year: String(date.getFullYear()), month: lang === 'zh' ? String(date.getMonth() + 1) : MONTHS_EN[date.getMonth()], day: String(date.getDate()) };
  return uiText(lang, date.getFullYear() === now.getFullYear() ? 'fmt.monthDay' : 'fmt.yearMonthDay', params);
}

export function formatTime(value: Date | string | number) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "今天 17:44" / "Today 17:44"; days before yesterday show the day only. */
export function formatWhen(value: Date | string | number, lang: UiLang, now: Date = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  return days <= 1 && days >= 0 ? `${formatDay(date, lang, now)} ${formatTime(date)}` : formatDay(date, lang, now);
}

/** A list of quoted names for the language (「a」「b」 / “a”, “b”). */
export function quotedList(names: readonly string[], lang: UiLang) {
  return names.map(name => uiText(lang, 'fmt.quoted', { name })).join(lang === 'zh' ? '' : ', ');
}
