import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { DemoCall } from "./DemoCall.tsx";
type Actor = { email: string; role: "admin" | "support"; csrf: string };
let csrf = "";
async function api(path: string, method = "GET", body?: unknown) {
  const r = await fetch("/api" + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    credentials: "same-origin",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const value = await r.json();
  if (!r.ok)
    throw new Error(
      value.error?.message ?? value.error?.code ?? "Request failed",
    );
  return value;
}
const fmt = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className={"badge " + String(children).replaceAll("_", "-")}>
      {String(children).replaceAll("_", " ")}
    </span>
  );
}
function App() {
  const [actor, setActor] = useState<Actor | null>(null),
    [setup, setSetup] = useState<boolean | null>(null),
    [demo, setDemo] = useState(true),
    [page, setPage] = useState("Overview"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message.replaceAll("_", " "));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page]);
  useEffect(() => {
    void run(async () => {
      const status = await api("/setup/status");
      setSetup(status.needsSetup);
      setDemo(status.demo);
      try {
        const u = await api("/auth/me");
        csrf = u.csrf;
        setActor(u);
      } catch {}
    });
  }, []);
  if (setup === null)
    return (
      <main className="auth">
        <h1>ChinookIT AI Receptionist</h1>
        <p>{error || "Loading…"}</p>
      </main>
    );
  if (!actor)
    return (
      <main className="auth">
        <div className="brandmark">C</div>
        <p className="eyebrow">CHINOOKIT · SUPPORT OPERATIONS</p>
        <h1>{setup ? "Set up your receptionist" : "Welcome back"}</h1>
        <p>
          {setup
            ? "Create the first administrator to configure Ryan and inspect call history."
            : "Sign in to your AI receptionist workspace."}
        </p>
        {demo && (
          <div className="banner">
            Sample history · browser demo calls available after setup
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void run(async () => {
              const u = await api(setup ? "/setup" : "/auth/login", "POST", {
                email: f.get("email"),
                password: f.get("password"),
                ...(setup ? { bootstrapToken: f.get("token") } : {}),
              });
              csrf = u.csrf;
              setActor(u);
              setPage("Overview");
              setSetup(false);
            });
          }}
        >
          {setup && (
            <label>
              First-run setup token
              <input name="token" type="password" autoComplete="off" required />
              <small>
                Read the bootstrap.token file on the application host.
              </small>
            </label>
          )}
          <label>
            Email
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              minLength={setup ? 14 : 1}
              maxLength={128}
              autoComplete={setup ? "new-password" : "current-password"}
              required
            />
            {setup && <small>Use at least 14 characters.</small>}
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button disabled={busy} type="submit">
            {busy ? "Working…" : setup ? "Create administrator" : "Sign in"}
          </button>
        </form>
      </main>
    );
  return (
    <div className="layout">
      <aside>
        <div className="wordmark">
          <span className="brandmark">C</span>
          <div>
            ChinookIT<small>AI Receptionist</small>
          </div>
        </div>
        <nav aria-label="Main navigation">
          {[
            "Overview",
            "Conversations",
            ...(actor.role === "admin"
              ? [
                  "Demo call",
                  "Connections",
                  "Agent settings",
                  "Users",
                  "Maintenance",
                ]
              : []),
          ].map((p) => (
            <button
              key={p}
              className={page === p ? "selected" : ""}
              onClick={() => {
                setPage(p);
                setError("");
                setNotice("");
              }}
            >
              {p}
            </button>
          ))}
        </nav>
        <div className="aside-bottom">
          <strong>{actor.email}</strong>
          <small>{actor.role}</small>
          <button
            className="ghost"
            onClick={() =>
              void run(async () => {
                await api("/auth/logout", "POST");
                csrf = "";
                setActor(null);
              })
            }
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header>
          <div>
            <p className="eyebrow">SUPPORT OPERATIONS</p>
            <h1>{page}</h1>
          </div>
          <Badge>{demo ? "demo mode" : "voice disabled"}</Badge>
        </header>
        <div className="banner">
          {demo
            ? "This workspace contains synthetic calls. Browser demo calls use configured APIs only when started; real test tickets require explicit selection."
            : "3CX calls remain disabled until the PBX integration checks and internal call test pass."}{" "}
          Target PBX: 3CX V20 Update 10.
        </div>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        {notice && (
          <div role="status" className="notice">
            {notice}
          </div>
        )}
        {page === "Demo call" && <DemoCall request={api} />}
        {page === "Overview" && <Overview run={run} navigate={setPage} />}
        {page === "Conversations" && (
          <Conversations run={run} admin={actor.role === "admin"} />
        )}
        {page === "Connections" && (
          <Connections run={run} notice={setNotice} busy={busy} />
        )}
        {page === "Agent settings" && (
          <Agent run={run} notice={setNotice} busy={busy} />
        )}
        {page === "Users" && <Users run={run} notice={setNotice} busy={busy} />}
        {page === "Maintenance" && <Maintenance run={run} />}
      </main>
    </div>
  );
}
type Run = { run: (fn: () => Promise<void>) => Promise<void> };
function Overview({ run, navigate }: Run & { navigate: (p: string) => void }) {
  const [m, setM] = useState<any>(null);
  useEffect(() => {
    void run(async () => setM(await api("/dashboard/metrics")));
  }, []);
  return (
    <>
      <div className="stats">
        <section>
          <small>Retained conversations</small>
          <strong>{m?.total ?? "—"}</strong>
          <span>All outcomes included</span>
        </section>
        <section>
          <small>Support assistant</small>
          <strong>{m?.agentName ?? "Ryan"}</strong>
          <span>One question at a time</span>
        </section>
        <section>
          <small>Voice connection</small>
          <strong className="smaller">Awaiting verification</strong>
          <span>Internal PBX test comes next</span>
        </section>
      </div>
      <div className="split">
        <section className="card">
          <h2>Build progress</h2>
          <ol className="steps">
            <li>
              <strong>Integration discovery</strong>
              <p>
                Official 3CX source pinned. Syncro schema saved. Live access
                checks pending.
              </p>
            </li>
            <li>
              <strong>Local foundation</strong>
              <p>
                Secure setup, encrypted connections and searchable conversation
                history.
              </p>
            </li>
            <li>
              <strong>Voice and ticket intake</strong>
              <p>
                Next: connect the pinned bridge, prove an internal call, then
                add Syncro writes.
              </p>
            </li>
          </ol>
          <button onClick={() => navigate("Demo call")}>
            Test Ryan in browser
          </button>{" "}
          <button className="secondary" onClick={() => navigate("Connections")}>
            Configure connections
          </button>
        </section>
        <section className="card">
          <h2>Conversation outcomes</h2>
          {m?.outcomes.map((o: any) => (
            <div className="outcome" key={o.outcome}>
              <Badge>{o.outcome}</Badge>
              <strong>{o.count}</strong>
            </div>
          ))}
          <p className="muted">
            Demo outcomes illustrate successful intake, transfers, disconnects
            and failed calls.
          </p>
        </section>
      </div>
    </>
  );
}
function Conversations({ run, admin }: Run & { admin: boolean }) {
  const [items, setItems] = useState<any[]>([]),
    [next, setNext] = useState<string | null>(null),
    [q, setQ] = useState(""),
    [outcome, setOutcome] = useState(""),
    [clinic, setClinic] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [detail, setDetail] = useState<any>(null),
    [events, setEvents] = useState<any[]>([]),
    [eventNext, setEventNext] = useState<number | null>(null),
    [tab, setTab] = useState("Conversation");
  const load = async (cursor?: string) => {
    const p = new URLSearchParams({ q, limit: "20" });
    if (outcome) p.set("outcome", outcome);
    if (clinic) p.set("clinic", clinic);
    if (from) p.set("from", new Date(from + "T00:00:00").toISOString());
    if (to) p.set("to", new Date(to + "T23:59:59").toISOString());
    if (cursor) p.set("cursor", cursor);
    const data = await api("/conversations?" + p);
    setItems(cursor ? (old) => [...old, ...data.items] : data.items);
    setNext(data.nextCursor);
  };
  useEffect(() => {
    void run(() => load());
  }, []);
  const open = async (id: string) => {
    setDetail(await api("/conversations/" + id));
    window.scrollTo(0, 0);
    const eventPage = await api("/conversations/" + id + "/events?limit=200");
    setEvents(eventPage.items);
    setEventNext(eventPage.nextAfter);
    setTab("Conversation");
  };
  if (detail)
    return (
      <>
        <button className="ghost back" onClick={() => setDetail(null)}>
          ← All conversations
        </button>
        <section className="card">
          <div className="detail-head">
            <div>
              <p className="eyebrow">
                {detail.session.source === "browser_demo"
                  ? "BROWSER DEMO CALL"
                  : detail.session.is_demo
                    ? "SYNTHETIC CALL"
                    : "CALL RECORD"}
              </p>
              <h2>{detail.session.clinic_name}</h2>
              <p>
                {fmt(detail.session.started_at)} ·{" "}
                {detail.session.caller_number_masked}
              </p>
            </div>
            <Badge>{detail.session.outcome}</Badge>
          </div>
          <p className="muted mono">{detail.session.id}</p>
          <div className="tabs">
            {["Conversation", "Ticket", "Technical events"].map((t) => (
              <button
                key={t}
                className={tab === t ? "selected" : ""}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          {tab === "Conversation" && (
            <>
              <p className="muted">
                Transcript status: {detail.session.transcript_status}. Automated
                redaction is imperfect.
              </p>
              {detail.turns.map((t: any) => (
                <div key={t.id} className={"turn " + t.speaker}>
                  <small>
                    {t.speaker === "assistant" ? detail.agent.name : "Caller"}{" "}
                    {t.is_interrupted ? "· interrupted" : ""}
                  </small>
                  <p>{t.text_redacted}</p>
                </div>
              ))}
              {detail.truncated && (
                <button
                  onClick={() =>
                    void run(async () => {
                      const turnPage = await api(
                        `/conversations/${detail.session.id}/turns?after=${detail.turns.at(-1).turn_index}&limit=200`,
                      );
                      const turns = turnPage.items;
                      setDetail({
                        ...detail,
                        turns: [...detail.turns, ...turns],
                        truncated: turnPage.nextAfter !== null,
                      });
                    })
                  }
                >
                  Load more turns
                </button>
              )}
            </>
          )}
          {tab === "Ticket" && (
            <>
              <h3>{detail.session.ticket_id ?? "No confirmed ticket"}</h3>
              <p>{detail.session.summary}</p>
              {detail.session.is_demo ? (
                <div className="banner">
                  This is a test record. Browser-call ticket results are listed
                  in its event timeline. Seeded DEMO references are synthetic.
                </div>
              ) : (
                <p>
                  Live ticket orchestration will be added after voice
                  verification.
                </p>
              )}
            </>
          )}
          {tab === "Technical events" && (
            <>
              <ol className="timeline">
                {events.map((e) => (
                  <li key={e.id}>
                    <small>
                      {fmt(e.event_time)} · {e.actor} · {e.severity}
                    </small>
                    <strong>{e.event_type}</strong>
                    <p>{e.public_summary}</p>
                  </li>
                ))}
              </ol>
              {eventNext !== null && (
                <button
                  onClick={() =>
                    void run(async () => {
                      const eventPage = await api(
                        `/conversations/${detail.session.id}/events?after=${events.at(-1).sequence}&limit=200`,
                      );
                      setEvents([...events, ...eventPage.items]);
                      setEventNext(eventPage.nextAfter);
                    })
                  }
                >
                  Load more events
                </button>
              )}
            </>
          )}
          {admin && (
            <a
              className="button-link"
              href={`/api/conversations/${detail.session.id}/export`}
            >
              Download sanitized JSON
            </a>
          )}
        </section>
      </>
    );
  return (
    <section className="card">
      <h2>Retained call history</h2>
      <p className="muted">
        Search clinic names, summaries and redacted transcripts, including
        failed and abandoned calls.
      </p>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => load());
        }}
      >
        <label>
          Search
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Clinic, issue or transcript"
          />
        </label>
        <label>
          Outcome
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="">All outcomes</option>
            {[
              "completed",
              "transferred",
              "abandoned",
              "failed",
              "no_ticket",
            ].map((v) => (
              <option key={v} value={v}>
                {v.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label>
          Clinic
          <input
            value={clinic}
            onChange={(e) => setClinic(e.target.value)}
            placeholder="Exact clinic name"
          />
        </label>
        <label>
          From
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button>Search</button>
      </form>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Received</th>
              <th>Clinic / issue</th>
              <th>Outcome</th>
              <th>Ticket</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id}>
                <td>
                  {fmt(s.started_at)}
                  <small>
                    {s.source === "browser_demo"
                      ? "Browser demo"
                      : s.is_demo
                        ? "Synthetic call"
                        : ""}
                  </small>
                </td>
                <td>
                  <strong>{s.clinic_name}</strong>
                  <small>{s.summary}</small>
                </td>
                <td>
                  <Badge>{s.outcome}</Badge>
                </td>
                <td>{s.ticket_id ?? "—"}</td>
                <td>
                  <button
                    className="ghost"
                    onClick={() => void run(() => open(s.id))}
                  >
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!items.length && <p>No conversations match these filters.</p>}
      {next && (
        <button
          className="secondary"
          onClick={() => void run(() => load(next))}
        >
          Load more conversations
        </button>
      )}
    </section>
  );
}
function Connections({
  run,
  notice,
  busy,
}: Run & { notice: (v: string) => void; busy: boolean }) {
  const [connections, setConnections] = useState<any[]>([]);
  const reload = async () =>
    setConnections((await api("/settings/connections")).connections);
  useEffect(() => {
    void run(reload);
  }, []);
  return (
    <>
      <p className="muted">
        Credentials are write-only and encrypted at rest. Leave a credential
        field blank to keep the saved value.
      </p>
      {connections.map((c) => (
        <section className="card" key={c.provider}>
          <div className="detail-head">
            <h2>
              {
                {
                  pbx: "3CX PBX",
                  openai: "OpenAI Realtime",
                  syncro: "Syncro MSP",
                }[c.provider as "pbx" | "openai" | "syncro"]
              }
            </h2>
            <Badge>
              {c.secretConfigured ? "credential saved" : "not configured"}
            </Badge>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget),
                form = e.currentTarget;
              const secret = String(f.get("secret") ?? "");
              const body =
                c.provider === "pbx"
                  ? {
                      provider: "pbx",
                      pbxBase: f.get("pbxBase"),
                      appId: f.get("appId"),
                      targetVersion: "20 Update 10",
                      supportExtension: f.get("supportExtension"),
                    }
                  : c.provider === "openai"
                    ? {
                        provider: "openai",
                        model: f.get("model"),
                        voice: f.get("voice"),
                      }
                    : { provider: "syncro", tenant: f.get("tenant") };
              void run(async () => {
                await api("/settings/connections", "PUT", {
                  ...body,
                  ...(secret ? { secret } : {}),
                });
                form.reset();
                await reload();
                notice(
                  "Connection saved. Credential values cannot be read back.",
                );
              });
            }}
          >
            <div className="fields">
              {c.provider === "pbx" && (
                <>
                  <label>
                    PBX HTTPS address
                    <input
                      name="pbxBase"
                      defaultValue={c.settings?.pbxBase ?? ""}
                      placeholder="https://your-pbx.example.com:5001"
                      required
                    />
                  </label>
                  <label>
                    Service Principal Client ID
                    <input
                      name="appId"
                      defaultValue={c.settings?.appId ?? "chinook-ai"}
                      required
                    />
                  </label>
                  <label>
                    Technician queue / extension
                    <input
                      name="supportExtension"
                      defaultValue={c.settings?.supportExtension ?? ""}
                      placeholder="Configure after approval"
                    />
                  </label>
                  <label>
                    Target version
                    <input value="3CX V20 Update 10" readOnly />
                  </label>
                </>
              )}
              {c.provider === "openai" && (
                <>
                  <label>
                    Realtime model ID
                    <input
                      name="model"
                      defaultValue={c.settings?.model ?? ""}
                      placeholder="Validated model ID"
                      list="models"
                    />
                    <datalist id="models">
                      {c.test?.models?.map((m: string) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                    <small>
                      Run a live read-only check to list accessible Realtime
                      IDs. Audio availability still needs a call test.
                    </small>
                  </label>
                  <label>
                    Voice ID
                    <input
                      name="voice"
                      defaultValue={c.settings?.voice ?? ""}
                      placeholder="Validated voice ID"
                    />
                  </label>
                </>
              )}
              {c.provider === "syncro" && (
                <label>
                  Syncro tenant or address
                  <input
                    name="tenant"
                    defaultValue={c.settings?.tenant ?? ""}
                    placeholder="your-company"
                    required
                  />
                  <small>
                    Enter your-company or https://your-company.syncromsp.com.
                    Save before testing the connection.
                  </small>
                </label>
              )}
              <label>
                {c.provider === "pbx" ? "Client secret" : "API key"}
                <input
                  name="secret"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    c.secretConfigured
                      ? "•••••••• · saved; enter to rotate"
                      : "Enter credential"
                  }
                />
              </label>
            </div>
            <div className="actions">
              <button disabled={busy}>Save connection</button>
              <button
                disabled={busy}
                className="secondary"
                type="button"
                onClick={() =>
                  void run(async () => {
                    const result = await api(
                      "/settings/test/" + c.provider,
                      "POST",
                      {},
                    );
                    await reload();
                    notice(result.message);
                  })
                }
              >
                Test saved connection
              </button>
            </div>
          </form>
          {c.test && (
            <p className="test-status">
              <Badge>{c.test.status}</Badge> {c.test.message}
            </p>
          )}
        </section>
      ))}
    </>
  );
}
function Agent({
  run,
  notice,
  busy,
}: Run & { notice: (v: string) => void; busy: boolean }) {
  const [a, setA] = useState<any>(null);
  useEffect(() => {
    void run(async () => setA(await api("/settings/agent")));
  }, []);
  if (!a) return <p>Loading agent settings…</p>;
  return (
    <section className="card">
      <h2>Agent intake behaviour</h2>
      <p className="muted">
        Each save creates a new prompt version. Historical calls retain their
        original version.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api("/settings/agent", "PUT", {
              name: a.name,
              greeting: a.greeting,
              prompt: a.prompt,
              maxQuestions: a.maxQuestions,
              requireConfirmation: true,
            });
            setA(await api("/settings/agent"));
            notice("Agent version saved for future calls.");
          });
        }}
      >
        <div className="fields">
          <label>
            Assistant name
            <input
              value={a.name}
              onChange={(e) => setA({ ...a, name: e.target.value })}
              required
            />
          </label>
          <label>
            Maximum questions
            <input
              type="number"
              min={2}
              max={20}
              value={a.maxQuestions}
              onChange={(e) =>
                setA({ ...a, maxQuestions: Number(e.target.value) })
              }
            />
          </label>
        </div>
        <label>
          Greeting
          <textarea
            rows={4}
            value={a.greeting}
            onChange={(e) => setA({ ...a, greeting: e.target.value })}
          />
        </label>
        <label>
          System prompt
          <textarea
            rows={12}
            value={a.prompt}
            onChange={(e) => setA({ ...a, prompt: e.target.value })}
          />
        </label>
        <div className="banner">
          Explicit caller confirmation is required before any ticket write.
          Recording is off.
        </div>
        <p className="muted mono">Version {a.versionId}</p>
        <button disabled={busy}>Save new version</button>
      </form>
    </section>
  );
}
function Users({
  run,
  notice,
  busy,
}: Run & { notice: (v: string) => void; busy: boolean }) {
  const [users, setUsers] = useState<any[]>([]);
  const reload = async () => setUsers((await api("/admin/users")).items);
  useEffect(() => {
    void run(reload);
  }, []);
  return (
    <section className="card">
      <h2>Workspace access</h2>
      <p className="muted">
        Support users can inspect conversations. Administrators manage
        credentials, users and exports.
      </p>
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Role</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td>
              <td>{u.role}</td>
              <td>{fmt(u.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Create a user</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget,
            f = new FormData(form);
          void run(async () => {
            await api("/admin/users", "POST", {
              email: f.get("email"),
              password: f.get("password"),
              role: f.get("role"),
            });
            form.reset();
            await reload();
            notice("User created.");
          });
        }}
      >
        <div className="fields">
          <label>
            Email
            <input name="email" type="email" required />
          </label>
          <label>
            Initial password
            <input
              name="password"
              type="password"
              minLength={14}
              maxLength={128}
              autoComplete="new-password"
              required
            />
          </label>
          <label>
            Role
            <select name="role">
              <option value="support">Support</option>
              <option value="admin">Administrator</option>
            </select>
          </label>
        </div>
        <button disabled={busy}>Create user</button>
      </form>
    </section>
  );
}
function Maintenance({ run }: Run) {
  const [audit, setAudit] = useState<any[]>([]),
    [next, setNext] = useState<string | null>(null);
  const load = async (cursor?: string) => {
    const r = await api("/admin/audit" + (cursor ? "?after=" + cursor : ""));
    setAudit(cursor ? (old) => [...old, ...r.items] : r.items);
    setNext(r.nextCursor);
  };
  useEffect(() => {
    void run(() => load());
  }, []);
  return (
    <>
      <section className="card">
        <h2>Deployment checks</h2>
        <p>
          Database: SQLite WAL · schema version 2. Audio recording is disabled.
        </p>
        <div className="banner">
          Retention automation, backup restore verification, key rotation and
          live failover are scheduled for production hardening. This foundation
          is for development and synthetic testing.
        </div>
      </section>
      <section className="card">
        <h2>Security audit</h2>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Operation</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {audit.map((a) => (
              <tr key={a.id}>
                <td>{fmt(a.occurred_at)}</td>
                <td>{a.operation}</td>
                <td className="mono">{a.target_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {next && (
          <button onClick={() => void run(() => load(next))}>
            Load more audit events
          </button>
        )}
      </section>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
