/** Join class names, skipping falsy values. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/**
 * Resolve one or more local class names from a CSS module map.
 * Unknown names are dropped (avoid leaking unscoped global strings).
 */
export function m(
  styles: Record<string, string>,
  ...names: Array<string | false | null | undefined>
): string {
  return names
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
    .map((n) => styles[n])
    .filter(Boolean)
    .join(' ')
}
