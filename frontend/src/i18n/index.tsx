import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { getRegisteredLocaleBundles } from "../plugins/runtime";
import type { LocaleBundle, LocaleMessageDictionary } from "../plugins/types";
import {
  DEFAULT_LOCALE,
  DEFAULT_LOCALE_LABEL,
  EN_MESSAGES,
} from "./messages";

const LOCALE_STORAGE_KEY = "app-locale";

export interface LocaleOption {
  code: string;
  label: string;
}

interface I18nContextValue {
  locale: string;
  locales: LocaleOption[];
  setLocale: (locale: string) => void;
  t: (key: string, values?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function normalizeLocale(input: string | null | undefined): string | null {
  const trimmed = input?.trim();
  return trimmed ? trimmed : null;
}

function mergeLocaleBundles(): LocaleBundle[] {
  const merged = new Map<string, LocaleBundle>();

  merged.set(DEFAULT_LOCALE, {
    locale: DEFAULT_LOCALE,
    label: DEFAULT_LOCALE_LABEL,
    messages: EN_MESSAGES,
  });

  for (const bundle of getRegisteredLocaleBundles()) {
    const existing = merged.get(bundle.locale);
    merged.set(bundle.locale, {
      locale: bundle.locale,
      label: bundle.label,
      messages: {
        ...(existing?.messages ?? {}),
        ...bundle.messages,
      },
    });
  }

  return Array.from(merged.values()).sort((left, right) => {
    if (left.locale === DEFAULT_LOCALE) return -1;
    if (right.locale === DEFAULT_LOCALE) return 1;
    return left.label.localeCompare(right.label);
  });
}

function resolveInitialLocale(bundles: LocaleBundle[]): string {
  const available = new Set(bundles.map((bundle) => bundle.locale));
  const stored = normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
  if (stored && available.has(stored)) {
    return stored;
  }

  const browserLocales = [
    ...navigator.languages,
    navigator.language,
  ]
    .map((value) => normalizeLocale(value))
    .filter((value): value is string => Boolean(value));

  for (const candidate of browserLocales) {
    if (available.has(candidate)) {
      return candidate;
    }

    const prefixMatch = bundles.find((bundle) =>
      bundle.locale.toLowerCase().startsWith(candidate.toLowerCase().split("-")[0])
    );
    if (prefixMatch) {
      return prefixMatch.locale;
    }
  }

  return DEFAULT_LOCALE;
}

function interpolate(
  template: string,
  values?: Record<string, string | number>
): string {
  if (!values) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = values[key];
    return value === undefined ? `{${key}}` : String(value);
  });
}

export const I18nProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const bundles = useMemo(() => mergeLocaleBundles(), []);
  const messagesByLocale = useMemo(() => {
    const next = new Map<string, LocaleMessageDictionary>();

    for (const bundle of bundles) {
      next.set(bundle.locale, bundle.messages);
    }

    return next;
  }, [bundles]);
  const locales = useMemo<LocaleOption[]>(
    () => bundles.map((bundle) => ({ code: bundle.locale, label: bundle.label })),
    [bundles]
  );
  const [locale, setLocaleState] = useState<string>(() => resolveInitialLocale(bundles));

  const setLocale = useCallback(
    (nextLocale: string) => {
      const normalized = normalizeLocale(nextLocale);
      const resolved =
        normalized && messagesByLocale.has(normalized)
          ? normalized
          : DEFAULT_LOCALE;
      setLocaleState(resolved);
      localStorage.setItem(LOCALE_STORAGE_KEY, resolved);
    },
    [messagesByLocale]
  );

  const t = useCallback(
    (key: string, values?: Record<string, string | number>) => {
      const localeMessages = messagesByLocale.get(locale);
      const fallbackMessages = messagesByLocale.get(DEFAULT_LOCALE);
      const template =
        localeMessages?.[key] ?? fallbackMessages?.[key] ?? key;
      return interpolate(template, values);
    },
    [locale, messagesByLocale]
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      locales,
      setLocale,
      t,
    }),
    [locale, locales, setLocale, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }

  return context;
}
