"use client";

// Global incoming-call overlay for WhatsApp Cloud Calling.
//
// Mounted once in the dashboard layout. Watches the `whatsapp_calls`
// table (realtime + 4s polling fallback) and, the moment a row enters
// the "ringing" state, surfaces a fullscreen-ish ringing card. The
// operator can Accept or Reject; on Accept we run the full WebRTC
// handshake against Meta:
//
//   getUserMedia(audio)
//     → RTCPeerConnection.addTrack(localAudio)
//     → setRemoteDescription(offer-from-webhook)
//     → createAnswer + setLocalDescription
//     → wait for ICE gathering complete (no trickle)
//     → POST answer SDP to /api/whatsapp-call/respond, action="accept"
//
// Once Meta delivers audio packets, ontrack fires and the remote
// stream is piped to a hidden <audio autoplay> element. End-of-call
// is driven by the webhook flipping status → terminated/rejected;
// the realtime listener tears the connection down.
//
// Outbound calling (operator-initiated dial) lives in a sibling
// "OutboundDialer" flow — this component only handles inbound legs
// and the "active call" UI shared by both directions.

import { useCallback, useEffect, useRef, useState } from "react";
import { Phone, PhoneOff, Mic, MicOff, X } from "lucide-react";
import { createBrowserClient } from "@/lib/supabase/client";
import { subscribeWaCallDial } from "@/lib/call-events";
import { cn } from "@/lib/utils";
import { formatPhone } from "@/lib/phone";
import { useNameOrPhoneMasker } from "@/components/PermissionsContext";

