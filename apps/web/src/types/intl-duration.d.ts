// Intl.DurationFormat is Stage-4 / 2026 baseline but not yet in the bundled TS
// lib. Minimal ambient declaration so lib/format.ts's fmtDuration type-checks.
// Remove once the TS lib ships it.
declare namespace Intl {
  interface DurationFormatOptions {
    localeMatcher?: "best fit" | "lookup";
    numberingSystem?: string;
    style?: "long" | "short" | "narrow" | "digital";
    years?: "long" | "short" | "narrow";
    months?: "long" | "short" | "narrow";
    weeks?: "long" | "short" | "narrow";
    days?: "long" | "short" | "narrow";
    hours?: "long" | "short" | "narrow" | "numeric" | "2-digit";
    minutes?: "long" | "short" | "narrow" | "numeric" | "2-digit";
    seconds?: "long" | "short" | "narrow" | "numeric" | "2-digit";
    fractionalDigits?: number;
  }

  interface DurationInput {
    years?: number;
    months?: number;
    weeks?: number;
    days?: number;
    hours?: number;
    minutes?: number;
    seconds?: number;
    milliseconds?: number;
    microseconds?: number;
    nanoseconds?: number;
  }

  interface DurationFormat {
    format(duration: DurationInput): string;
    formatToParts(duration: DurationInput): Array<{ type: string; value: string; unit?: string }>;
    resolvedOptions(): DurationFormatOptions & { locale: string };
  }

  const DurationFormat: {
    new (locales?: string | string[], options?: DurationFormatOptions): DurationFormat;
    prototype: DurationFormat;
    supportedLocalesOf(locales: string | string[], options?: DurationFormatOptions): string[];
  };
}
