// GET /api/ollama/health
// Probes the Ollama server (whatever OLLAMA_BASE_URL points at) and
// returns the list of installed models plus a simple ok/error flag.
// The Automation UI uses this to render a "Local LLM" status pill and
// to populate the model dropdown dynamically when the user picks the
// Ollama provider — so the dropdown always reflects what's actually
// pulled on the operator's machine.

import { NextResponse } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { ollamaHealth } from "@/lib/ollama";

export const runtime = "nodejs";

export async function GET() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const health = await ollamaHealth();
  return NextResponse.json(health);
}
