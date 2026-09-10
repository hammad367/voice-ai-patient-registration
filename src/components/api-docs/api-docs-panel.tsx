"use client";

// ============================================================================
// API Docs panel — live, interactive reference. Each endpoint has a "Try it"
// button that hits the real running API and shows the raw envelope response.
// ============================================================================

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PlayCircle } from "lucide-react";

interface EndpointSpec {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  description: string;
  codes: string;
  sample?: string;
  needsBody?: boolean;
}

const METHOD_STYLES: Record<string, string> = {
  GET: "bg-emerald-100 text-emerald-800 border-emerald-200",
  POST: "bg-teal-100 text-teal-800 border-teal-200",
  PUT: "bg-amber-100 text-amber-800 border-amber-200",
  DELETE: "bg-rose-100 text-rose-800 border-rose-200",
};

const ENDPOINTS: EndpointSpec[] = [
  {
    method: "GET",
    path: "/api/patients?last_name=Doe",
    description: "List patients. Optional query params: last_name, date_of_birth (YYYY-MM-DD), phone_number.",
    codes: "200",
  },
  {
    method: "POST",
    path: "/api/patients",
    description: "Create a patient. Returns 201 with the created record including patient_id (UUID).",
    codes: "201 · 422 · 400",
    needsBody: true,
    sample: JSON.stringify(
      {
        first_name: "Ava", last_name: "Thompson", date_of_birth: "07/04/1995",
        sex: "Female", phone_number: "6465550123", address_line_1: "300 Bleecker St",
        city: "New York", state: "NY", zip_code: "10014",
      },
      null,
      2
    ),
  },
  {
    method: "GET",
    path: "/api/patients/:id",
    description: "Retrieve one patient by patient_id (UUID). 404 when missing or soft-deleted.",
    codes: "200 · 404 · 400",
  },
  {
    method: "PUT",
    path: "/api/patients/:id",
    description: "Partial update — send only the fields you want to change.",
    codes: "200 · 404 · 422",
    needsBody: true,
    sample: JSON.stringify({ city: "Brooklyn" }, null, 2),
  },
  {
    method: "DELETE",
    path: "/api/patients/:id",
    description: "Soft-delete: sets deleted_at; the row is retained (never hard-deleted).",
    codes: "200 · 404",
  },
  {
    method: "POST",
    path: "/api/voice/session",
    description: "Start a registration conversation. Returns session_id + the agent's spoken greeting.",
    codes: "201 · 429",
    needsBody: true,
    sample: JSON.stringify({ channel: "web" }, null, 2),
  },
  {
    method: "POST",
    path: "/api/voice/chat",
    description: "Speak one turn to the voice agent (same engine the phone line uses).",
    codes: "200 · 404 · 429",
    needsBody: true,
    sample: JSON.stringify({ session_id: "<paste from session>", message: "Hi, I'm Sam Carter, born 05/05/1992" }, null, 2),
  },
  {
    method: "DELETE",
    path: "/api/voice/session/:id",
    description: "Hang up: finalizes the transcript row (completed / abandoned).",
    codes: "200 · 404",
  },
  {
    method: "POST",
    path: "/api/telephony/vapi",
    description: "Vapi.ai tool-call webhook (register_patient, update_patient, get_patient_by_phone…).",
    codes: "200 · 400",
  },
  {
    method: "POST",
    path: "/api/telephony/twilio",
    description: "Twilio Programmable Voice webhook — returns TwiML <Say>+<Gather> loops driven by the agent.",
    codes: "200 (TwiML)",
  },
  {
    method: "GET",
    path: "/api/appointments?slots=1",
    description: "List appointments; ?slots=1 returns the mock availability the agent offers.",
    codes: "200",
  },
  {
    method: "GET",
    path: "/api/calls",
    description: "Call sessions with full transcripts + final collected payloads (observability).",
    codes: "200",
  },
  {
    method: "GET",
    path: "/api/health",
    description: "Liveness + DB connectivity + active voice sessions.",
    codes: "200",
  },
  {
    method: "GET",
    path: "/api/stats",
    description: "Dashboard counters: patients, appointments, calls.",
    codes: "200",
  },
];

export default function ApiDocsPanel() {
  const [pathInput, setPathInput] = useState("/api/health");
  const [bodyInput, setBodyInput] = useState("{}");
  const [response, setResponse] = useState<string>("");
  const [status, setStatus] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const tryIt = async (spec?: EndpointSpec) => {
    const path = spec ? spec.path.replace(":id", "<uuid>") : pathInput;
    setBusy(true);
    try {
      const method = spec?.method ?? "GET";
      const res = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "GET" || method === "DELETE" ? undefined : spec?.sample ?? bodyInput,
      });
      setStatus(res.status);
      const text = await res.text();
      try {
        setResponse(JSON.stringify(JSON.parse(text), null, 2));
      } catch {
        setResponse(text.slice(0, 2000));
      }
    } catch (e) {
      setResponse(String(e));
    }
    setBusy(false);
  };

  return (
    <div className="space-y-4">
      {/* Playground */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <PlayCircle className="h-4 w-4 text-emerald-600" />
            Request playground
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-stone-500">Path + query (GET)</Label>
              <Input value={pathInput} onChange={(e) => setPathInput(e.target.value)} className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-stone-500">JSON body (POST/PUT)</Label>
              <Input value={bodyInput} onChange={(e) => setBodyInput(e.target.value)} className="font-mono text-xs" />
            </div>
          </div>
          <Button onClick={() => tryIt()} disabled={busy} className="bg-emerald-600 hover:bg-emerald-700">
            {busy ? "Sending…" : "Send GET request"}
          </Button>
          {status !== null && (
            <div>
              <Badge variant="outline" className={status < 400 ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}>
                HTTP {status}
              </Badge>
              <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-stone-900 p-3 text-[11px] leading-relaxed text-emerald-300">
                {response}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Endpoint reference */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Endpoint reference</CardTitle>
          <p className="text-xs text-muted-foreground">
            Consistent envelope on every response: <code className="rounded bg-stone-100 px-1">{"{ data: …, error: null }"}</code> /{" "}
            <code className="rounded bg-stone-100 px-1">{"{ data: null, error: { message, details } }"}</code>
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {ENDPOINTS.map((ep) => (
            <div key={ep.method + ep.path} className="flex flex-col gap-2 rounded-lg border border-stone-200 p-3 md:flex-row md:items-center">
              <div className="flex min-w-0 flex-1 flex-col gap-1 md:flex-row md:items-center md:gap-3">
                <Badge variant="outline" className={`w-fit shrink-0 font-mono ${METHOD_STYLES[ep.method]}`}>{ep.method}</Badge>
                <code className="truncate text-xs font-semibold text-stone-700">{ep.path}</code>
                <span className="hidden truncate text-xs text-stone-400 xl:block">{ep.description}</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="shrink-0 border-stone-200 bg-stone-50 font-mono text-[10px] text-stone-500">{ep.codes}</Badge>
                <Button variant="outline" size="sm" onClick={() => tryIt(ep)} disabled={busy}>
                  Try it
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
