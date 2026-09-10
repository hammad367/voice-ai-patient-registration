"use client";

// ============================================================================
// Architecture & Telephony panel — system diagram, tech stack rationale,
// and step-by-step provisioning guides for a REAL dialable U.S. number
// (Vapi — recommended — and Twilio), plus environment variables.
// ============================================================================

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Check, Copy, GitBranch, PhoneCall, Server, Database, Mic2 } from "lucide-react";

const VAPI_CONFIG_URL = "/docs/vapi-assistant-config.json";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast({ title: "Copy failed", description: "Select and copy manually.", variant: "destructive" });
        }
      }}
    >
      {copied ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

const TWILIO_STEPS = `1. Buy a U.S. number: Twilio Console → Phone Numbers → Buy a number
   (voice-capable).
2. Configure the number: Voice & Fax → "A call comes in" →
   Webhook: POST  https://<YOUR-DOMAIN>/api/telephony/twilio
3. That's it. The webhook runs the same conversational engine:
   <Say> speaks the agent's reply, <Gather input="speech"> listens,
   loops turn-by-turn until the agent is done, then <Hangup/>.
4. Call the number and register patients over the phone.`;

const VAPI_STEPS = `1. Sign up at vapi.ai → Dashboard → Phone Numbers → Buy a U.S. number.
2. Create an Assistant and import docs/vapi-assistant-config.json
   (served live at ${VAPI_CONFIG_URL}).
3. Set the assistant's serverUrl to:
   https://<YOUR-DOMAIN>/api/telephony/vapi
   → tool calls (register_patient, update_patient, get_patient_by_phone,
     schedule_appointment) hit this endpoint, which writes through the
     SAME service layer as the REST API.
4. Call your new number: Vapi handles telephony + STT + TTS; the LLM
   prompt and tools live in the config, and persistence happens here.`;

const NGROK_STEPS = `# Local development / review demo:
bun install
bun run db:push && bun run db:seed
bun run dev          # http://localhost:3000

# Expose to Twilio/Vapi:
ngrok http 3000
# → use the https URL as <YOUR-DOMAIN> above`;

function DiagramNode({ icon, title, sub, className }: { icon: React.ReactNode; title: string; sub: string; className?: string }) {
  return (
    <div className={`flex items-center gap-3 rounded-xl border p-3 shadow-sm ${className ?? "border-stone-200 bg-white"}`}>
      <div className="rounded-lg bg-emerald-50 p-2 text-emerald-600">{icon}</div>
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs text-stone-500">{sub}</p>
      </div>
    </div>
  );
}

export default function ArchitecturePanel() {
  return (
    <div className="space-y-4">
      {/* Diagram */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <GitBranch className="h-4 w-4 text-emerald-600" />
            System architecture
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid items-stretch gap-3 md:grid-cols-4">
            <DiagramNode icon={<PhoneCall className="h-5 w-5" />} title="Phone Call" sub="Real U.S. number (Twilio / Vapi) + Web simulator for demos" />
            <DiagramNode icon={<Mic2 className="h-5 w-5" />} title="Voice AI Agent" sub="Deterministic state machine + LLM (extraction & wording) + validation safety nets" />
            <DiagramNode icon={<Database className="h-5 w-5" />} title="Database" sub="SQLite via Prisma — patients, call transcripts, appointments. Survives restarts." />
            <DiagramNode icon={<Server className="h-5 w-5" />} title="REST API" sub="/api/patients CRUD + envelope, same service layer the agent writes through" />
          </div>
          <div className="mt-3 rounded-lg bg-stone-50 p-3 font-mono text-[11px] leading-relaxed text-stone-600">
            Caller ⇄ Voice Agent (LLM + Telephony) ⇄ Database (persistent)
            <br />
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;↓
            <br />
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Web Service (REST API + Dashboard)
          </div>
        </CardContent>
      </Card>

      {/* Tech stack rationale */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Tech stack justification</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 text-sm md:grid-cols-2">
            {[
              ["Next.js 16 + TypeScript", "One deployable for API + dashboard; typed end-to-end; fastest path to a production-shaped system in 3 hours."],
              ["Prisma + SQLite", "Zero-ops persistent relational store with schema constraints + indexes; swap to Postgres by changing one env var."],
              ["Zod validation (single source)", "The SAME schema powers REST 422s, the agent's field re-prompts, and tests — rules can never drift."],
              ["State machine + LLM hybrid", "Deterministic flow guarantees confirmation-before-save and per-field re-prompting; the LLM owns tone and messy-speech extraction."],
              ["z-ai SDK (LLM)", "Server-side only; dependency-injected so the whole agent is unit-testable with a fake LLM."],
              ["Twilio TwiML / Vapi tools", "Two independent provisioning paths for a real dialable number; both reuse the identical agent engine."],
            ].map(([t, d]) => (
              <div key={t} className="rounded-lg border border-stone-200 p-3">
                <p className="font-semibold text-stone-800">{t}</p>
                <p className="mt-1 text-xs leading-relaxed text-stone-500">{d}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Telephony provisioning */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <PhoneCall className="h-4 w-4 text-emerald-600" />
            Provisioning a real dialable U.S. number
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            This preview environment can’t place PSTN calls, so the web simulator demonstrates the live agent; these guides make the
            same system answer a real phone line in minutes.
          </p>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="vapi">
            <TabsList>
              <TabsTrigger value="vapi">Vapi (recommended)</TabsTrigger>
              <TabsTrigger value="twilio">Twilio</TabsTrigger>
              <TabsTrigger value="local">Local + ngrok</TabsTrigger>
            </TabsList>
            <TabsContent value="vapi" className="space-y-3 pt-3">
              <pre className="overflow-auto rounded-lg bg-stone-900 p-4 text-xs leading-relaxed text-emerald-300">{VAPI_STEPS}</pre>
              <div className="flex items-center gap-2">
                <a href={VAPI_CONFIG_URL} target="_blank" rel="noreferrer">
                  <Button variant="outline" size="sm">Open assistant config JSON</Button>
                </a>
              </div>
            </TabsContent>
            <TabsContent value="twilio" className="pt-3">
              <pre className="overflow-auto rounded-lg bg-stone-900 p-4 text-xs leading-relaxed text-emerald-300">{TWILIO_STEPS}</pre>
            </TabsContent>
            <TabsContent value="local" className="space-y-3 pt-3">
              <pre className="overflow-auto rounded-lg bg-stone-900 p-4 text-xs leading-relaxed text-emerald-300">{NGROK_STEPS}</pre>
              <CopyButton text={NGROK_STEPS} label="Copy commands" />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Env vars */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Environment variables</CardTitle>
          <p className="text-xs text-muted-foreground">
            No secrets are hardcoded (security requirement). Copy .env.example → .env and fill in.
          </p>
        </CardHeader>
        <CardContent>
          <div className="space-y-1 rounded-lg border p-3 font-mono text-xs text-stone-600">
            {[
              ["DATABASE_URL", "file:./db/custom.db — SQLite path"],
              ["APP_BASE_URL", "https://your-app.example.com — public URL for webhooks"],
              ["TELEPHONY_PROVIDER", "vapi | twilio | none"],
              ["VAPI_API_KEY / VAPI_ASSISTANT_ID", "if using Vapi (server-side only)"],
              ["TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN", "if using Twilio (server-side only)"],
            ].map(([k, v]) => (
              <div key={k} className="flex flex-col gap-0.5 border-b border-stone-100 py-1.5 last:border-0 sm:flex-row sm:justify-between sm:gap-4">
                <span className="font-semibold text-stone-700">{k}</span>
                <span className="text-stone-400">{v}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
