/**
 * DEPRECATED — mid-funnel Type|Voice broke UX (Whisper parked the product step).
 *
 * Use instead:
 *   node scripts/patch-ahl-utm-v3-post-thanks-extra.mjs
 *
 * That script removes mid-funnel concern and adds optional query / voice /
 * photos AFTER the Thank You message.
 */
console.error(
  "Deprecated: mid-funnel voice was moved after Thank You.\nRun: node scripts/patch-ahl-utm-v3-post-thanks-extra.mjs",
);
process.exit(1);