interface ActiveCall {
  id: string;
  wa_call_id: string;
  contact_id: string | null;
  business_phone_number_id: string | null;
  direction: "inbound" | "outbound";
  status: "ringing" | "accepted" | "rejected" | "terminated" | "missed" | "failed";
  sdp_offer: string | null;
  sdp_answer: string | null;
  start_at: string;
  contacts?: {
    id: string;
    name: string | null;
    profile_name: string | null;
    wa_id: string;
    avatar_url: string | null;
    lsq_lead_number?: string | null;
  } | null;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

export function CallOverlay() {
  const maskName = useNameOrPhoneMasker();
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [phase, setPhase] = useState<
    "idle" | "ringing" | "connecting" | "dialing" | "in-call" | "ending"
  >("idle");
  // The outbound dial flow runs locally for several seconds before
  // a `whatsapp_calls` row exists. We surface a placeholder so the
  // operator sees "Calling…" instead of nothing while we collect mic
  // audio + create the offer + roundtrip Meta.
  const [pendingDial, setPendingDial] = useState<{
    contactId: string;
    contactName?: string | null;
  } | null>(null);
  // Once /dial returns the wa_call_id, we remember it so realtime
  // updates for the SAME call (sdp_answer arriving via webhook) flow
  // back into the active peer connection.
  const dialingCallIdRef = useRef<string | null>(null);
  // Tracks whether we've already pushed the remote SDP into the peer
  // connection. The webhook arrives once but realtime can fire the
  // row multiple times — guard against re-applying the answer.
  const remoteSetRef = useRef<boolean>(false);
  // True once /active has returned a non-null row for the current
  // attempt. Lets us distinguish "the row hasn't been written yet"
  // (don't tear down — happens between /dial returning and the next
  // refetch) from "the row was filtered out by status" (tear down —
  // means rejected/terminated/missed). Without this the outbound
  // dialog stays pinned after the patient declines.
  const everSawCallRef = useRef<boolean>(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  // Track the wa_call_id we've already wired so realtime updates for
  // the same call don't re-trigger the answer flow.
  const handledCallIdRef = useRef<string | null>(null);
  // The call this agent locally dismissed (the "close" button on an
  // incoming ring). Dismissing only hides the banner + silences the ring
  // for THIS agent — it never accepts or rejects, so the call stays live
  // for whoever it's for. Tracked as BOTH a ref (so the polling/realtime
  // refetch closure reads the current value synchronously and keeps the
  // row suppressed) AND state (so the ringtone effect reacts and never
  // rings a dismissed call). Cleared the moment that call stops ringing,
  // so the NEXT call always rings.
  const dismissedIdRef = useRef<string | null>(null);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  // Web-Audio ringtone — synthesised so we don't need to host a file.
  // Plays a classic two-tone phone ring (440 + 480 Hz) gated 2s on /
  // 4s off while the overlay is in the "ringing" phase.
  const ringCtxRef = useRef<AudioContext | null>(null);
  const ringNodesRef = useRef<{
    oscA: OscillatorNode;
    oscB: OscillatorNode;
    gain: GainNode;
    interval: number;
  } | null>(null);
  // Recording — built once in handleAccept, drained on terminate.
  // We mix local + remote streams via Web Audio so a single MediaRecorder
  // captures both halves of the conversation in one webm/opus blob.
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const mixCtxRef = useRef<AudioContext | null>(null);
  // Snapshot the in-flight call id at accept-time so the cleanup
  // teardown can patch the right row even if `call` has already
  // flipped to null by then.
  const recordingForCallIdRef = useRef<string | null>(null);
  // Wall-clock at which MediaRecorder.start() actually fired. Used
  // to report the recording's true duration to the server so the
  // history page's "Talk time" matches the audio length exactly.
  const recordingStartedAtRef = useRef<number | null>(null);

  // ---- Fetch the current active call (single source of truth) ----
  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/whatsapp-call/active", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const json = (await res.json()) as { call: ActiveCall | null };
      const incoming = json.call;
      // A dismiss mutes ONLY the call that was on screen, and ONLY while it
      // is still ringing. The moment it ends / is answered / a different
      // call becomes the active one, forget the dismissal so the NEXT call
      // — even from the same person — rings normally. Without this clear,
      // the dismissed id lingered and a follow-up call never showed.
      if (!incoming || incoming.status !== "ringing") {
        if (dismissedIdRef.current !== null) {
          dismissedIdRef.current = null;
          setDismissedId(null);
        }
      }
      if (
        incoming &&
        incoming.status === "ringing" &&
        dismissedIdRef.current === incoming.wa_call_id
      ) {
        setCall(null);
        return;
      }
      setCall(incoming);
      // Fallback — if the call has a contact_id but the joined contacts
      // object came back empty (happens when the webhook inserts the
      // call row before the contact upsert commits), pull the contact
      // directly so the popup shows name + lead # instead of a bare
      // "Calling…".
      if (json.call?.contact_id && !json.call.contacts) {
        const cid = json.call.contact_id;
        try {
          const supabase = createBrowserClient();
          const { data: contactRow } = await supabase
            .from("contacts")
            .select("id, name, profile_name, wa_id, avatar_url, lsq_lead_number")
            .eq("id", cid)
            .maybeSingle();
          if (contactRow) {
            setCall((prev) =>
              prev && prev.id === json.call!.id
                ? { ...prev, contacts: contactRow as ActiveCall["contacts"] }
                : prev,
            );
          }
        } catch {
          /* ignore — popup degrades gracefully to "Calling…" */
        }
      }
    } catch {
      /* network blips are fine — next poll will catch up */
    }
  }, []);

  useEffect(() => {
    void refetch();
    const supabase = createBrowserClient();
    const channel = supabase
      .channel("whatsapp-calls-overlay")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "whatsapp_calls" },
        () => {
          void refetch();
        },
      )
      .subscribe();

    const off = subscribeWaCallDial((p) => {
      void handleDial(p);
    });

    // Polling fallback — realtime can be silently dropped (RLS,
    // websocket churn). 4s tick keeps the overlay self-healing.
    const poll = setInterval(refetch, 4000);
    return () => {
      clearInterval(poll);
      off();
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refetch]);

  // ---- Drive UI phase off the call row's status ----
  useEffect(() => {
    if (!call) {
      // /active returned null. Two cases:
      //   1. The row hasn't been written yet (handleDial just kicked
      //      off, /dial still in flight) — `everSawCallRef` is false,
      //      so we keep the "dialing" placeholder.
      //   2. We previously had a row and now /active filters it out
      //      because status flipped to rejected/terminated/missed —
      //      `everSawCallRef` is true, so tear down everything.
      if (everSawCallRef.current) {
        everSawCallRef.current = false;
        teardownPeer();
        setPhase("idle");
        setCallStartedAt(null);
        setPendingDial(null);
        handledCallIdRef.current = null;
        return;
      }
      if (phase !== "idle" && phase !== "dialing") teardownPeer();
      if (phase !== "dialing") {
        setPhase("idle");
        setCallStartedAt(null);
        handledCallIdRef.current = null;
      }
      return;
    }
    everSawCallRef.current = true;
    // Outbound: feed the SDP answer (when webhook delivers it) into
    // our existing peer connection. Status walks ringing → accepted
    // once the user picks up.
    if (
      call.direction === "outbound" &&
      call.sdp_answer &&
      pcRef.current &&
      !remoteSetRef.current
    ) {
      remoteSetRef.current = true;
      void pcRef.current
        .setRemoteDescription({ type: "answer", sdp: call.sdp_answer })
        .catch((e) => {
          console.warn("[call] setRemoteDescription failed:", e);
        });
    }
    if (call.status === "ringing") {
      setPhase((p) =>
        p === "in-call" || p === "connecting" || p === "dialing" ? p : "ringing",
      );
    } else if (call.status === "accepted") {
      // Flip the dialog UI immediately so the agent sees acceptance,
      // but DO NOT start the duration counter here — that waits for
      // the remote audio track to actually unmute (real media flow).
      // Without this guard the timer ticks during the brief gap
      // between Meta's accept event and the patient's mic actually
      // opening.
      setPhase("in-call");
      setPendingDial(null);
    } else if (
      call.status === "rejected" ||
      call.status === "terminated" ||
      call.status === "missed" ||
      call.status === "failed"
    ) {
      teardownPeer();
      setPhase("idle");
      setCallStartedAt(null);
      setPendingDial(null);
      handledCallIdRef.current = null;
      setTimeout(() => setCall(null), 600);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call?.status, call?.wa_call_id, call?.sdp_answer, call?.direction]);

  // ---- Tick a 1Hz timer while in-call, for the elapsed display ----
  useEffect(() => {
    if (phase !== "in-call") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // ---- Ringtone / ringback: synthesised, loops while the call rings --
  //   • Inbound  → "incoming call" ring to alert the agent.
  //   • Outbound → ringback so the agent hears the line ringing while
  //     the patient's phone rings, instead of dead silence until they
  //     answer. Stops the instant they pick up (phase → "in-call" on
  //     real media flow). The ringback is local-only (own AudioContext
  //     → speakers), never added to the peer connection or recording.
  useEffect(() => {
    const inboundRing =
      phase === "ringing" &&
      call?.direction === "inbound" &&
      // Never ring a call this agent has dismissed.
      call?.wa_call_id !== dismissedId;
    const outboundRingback =
      phase === "dialing" ||
      (phase === "ringing" && call?.direction === "outbound");
    if (!inboundRing && !outboundRingback) {
      stopRingtone();
      return;
    }
    startRingtone();
    return () => stopRingtone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, call?.direction, call?.wa_call_id, dismissedId]);

  function startRingtone() {
    if (ringNodesRef.current) return; // already ringing
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) return;
      const ctx = ringCtxRef.current ?? new Ctx();
      ringCtxRef.current = ctx;
      // Some browsers suspend AudioContext until a user gesture. Try
      // resume; if it fails (no prior interaction), the ring stays
      // silent — visual banner still notifies.
      void ctx.resume().catch(() => {});

      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(ctx.destination);

      const oscA = ctx.createOscillator();
      oscA.frequency.value = 440;
      oscA.type = "sine";
      oscA.connect(gain);

      const oscB = ctx.createOscillator();
      oscB.frequency.value = 480;
      oscB.type = "sine";
      oscB.connect(gain);

      oscA.start();
      oscB.start();

      // 2s on / 4s off cadence, repeating. Use setInterval at 6s and
      // a paired delayed-stop to avoid drift between cycles.
      const cycle = () => {
        const t = ctx.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.18, t + 0.05);
        gain.gain.setValueAtTime(0.18, t + 2.0);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 2.05);
      };
      cycle();
      const interval = window.setInterval(cycle, 6000);
      ringNodesRef.current = { oscA, oscB, gain, interval };
    } catch {
      /* audio not available — silent fallback */
    }
  }

  function stopRingtone() {
    const nodes = ringNodesRef.current;
    if (!nodes) return;
    try {
      window.clearInterval(nodes.interval);
      nodes.gain.gain.cancelScheduledValues(0);
      nodes.gain.gain.setValueAtTime(0, 0);
      nodes.oscA.stop();
      nodes.oscB.stop();
      nodes.oscA.disconnect();
      nodes.oscB.disconnect();
      nodes.gain.disconnect();
    } catch {
      /* ignore — already torn down */
    }
    ringNodesRef.current = null;
  }

  function teardownPeer() {
    // Stop the recorder first so the final dataavailable fires before
    // we close streams underneath it. flushRecording resolves once the
    // blob is uploaded; we don't await it here because teardown is
    // sync — the upload runs in the background.
    void flushRecording();
    try {
      pcRef.current?.close();
    } catch {
      /* ignore */
    }
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
    dialingCallIdRef.current = null;
    remoteSetRef.current = false;
  }

  // ---- Outbound dial flow ----
  // Triggered by ChatToolbar dispatching a window event after
  // /initiate confirmed permission is in place. We collect mic
  // audio, build the SDP offer ourselves, and POST it to /dial,
  // which forwards to Meta's /calls?action=connect endpoint. The
  // user's WhatsApp rings; when they pick up, the webhook delivers
  // an `accept` event with the answer SDP, which we pick up via
  // the active-call refetch loop and feed into the peer connection.
  async function handleDial(p: { contactId: string; contactName?: string | null }) {
    if (phase !== "idle" && phase !== "ending") {
      // Already on a call — refuse to dial a second one.
      setError("End the current call before placing another.");
      return;
    }
    setError(null);
    setPendingDial({ contactId: p.contactId, contactName: p.contactName ?? null });
    setPhase("dialing");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
    } catch (e) {
      setError(
        e instanceof Error
          ? `Microphone access denied: ${e.message}`
          : "Microphone access denied",
      );
      setPhase("idle");
      setPendingDial(null);
      return;
    }
    localStreamRef.current = stream;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;
    stream.getAudioTracks().forEach((t) => pc.addTrack(t, stream));
    pc.ontrack = (ev) => {
      const [remote] = ev.streams;
      if (remoteAudioRef.current && remote) {
        remoteAudioRef.current.srcObject = remote;
        void remoteAudioRef.current.play().catch(() => {});
      }
      // We listen for "actual audio flowing" via track.unmute, NOT
      // pc.connectionState. ICE+DTLS can establish (state="connected")
      // before the patient picks up — the track stays muted until
      // their mic opens, which is the real "answered" signal. Without
      // this, the duration counter ticks during ring time.
      const onAnswered = () => {
        setPhase("in-call");
        setCallStartedAt((existing) => existing ?? Date.now());
        setPendingDial(null);
        startRecording(stream, remote);
        const id = dialingCallIdRef.current ?? call?.wa_call_id ?? null;
        if (id) {
          void fetch(`/api/whatsapp-call/${encodeURIComponent(id)}/connected`, {
            method: "POST",
          }).catch(() => {});
        }
      };
      remote?.getTracks().forEach((t) => {
        if (!t.muted) onAnswered();
        else t.addEventListener("unmute", onAnswered);
        t.addEventListener("ended", () => localClear());
      });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        localClear();
      }
    };

    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await waitForIceGatheringComplete(pc);
      const finalSdp = pc.localDescription?.sdp;
      if (!finalSdp) throw new Error("No local SDP produced");

      const res = await fetch("/api/whatsapp-call/dial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: p.contactId,
          sdp_offer: finalSdp,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        wa_call_id?: string;
        error?: string;
      };
      if (!res.ok || !json.ok || !json.wa_call_id) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      dialingCallIdRef.current = json.wa_call_id;
      // Refetch right away — the row should now be visible to /active.
      void refetch();
    } catch (e) {
      teardownPeer();
      setError(e instanceof Error ? e.message : "Dial failed");
      setPhase("idle");
      setPendingDial(null);
    }
  }

  function startRecording(local: MediaStream, remote: MediaStream) {
    if (recorderRef.current) return;
    if (typeof MediaRecorder === "undefined") return;
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctx();
      mixCtxRef.current = ctx;
      const dest = ctx.createMediaStreamDestination();
      try {
        ctx.createMediaStreamSource(local).connect(dest);
      } catch {
        /* local audio missing — record remote-only */
      }
      try {
        ctx.createMediaStreamSource(remote).connect(dest);
      } catch {
        /* remote audio missing — recorder will be silent on that side */
      }

      // Pick the first MIME the browser will accept. webm/opus is
      // universal on Chromium; Safari prefers mp4/aac.
      const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/ogg;codecs=opus",
      ];
      const mime =
        candidates.find((m) => MediaRecorder.isTypeSupported(m)) || "";
      const recorder = mime
        ? new MediaRecorder(dest.stream, { mimeType: mime })
        : new MediaRecorder(dest.stream);
      recordedChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      // 1s timeslice keeps memory bounded and means partial captures
      // survive a page crash mid-call.
      recorder.start(1000);
      recordingStartedAtRef.current = Date.now();
      recorderRef.current = recorder;
      // Outbound: ontrack fires inside a closure created when handleDial
      // ran — `call` was still null then. Fall back to the dial ref so
      // the recording is tagged with the correct wa_call_id and the
      // upload's bubble lands in the right thread.
      recordingForCallIdRef.current =
        call?.wa_call_id ?? dialingCallIdRef.current ?? null;
    } catch (e) {
      console.warn("[call] recording failed to start:", e);
    }
  }

  async function flushRecording() {
    const recorder = recorderRef.current;
    const callId = recordingForCallIdRef.current;
    const startedAt = recordingStartedAtRef.current;
    recorderRef.current = null;
    recordingForCallIdRef.current = null;
    recordingStartedAtRef.current = null;
    if (!recorder || !callId) {
      mixCtxRef.current?.close().catch(() => {});
      mixCtxRef.current = null;
      return;
    }
    // Wait for the final dataavailable. Stop is async — we hook
    // onstop and resolve a Promise so the upload sees the complete
    // chunk list.
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      try {
        recorder.stop();
      } catch {
        resolve();
      }
    });
    mixCtxRef.current?.close().catch(() => {});
    mixCtxRef.current = null;

    const chunks = recordedChunksRef.current;
    recordedChunksRef.current = [];
    if (!chunks.length) return;

    const mime = recorder.mimeType || "audio/webm";
    const blob = new Blob(chunks, { type: mime });
    // Drop sub-second clips — usually a connect/terminate race that
    // produced no real audio.
    if (blob.size < 4000) return;

    const form = new FormData();
    form.append(
      "file",
      blob,
      `call-${callId}.${mime.includes("mp4") ? "m4a" : "webm"}`,
    );
    form.append("mime", mime);
    if (startedAt) {
      // Wall-clock duration of the recorder. The server uses this to
      // OVERRIDE the webhook's accepted_at→end_at math so the audio
      // length and the displayed "talk time" are byte-identical
      // (no more 0:31 file with 0:28 talk time).
      form.append(
        "duration_ms",
        String(Math.max(0, Date.now() - startedAt)),
      );
    }
    try {
      const res = await fetch(
        `/api/whatsapp-call/${encodeURIComponent(callId)}/recording`,
        { method: "POST", body: form },
      );
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        console.warn("[call] recording upload failed:", res.status, t);
      }
    } catch (e) {
      console.warn("[call] recording upload error:", e);
    }
  }

  async function handleAccept() {
    if (!call || !call.sdp_offer) {
      setError("Missing SDP offer — the webhook may not have arrived yet.");
      return;
    }
    if (handledCallIdRef.current === call.wa_call_id) return;
    handledCallIdRef.current = call.wa_call_id;
    setError(null);
    setPhase("connecting");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
    } catch (e) {
      setError(
        e instanceof Error
          ? `Microphone access denied: ${e.message}`
          : "Microphone access denied",
      );
      handledCallIdRef.current = null;
      setPhase("ringing");
      return;
    }
    localStreamRef.current = stream;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;

    stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

    pc.ontrack = (ev) => {
      const [remote] = ev.streams;
      if (remoteAudioRef.current && remote) {
        remoteAudioRef.current.srcObject = remote;
        // Some browsers block autoplay until the user interacts; the
        // overlay click that triggered this counts as a gesture.
        void remoteAudioRef.current.play().catch(() => {});
      }
      // Inbound flow: operator already tapped Accept (handleAccept ran)
      // so the row is stamped server-side. Still gate the duration timer
      // + recording start on actual media flow (track.unmute) so a
      // dropped/ignored connection doesn't show a fake talk-time.
      const onAnswered = () => {
        setPhase("in-call");
        setCallStartedAt((existing) => existing ?? Date.now());
        startRecording(stream, remote);
      };
      remote?.getTracks().forEach((t) => {
        if (!t.muted) onAnswered();
        else t.addEventListener("unmute", onAnswered);
        t.addEventListener("ended", () => localClear());
      });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        localClear();
      }
    };

    try {
      await pc.setRemoteDescription({ type: "offer", sdp: call.sdp_offer });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Non-trickle ICE — wait until the gathered SDP is final, then
      // ship it as one blob. WhatsApp Cloud Calling does not currently
      // support out-of-band ICE candidates.
      await waitForIceGatheringComplete(pc);

      const finalSdp = pc.localDescription?.sdp;
      if (!finalSdp) throw new Error("No local SDP produced");

      const res = await fetch("/api/whatsapp-call/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          call_id: call.wa_call_id,
          action: "accept",
          sdp_answer: finalSdp,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      // Phase flips to "in-call" once the webhook confirms acceptance.
    } catch (e) {
      teardownPeer();
      setError(e instanceof Error ? e.message : "Accept failed");
      handledCallIdRef.current = null;
      setPhase("ringing");
    }
  }

  // Locally drop the overlay back to idle. We used to wait for Meta's
  // terminate/reject webhook to flip the row, but if that round-trip
  // is delayed (or our /respond races the row write), the dialog stays
  // pinned top-right after the call ends. Optimistic clear here means
  // the operator sees the overlay disappear the instant they click
  // End/Cancel/Reject — the realtime listener still reconciles.
  function localClear() {
    teardownPeer();
    setPhase("idle");
    setCall(null);
    setPendingDial(null);
    setCallStartedAt(null);
    handledCallIdRef.current = null;
    everSawCallRef.current = false;
    setError(null);
  }

  // Close the notification for THIS agent only — no accept, no reject.
  // The call keeps ringing for whoever it's actually routed to; it just
  // disappears from this agent's screen (useful when it's not their call).
  function handleDismiss() {
    if (!call) return;
    dismissedIdRef.current = call.wa_call_id;
    setDismissedId(call.wa_call_id);
    stopRingtone();
    setCall(null);
    setPhase("idle");
  }

  async function handleReject() {
    if (!call) return;
    setPhase("ending");
    try {
      await fetch("/api/whatsapp-call/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          call_id: call.wa_call_id,
          action: "reject",
        }),
      });
    } catch {
      /* webhook will still tear it down on Meta's timeout */
    }
    localClear();
  }

  async function handleTerminate() {
    if (!call) return;
    setPhase("ending");
    try {
      await fetch("/api/whatsapp-call/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          call_id: call.wa_call_id,
          action: "terminate",
        }),
      });
    } catch {
      /* fallthrough — local teardown still runs */
    }
    localClear();
  }

  // Functional update so the SAME toggle drives both the on-screen
  // button and the hardware/OS mute key (Media Session handler below)
  // without stale-closure races on `muted`. Also reflects the state to
  // the OS mic indicator so a hardware mute LED stays in sync.
  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      localStreamRef.current
        ?.getAudioTracks()
        .forEach((t) => (t.enabled = !next));
      try {
        (
          navigator.mediaSession as unknown as {
            setMicrophoneActive?: (active: boolean) => void;
          }
        ).setMicrophoneActive?.(!next);
      } catch {
        /* not supported — on-screen state still updates */
      }
      return next;
    });
  }, []);

  // ---- Hardware / OS mic-mute key support ----
  // Most headset mute buttons (and the OS mic-mute key / control-strip
  // toggle) don't actually cut the mic — they emit a "toggle microphone"
  // signal that Chrome surfaces through the Media Session API. Without a
  // registered handler the button does nothing to a WebRTC call. Wiring
  // it makes the physical mute button mute the live call, kept in lockstep
  // with the on-screen button.
  useEffect(() => {
    const active = phase === "in-call" || phase === "connecting";
    const ms =
      typeof navigator !== "undefined"
        ? (navigator.mediaSession as unknown as {
            setActionHandler?: (
              action: string,
              handler: (() => void) | null,
            ) => void;
          } | undefined)
        : undefined;
    if (!active || !ms || typeof ms.setActionHandler !== "function") return;
    try {
      ms.setActionHandler("togglemicrophone", () => toggleMute());
    } catch {
      /* action unsupported in this browser — on-screen button still works */
    }
    return () => {
      try {
        ms.setActionHandler?.("togglemicrophone", null);
      } catch {
        /* ignore */
      }
    };
  }, [phase, toggleMute]);

  // Two cases for "render the card": an active row OR a fresh dial
  // we kicked off locally that hasn't gotten a row yet. Without the
  // pendingDial branch, the operator sees nothing for ~1-2s after
  // clicking Call while the offer is being built.
  if (phase === "idle") return null;
  if (!call && !pendingDial) return null;

  const contactName =
    call?.contacts?.name?.trim() ||
    call?.contacts?.profile_name?.trim() ||
    (call?.contacts?.wa_id ? formatPhone(call.contacts.wa_id) : null) ||
    pendingDial?.contactName ||
    "Calling…";

  const elapsedSec = callStartedAt
    ? Math.max(0, Math.floor((now - callStartedAt) / 1000))
    : 0;
  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const ss = String(elapsedSec % 60).padStart(2, "0");

  const isOutboundDial =
    phase === "dialing" ||
    (phase === "ringing" && call?.direction === "outbound");
  // Patient-initiated ring → take over the full screen (with a dim
  // backdrop) so the agent can't miss it. Outbound dial + in-call
  // stay as the unobtrusive top-right card.
  const isInboundRinging = phase === "ringing" && call?.direction === "inbound";

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-[60] flex p-4",
          isInboundRinging
            ? "pointer-events-auto items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
            : "pointer-events-none items-start justify-end",
        )}
      >
        <div
          className={cn(
            "pointer-events-auto relative overflow-hidden rounded-2xl border bg-card shadow-2xl ring-1 ring-black/5",
            isInboundRinging
              ? "w-full max-w-md animate-in zoom-in-95 fade-in duration-200"
              : "w-[360px]",
            phase === "ringing" && !isInboundRinging
              ? "animate-in slide-in-from-top-4 fade-in duration-200"
              : "",
          )}
        >
          {/* Dismiss (close) — incoming ring only. Hides the banner for
              this agent without accepting OR rejecting, so the call stays
              live for whoever it's actually for. */}
          {isInboundRinging ? (
            <button
              type="button"
              onClick={handleDismiss}
              className="absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-white ring-1 ring-inset ring-white/30 transition hover:bg-white/30"
              aria-label="Close — hide this for you (doesn't reject the call)"
              title="Close — hides this notification for you. Doesn't reject the call."
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
          <div
            className={cn(
              "flex items-center gap-3 px-5 py-4",
              phase === "ringing" && call?.direction === "inbound"
                ? "bg-gradient-to-br from-emerald-500 to-emerald-600 text-white"
                : isOutboundDial
                  ? "bg-gradient-to-br from-blue-500 to-blue-600 text-white"
                  : phase === "in-call"
                    ? "bg-gradient-to-br from-slate-800 to-slate-900 text-white"
                    : "bg-secondary text-foreground",
            )}
          >
            <span
              className={cn(
                "inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white/20 ring-1 ring-inset ring-white/30",
                (phase === "ringing" || isOutboundDial) && "animate-pulse",
              )}
            >
              {call?.contacts?.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={call.contacts.avatar_url}
                  alt=""
                  className="h-full w-full rounded-full object-cover"
                />
              ) : (
                <Phone className="h-5 w-5" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] uppercase tracking-wider opacity-80">
                {isOutboundDial
                  ? "Calling on WhatsApp…"
                  : phase === "ringing"
                    ? "Incoming WhatsApp call"
                    : phase === "connecting"
                      ? "Connecting…"
                      : "On call"}
              </div>
              {/* Click → open the contact's chat in a new tab. Lets the
                  operator pull up history + reply mid-call without
                  losing the call overlay. */}
              {call?.contact_id ? (
                <a
                  href={`/dashboard?c=${encodeURIComponent(call.contact_id)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block truncate text-base font-semibold underline-offset-2 hover:underline"
                  title="Open chat in new tab"
                >
                  {maskName(contactName)}
                </a>
              ) : (
                <div className="truncate text-base font-semibold">
                  {maskName(contactName)}
                </div>
              )}
              {/* Lead identifier strip — during ringing / dial the phone
                  is useful (operator can confirm who's calling). Once
                  the call is CONNECTED, drop the phone and show only
                  the LSQ lead # — operators don't need to read the
                  number out mid-conversation and it looked noisy. */}
              <div className="truncate text-[11px] tabular-nums opacity-80">
                {phase === "in-call"
                  ? call?.contacts?.lsq_lead_number
                    ? `Lead #${call.contacts.lsq_lead_number}`
                    : ""
                  : [
                      call?.contacts?.wa_id ? `+${call.contacts.wa_id}` : "",
                      call?.contacts?.lsq_lead_number
                        ? `Lead #${call.contacts.lsq_lead_number}`
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
              </div>
              {phase === "in-call" ? (
                <div className="text-xs tabular-nums opacity-80">
                  {mm}:{ss}
                </div>
              ) : null}
            </div>
          </div>

          {error ? (
            <div className="border-b bg-rose-50 px-4 py-2 text-[11px] text-rose-700">
              {error}
            </div>
          ) : null}

          <div className="flex items-center justify-center gap-3 px-5 py-4">
            {phase === "ringing" && call?.direction === "inbound" ? (
              <>
                <button
                  type="button"
                  onClick={handleReject}
                  className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-rose-500 text-white shadow-md transition hover:bg-rose-600"
                  aria-label="Reject call"
                  title="Reject"
                >
                  <PhoneOff className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={handleAccept}
                  className="inline-flex h-12 items-center gap-2 rounded-full bg-emerald-500 px-6 text-sm font-semibold text-white shadow-md transition hover:bg-emerald-600"
                >
                  <Phone className="h-4 w-4" />
                  Accept
                </button>
              </>
            ) : phase === "in-call" || phase === "connecting" ? (
              <>
                <button
                  type="button"
                  onClick={toggleMute}
                  disabled={phase === "connecting"}
                  className={cn(
                    "inline-flex h-11 w-11 items-center justify-center rounded-full border shadow-sm transition disabled:opacity-50",
                    muted
                      ? "bg-amber-100 text-amber-800 border-amber-300"
                      : "bg-background text-foreground hover:bg-secondary",
                  )}
                  aria-label={muted ? "Unmute" : "Mute"}
                  title={muted ? "Unmute" : "Mute"}
                >
                  {muted ? (
                    <MicOff className="h-4 w-4" />
                  ) : (
                    <Mic className="h-4 w-4" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleTerminate}
                  className="inline-flex h-11 items-center gap-2 rounded-full bg-rose-500 px-5 text-sm font-semibold text-white shadow-md transition hover:bg-rose-600"
                >
                  <PhoneOff className="h-4 w-4" />
                  End call
                </button>
              </>
            ) : phase === "ending" ? (
              <span className="text-xs text-muted-foreground">Ending…</span>
            ) : isOutboundDial ? (
              <button
                type="button"
                onClick={() => {
                  if (call?.wa_call_id) {
                    void handleTerminate();
                  } else {
                    // Pre-row cancellation: tear down what we built
                    // locally and bail. The /dial roundtrip will
                    // resolve harmlessly even if the row never
                    // materialises.
                    teardownPeer();
                    setPhase("idle");
                    setPendingDial(null);
                  }
                }}
                className="inline-flex h-11 items-center gap-2 rounded-full bg-rose-500 px-5 text-sm font-semibold text-white shadow-md transition hover:bg-rose-600"
              >
                <X className="h-4 w-4" />
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
    </>
  );
}

function waitForIceGatheringComplete(
  pc: RTCPeerConnection,
  timeoutMs = 4000,
): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    }, timeoutMs);
    function check() {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    }
    pc.addEventListener("icegatheringstatechange", check);
  });
}
