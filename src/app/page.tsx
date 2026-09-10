"use client";

// ============================================================================
// Voice AI Agent — Patient Registration System · Dashboard
// Single-page operations console:
//   • Live voice registration (same engine as the phone line)
//   • Patient records (CRUD via the REST API)
//   • Call transcripts (observability)
//   • Appointments (bonus)
//   • API reference with live playground
//   • Architecture + real-phone-number provisioning guides
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import VoiceSimulator from "@/components/voice/voice-simulator";
import PatientsPanel from "@/components/patients/patients-panel";
import TranscriptsPanel from "@/components/calls/transcripts-panel";
import AppointmentsPanel from "@/components/appointments/appointments-panel";
import ApiDocsPanel from "@/components/api-docs/api-docs-panel";
import ArchitecturePanel from "@/components/architecture/architecture-panel";
import { api } from "@/lib/client-api";
import {
  Activity, CalendarClock, HeartPulse, PhoneCall, ShieldCheck, UserRound,
} from "lucide-react";

interface Stats {
  total_patients: number;
  deleted_patients: number;
  total_appointments: number;
  total_calls: number;
}

interface Health {
  status: string;
  database: string;
  active_voice_sessions: number;
}

export default function Home() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(async () => {
    const [s, h] = await Promise.all([
      api<Stats>("/api/stats"),
      api<Health>("/api/health"),
    ]);
    setStats(s.data);
    setHealth(h.data);
  }, []);

  useEffect(() => {
    const t = setTimeout(refresh, 0);
    const interval = setInterval(refresh, 15000);
    return () => {
      clearTimeout(t);
      clearInterval(interval);
    };
  }, [refresh]);

  const onRegistration = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setTimeout(refresh, 800);
  }, [refresh]);

  return (
    <div className="flex min-h-screen flex-col bg-stone-100">
      {/* ---------------- Header ---------------- */}
      <header className="sticky top-0 z-20 border-b border-stone-800 bg-stone-900 text-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-emerald-600 p-2">
              <HeartPulse className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight">
                Voice AI Agent · Patient Registration
              </h1>
              <p className="text-xs text-stone-400">
                Northside Medical Group — conversational intake, REST persistence, live transcripts
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline" className="border-stone-700 bg-stone-800 text-stone-200">
              <ShieldCheck className="mr-1 h-3.5 w-3.5 text-emerald-400" />
              Env-based secrets
            </Badge>
            <Badge
              variant="outline"
              className={
                health?.database === "connected"
                  ? "border-emerald-700 bg-emerald-950 text-emerald-300"
                  : "border-rose-700 bg-rose-950 text-rose-300"
              }
            >
              <Activity className="mr-1 h-3.5 w-3.5" />
              DB {health?.database ?? "…"}
            </Badge>
            <Badge variant="outline" className="border-stone-700 bg-stone-800 text-stone-200">
              <PhoneCall className="mr-1 h-3.5 w-3.5 text-teal-300" />
              {health?.active_voice_sessions ?? 0} live session(s)
            </Badge>
          </div>
        </div>
      </header>

      {/* ---------------- Stats strip ---------------- */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5">
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { label: "Registered patients", value: stats?.total_patients ?? "—", icon: UserRound, tone: "text-emerald-600 bg-emerald-50" },
            { label: "Calls handled", value: stats?.total_calls ?? "—", icon: PhoneCall, tone: "text-teal-600 bg-teal-50" },
            { label: "Appointments", value: stats?.total_appointments ?? "—", icon: CalendarClock, tone: "text-violet-600 bg-violet-50" },
            { label: "Archived (soft-deleted)", value: stats?.deleted_patients ?? "—", icon: Activity, tone: "text-stone-500 bg-stone-100" },
          ].map((s) => (
            <div key={s.label} className="flex items-center gap-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
              <div className={`rounded-lg p-2.5 ${s.tone}`}>
                <s.icon className="h-5 w-5" />
              </div>
              <div>
                <p className="text-2xl font-bold leading-none text-stone-800">{s.value}</p>
                <p className="mt-1 text-xs text-stone-500">{s.label}</p>
              </div>
            </div>
          ))}
        </div>

        <Tabs defaultValue="voice" onValueChange={onRegistration}>
          <TabsList className="mb-4 flex h-auto w-full flex-wrap justify-start gap-1 bg-white p-1">
            <TabsTrigger value="voice" className="gap-1.5"><PhoneCall className="h-4 w-4" /> Voice Registration</TabsTrigger>
            <TabsTrigger value="patients" className="gap-1.5"><UserRound className="h-4 w-4" /> Patients</TabsTrigger>
            <TabsTrigger value="transcripts" className="gap-1.5"><Activity className="h-4 w-4" /> Transcripts</TabsTrigger>
            <TabsTrigger value="appointments" className="gap-1.5"><CalendarClock className="h-4 w-4" /> Appointments</TabsTrigger>
            <TabsTrigger value="api" className="gap-1.5">API</TabsTrigger>
            <TabsTrigger value="architecture" className="gap-1.5">Architecture</TabsTrigger>
          </TabsList>

          <TabsContent value="voice">
            <VoiceSimulator onRegistration={onRegistration} />
          </TabsContent>
          <TabsContent value="patients">
            <PatientsPanel refreshKey={refreshKey} />
          </TabsContent>
          <TabsContent value="transcripts">
            <TranscriptsPanel refreshKey={refreshKey} />
          </TabsContent>
          <TabsContent value="appointments">
            <AppointmentsPanel refreshKey={refreshKey} />
          </TabsContent>
          <TabsContent value="api">
            <ApiDocsPanel />
          </TabsContent>
          <TabsContent value="architecture">
            <ArchitecturePanel />
          </TabsContent>
        </Tabs>
      </main>

      {/* ---------------- Sticky footer ---------------- */}
      <footer className="mt-auto border-t border-stone-200 bg-white py-4">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-2 px-4 text-xs text-stone-500 md:flex-row">
          <p>
            Voice AI Agent — Patient Registration System · technical assessment submission
          </p>
          <p>
            Demo data only — no real patient data (challenge FAQ). Secrets via environment variables.
          </p>
        </div>
      </footer>
    </div>
  );
}
