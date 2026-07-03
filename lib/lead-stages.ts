// The full canonical CRM stage funnel, in display order. Single source of
// truth for the stage strip (LeadStageStrip), the drip-step stage picker, and
// the /api/lsq/stages fallback — so EVERY stage shows in the strip even when
// no contact currently sits in it (the API used to hide zero-count stages).
// Pure constant; safe to import on both client and server.
export const ALL_LEAD_STAGES = [
  "New Lead",
  "Contacted",
  "Follow Up",
  "NBD Booked",
  "NBD Not Visited",
  "NBD Done",
  "Not Booked",
  "Order Booked",
  "Lost Lead",
] as const;
