/**
 * Ralph notification detection — identifies Ralph-related extension notifications.
 *
 * Extracts the brittle inline regex from thread-session.ts into a testable module
 * with named patterns and clear categorization.
 */

/** Patterns that identify a notification as Ralph-related. */
const RALPH_PATTERNS: RegExp[] = [
  // Loop lifecycle
  /Ralph loop/i,
  /loop (paused|resumed|auto-resumed|ended|is not paused|is already running)/i,
  // Loop status/info
  /available presets:/i,
  /^Preset:/i,
  /no active loop/i,
  /no loop state/i,
  /no (iteration history|past loops|presets found)/i,
  // Loop control
  /steering queued/i,
  /unknown preset/i,
  /has no hats/i,
];

/** Patterns that indicate a Ralph loop has ended. */
const RALPH_END_PATTERNS: RegExp[] = [
  /ended:/i,
  /\bcomplete\b/i,
  /Task complete/i,
];

/**
 * Check if an extension notification message is Ralph-related.
 */
export function isRalphNotification(message: string): boolean {
  return RALPH_PATTERNS.some((p) => p.test(message));
}

/**
 * Check if a Ralph notification indicates the loop has ended.
 * Only meaningful when isRalphNotification() is true.
 */
export function isRalphEndNotification(message: string): boolean {
  return RALPH_END_PATTERNS.some((p) => p.test(message));
}
