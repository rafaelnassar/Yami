/**
 * Helper to declare a message namespace. Portuguese is the source of truth; the
 * type system forces `en` and `es` to provide exactly the same keys.
 *
 * Interpolation: `{name}`. Plurals: keys with `_one` / `_other` suffixes are
 * selected automatically when a numeric `count` param is passed (see translator).
 */
export type MessageTable = Readonly<Record<string, string>>;

export interface NamespaceMessages<K extends string> {
  readonly pt: Readonly<Record<K, string>>;
  readonly en: Readonly<Record<K, string>>;
  readonly es: Readonly<Record<K, string>>;
}

export function defineMessages<const T extends MessageTable>(
  pt: T,
  translations: { readonly en: { readonly [K in keyof T]: string }; readonly es: { readonly [K in keyof T]: string } }
): NamespaceMessages<Extract<keyof T, string>> {
  return { pt, en: translations.en, es: translations.es };
}
