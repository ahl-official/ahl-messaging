import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCredential } from "@/lib/credentials";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
    const admin = createServiceRoleClient();
    const url = new URL(req.url);
    const keyword = url.searchParams.get("keyword") || "AHL";
    const bpid = url.searchParams.get("bpid") || "1198859879988526";

    const logs: string[] = [];
    logs.push(`Diagnostic Run: Keyword='${keyword}', BPID='${bpid}'`);

    // 1. Fetch credentials
    const token = await getCredential("webhook_internal_token");
    logs.push(`Credential WEBHOOK_INTERNAL_TOKEN: ${token ? "SET (length: " + token.length + ")" : "MISSING!"}`);

    // 2. Fetch flows for this BPID
    const { data: flows, error: flowsErr } = await admin
        .from("trigger_flows")
        .select("id, name, business_phone_number_id, trigger_type, trigger_config, start_node_id, priority, enabled")
        .eq("business_phone_number_id", bpid)
        .eq("enabled", true)
        .order("priority", { ascending: true });

    if (flowsErr) {
        logs.push(`DB Error fetching flows: ${flowsErr.message}`);
        return NextResponse.json({ logs });
    }

    logs.push(`Found ${flows?.length} enabled flows for BPID ${bpid}.`);

    let matchedFlow = null;
    for (const f of flows || []) {
        logs.push(`checking flow: ${f.name} (type: ${f.trigger_type}, startNodeId: ${f.start_node_id})`);

        if (f.trigger_type !== "keyword") {
            logs.push(`  -> skipped (not keyword)`);
            continue;
        }

        if (!f.start_node_id) {
            logs.push(`  -> skipped (no start_node_id)`);
            continue;
        }

        const cfg = f.trigger_config;
        const phrases = (cfg.phrases ?? []).map((p: string) => p.trim().toLowerCase()).filter(Boolean);
        const mode = cfg.match ?? "contains";
        const t = keyword.trim().toLowerCase();

        logs.push(`  -> evaluating keyword config: mode='${mode}', phrases=[${phrases.join()}] against input='${t}'`);

        let match = false;
        for (const p of phrases) {
            const res = mode === "exact" ? t === p : mode === "starts" ? t.startsWith(p) : t.includes(p);
            if (res) { match = true; break; }
        }

        if (match) {
            logs.push(`  -> MET MATCH CONDITION!`);
            matchedFlow = f;
            break;
        } else {
            logs.push(`  -> DID NOT MATCH.`);
        }
    }

    if (!matchedFlow) {
        logs.push(`CONCLUSION: No flow matched the keyword ${keyword}. The trigger engine correctly ignored it.`);
        // Fetch a contact to check recent messages
        const { data: recentMsg } = await admin.from("messages").select("timestamp").limit(2);
        logs.push(`Is wait_reply active? (omitted stringency to see match config)`);
    } else {
        logs.push(`CONCLUSION: Flow '${matchedFlow.name}' matched!`);
        logs.push(`Checking first node ID: ${matchedFlow.start_node_id}`);
        const { data: firstNode } = await admin.from("trigger_nodes").select("id, node_type, config, next_node_id").eq("id", matchedFlow.start_node_id).single();
        if (!firstNode) {
            logs.push(`ERROR: start_node_id ${matchedFlow.start_node_id} DOES NOT EXIST IN DB! The flow literally crashes here.`);
        } else {
            logs.push(`SUCCESS: First node exists. Type: ${firstNode.node_type}. Config: ${JSON.stringify(firstNode.config)}`);

            const origin = process.env.INTERNAL_TICK_BASE || `http://127.0.0.1:${process.env.PORT || "3000"}`;
            logs.push(`If this node calls callSend(), it will fetch from: ${origin}/api/send-message`);

            try {
                const testOrigin = await fetch(`${origin}/api/healthz`, { signal: AbortSignal.timeout(2000) });
                logs.push(`Testing internal loopback: ${testOrigin.status} OK`);
            } catch (err: any) {
                logs.push(`CRITICAL LOOPBACK FAILURE: The VPS cannot reach its own ${origin}! Error: ${err.message}`);
            }
        }
    }

    return NextResponse.json({ logs });
}
