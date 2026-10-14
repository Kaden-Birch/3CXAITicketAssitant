import React, { useEffect, useRef, useState } from "react";
type Request = (path: string, method?: string, body?: unknown) => Promise<any>;
export function DemoCall({ request }: { request: Request }) {
  const [config, setConfig] = useState<any>(null),
    [mode, setMode] = useState<"preview" | "live_test">("preview"),
    [customer, setCustomer] = useState(""),
    [phase, setPhase] = useState("idle"),
    [error, setError] = useState(""),
    [snapshot, setSnapshot] = useState<any>(null),
    [muted, setMuted] = useState(false);
  const peer = useRef<RTCPeerConnection | null>(null),
    mic = useRef<MediaStream | null>(null),
    call = useRef<string | null>(null),
    poll = useRef<ReturnType<typeof setInterval> | null>(null),
    audio = useRef<HTMLAudioElement | null>(null),
    generation = useRef(0),
    alive = useRef(true),
    inFlight = useRef(false);
  const release = () => {
    if (poll.current) clearInterval(poll.current);
    poll.current = null;
    mic.current?.getTracks().forEach((t) => t.stop());
    mic.current = null;
    const pc = peer.current;
    peer.current = null;
    if (pc) {
      pc.onconnectionstatechange = null;
      pc.close();
    }
    if (audio.current) audio.current.srcObject = null;
    setMuted(false);
  };
  const stop = async () => {
    generation.current++;
    release();
    const id = call.current;
    call.current = null;
    setPhase("ended");
    if (id)
      try {
        await request(`/demo-calls/${id}/end`, "POST");
        const s = await request(`/demo-calls/${id}`);
        if (alive.current) setSnapshot(s);
      } catch {
        if (alive.current)
          setError(
            "The microphone is stopped. Server cleanup could not be confirmed; the call will time out.",
          );
      }
  };
  useEffect(() => {
    alive.current = true;
    request("/demo-calls/status")
      .then(setConfig)
      .catch(() => setError("Could not load demo-call configuration."));
    return () => {
      alive.current = false;
      generation.current++;
      release();
      const id = call.current;
      call.current = null;
      if (id) void request(`/demo-calls/${id}/end`, "POST").catch(() => {});
    };
  }, []);
  const start = async () => {
    const run = ++generation.current;
    setError("");
    setSnapshot(null);
    setPhase("connecting");
    let created: string | null = null;
    let connectionTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof RTCPeerConnection === "undefined"
      )
        throw new Error(
          "This browser cannot make audio calls. Open the app in Chrome or another WebRTC-capable browser using localhost or HTTPS.",
        );
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (run !== generation.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      mic.current = stream;
      const pc = new RTCPeerConnection();
      peer.current = pc;
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      pc.ontrack = (e) => {
        if (audio.current) {
          audio.current.srcObject = e.streams[0];
          void audio.current.play().catch(() => {
            if (alive.current)
              setError(
                "Your browser paused audio playback. Press Play in the audio control below.",
              );
          });
        }
      };
      const channel = pc.createDataChannel("oai-events");
      let readyResolve: () => void = () => {},
        readyReject: (e: Error) => void = () => {};
      const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });
      // Provider setup can take longer than the ICE handshake. Start its timer after the SDP answer arrives.
      void ready.catch(() => {});
      channel.onopen = () => {
        if (connectionTimer) clearTimeout(connectionTimer);
        readyResolve();
      };
      channel.onerror = () => {
        if (connectionTimer) clearTimeout(connectionTimer);
        readyReject(new Error("The audio control channel could not connect."));
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const response = await request("/demo-calls", "POST", {
        sdp: offer.sdp,
        writeMode: mode,
        ...(mode === "live_test" ? { testCustomerId: customer } : {}),
      });
      created = response.id;
      if (run !== generation.current) {
        await request(`/demo-calls/${created}/end`, "POST");
        if (connectionTimer) clearTimeout(connectionTimer);
        return;
      }
      call.current = created;
      connectionTimer = setTimeout(
        () =>
          readyReject(
            new Error(
              "Audio connection timed out. Check microphone access and network connectivity.",
            ),
          ),
        20000,
      );
      await pc.setRemoteDescription({ type: "answer", sdp: response.sdp });
      await ready;
      if (run !== generation.current) return;
      await request(`/demo-calls/${created}/activate`, "POST");
      setPhase("active");
      setSnapshot(await request(`/demo-calls/${created}`));
      pc.onconnectionstatechange = () => {
        if (
          ["failed", "closed", "disconnected"].includes(pc.connectionState) &&
          call.current
        ) {
          setError("The browser audio connection ended.");
          void stop();
        }
      };
      poll.current = setInterval(() => {
        if (inFlight.current || !call.current) return;
        inFlight.current = true;
        request(`/demo-calls/${call.current}/heartbeat`, "POST")
          .then((s) => {
            if (!alive.current) return;
            setSnapshot(s);
            if (s.status === "ended" || s.status === "failed") {
              release();
              call.current = null;
              setPhase(s.status);
            }
          })
          .catch(() => {
            if (alive.current) {
              setError(
                "Lost contact with the application. Microphone stopped.",
              );
              void stop();
            }
          })
          .finally(() => {
            inFlight.current = false;
          });
      }, 4000);
    } catch (e) {
      if (connectionTimer) clearTimeout(connectionTimer);
      if (run !== generation.current) return;
      release();
      if (created) {
        call.current = created;
        await stop();
      }
      setPhase("failed");
      setError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Microphone access was denied. Allow microphone access for this site, or open the app in Chrome."
          : (e as Error).message.replaceAll("_", " "),
      );
    }
  };
  const active = ["connecting", "active"].includes(phase);
  return (
    <section className="card demo-call">
      <div className="detail-head">
        <div>
          <p className="eyebrow">BROWSER VOICE TEST</p>
          <h2>Call {config?.agentName ?? "Ryan"} from your browser</h2>
        </div>
        <span className="badge">{phase}</span>
      </div>
      <p className="muted">
        Test the saved greeting, prompt, follow-up questions and ticket intake
        using your microphone. No 3CX connection is needed.
      </p>
      <div className="banner">
        Uses your OpenAI account and live Syncro lookups. OpenAI usage charges
        apply. Use test information; audio is not recorded. Calls end after five
        minutes.
      </div>
      {phase === "active" && typeof snapshot?.remainingSeconds === "number" && (
        <p
          role="status"
          className={snapshot.remainingSeconds <= 60 ? "warning" : "muted"}
        >
          Demo time remaining: {Math.floor(snapshot.remainingSeconds / 60)}:
          {String(snapshot.remainingSeconds % 60).padStart(2, "0")}
          {snapshot.remainingSeconds <= 60
            ? " — This test will end automatically. Collected details remain in call history."
            : ""}
        </p>
      )}
      {snapshot?.endReason && phase !== "active" && (
        <p role="status" className="warning">
          {["duration_limit", "timeout"].includes(snapshot.endReason)
            ? "The demo reached its five-minute limit. Collected details remain in call history; a draft is not a submitted ticket."
            : snapshot.endReason === "heartbeat_timeout"
              ? "The demo ended because the browser stopped checking in."
              : "The demo call has ended."}
        </p>
      )}
      {config && !config.ready && (
        <p role="status">
          {config.enabled
            ? "Save an OpenAI key, a Realtime model and voice, plus a Syncro key and tenant in Connections before starting."
            : "Browser demo calls are disabled by the host."}
        </p>
      )}
      <fieldset disabled={active}>
        <legend>Ticket mode</legend>
        <label className="radio-line">
          <input
            type="radio"
            name="ticket-mode"
            checked={mode === "preview"}
            onChange={() => setMode("preview")}
          />
          Demo ticket only — create a local preview
        </label>
        <label className="radio-line">
          <input
            type="radio"
            name="ticket-mode"
            checked={mode === "live_test"}
            disabled={config?.ticketCreationEnabled === false}
            onChange={() => setMode("live_test")}
          />
          Create a real test ticket in Syncro
        </label>
        {mode === "live_test" && (
          <>
            <label>
              Syncro test customer ID
              <input
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
                inputMode="numeric"
                pattern="[0-9]+"
                placeholder="Numeric organization ID, for example 123456"
              />
              <small>
                Use the numeric ID from the organization's Syncro URL, not its
                name or a ticket number.
              </small>
              {customer && !/^\d+$/.test(customer) && (
                <p role="alert">Enter a numeric customer ID.</p>
              )}
            </label>
            <div className="warning">
              This mode can create one real ticket under the customer ID above
              after spoken confirmation. It is labelled [BROWSER TEST]. Ticket
              comments request no email, but your Syncro automations may still
              run.
            </div>
          </>
        )}
      </fieldset>
      <div className="actions">
        <button
          disabled={
            active ||
            !config?.ready ||
            (mode === "live_test" && config?.ticketCreationEnabled === false) ||
            (mode === "live_test" && !/^\d+$/.test(customer))
          }
          onClick={() => void start()}
        >
          {phase === "connecting" ? "Connecting…" : "Start demo call"}
        </button>
        <button
          className="secondary"
          disabled={!active}
          onClick={() => void stop()}
        >
          End call
        </button>
        <button
          className="secondary"
          disabled={phase !== "active"}
          onClick={() => {
            const next = !muted;
            mic.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
            setMuted(next);
          }}
        >
          {muted ? "Unmute microphone" : "Mute microphone"}
        </button>
        <button
          className="ghost"
          disabled={active}
          onClick={() =>
            request("/demo-calls/status")
              .then(setConfig)
              .catch(() => setError("Could not refresh settings."))
          }
        >
          Refresh settings
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <audio ref={audio} autoPlay controls aria-label="Ryan call audio" />
      {snapshot && (
        <>
          <p className="muted mono">
            Call {snapshot.id} · {snapshot.session.outcome}
          </p>
          <h3>Conversation</h3>
          {!snapshot.turns.length && (
            <p className="muted">
              Waiting for available finalized transcript turns…
            </p>
          )}
          {snapshot.turns.map((t: any) => (
            <div className={"turn " + t.speaker} key={t.id}>
              <small>
                {t.speaker === "assistant" ? config.agentName : "You"}
              </small>
              <p>{t.text_redacted}</p>
            </div>
          ))}
          {snapshot.draft && (
            <section className="ticket-preview">
              <h3>
                {snapshot.draft.result
                  ? "Real test ticket created"
                  : "Ticket preview"}
              </h3>
              <p>Status: {snapshot.draft.status.replaceAll("_", " ")}</p>
              {snapshot.draft.result && (
                <p>
                  Syncro ticket number:{" "}
                  <strong>{snapshot.draft.result.ticket_number}</strong>
                </p>
              )}
              <p>
                <strong>{snapshot.draft.content.summary}</strong>
              </p>
              <p>{snapshot.draft.content.details}</p>
              <p>
                {snapshot.draft.content.clinic} ·{" "}
                {snapshot.draft.content.callerName} ·{" "}
                {snapshot.draft.content.callbackNumber}
                {snapshot.draft.content.callbackExtension
                  ? ` ext. ${snapshot.draft.content.callbackExtension}`
                  : ""}
              </p>
              {snapshot.draft.status === "unknown_outcome" && (
                <div className="warning">
                  Outcome unknown. Review Syncro using the call reference above.
                  The application will not retry this write.
                </div>
              )}
            </section>
          )}
          <details>
            <summary>Call events and response timing</summary>
            <p className="muted">
              Timing begins when the provider detects speech ending, which may
              follow a pause. Transcription, response creation, playback and
              tool waits are measured separately.
            </p>
            {snapshot.events.map((e: any, i: number) => (
              <p key={i}>
                <small>
                  {e.event_type} · {new Date(e.event_time).toLocaleTimeString()}
                </small>
                <br />
                {e.public_summary}
              </p>
            ))}
          </details>
        </>
      )}
    </section>
  );
}
