"use client";

// ============================================================================
// Transcripts panel — observability: every agent conversation, full
// transcript + final collected payload, persisted per-turn in SQLite.
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { FileAudio2, RefreshCw } from "lucide-react";
import { api, CallSessionDto } from "@/lib/client-api";

const OUTCOME_STYLES: Record<string, string> = {
  registered: "bg-emerald-100 text-emerald-800 border-emerald-200",
  updated: "bg-teal-100 text-teal-800 border-teal-200",
  duplicate_new: "bg-violet-100 text-violet-800 border-violet-200",
  abandoned: "bg-amber-100 text-amber-800 border-amber-200",
  failed: "bg-rose-100 text-rose-800 border-rose-200",
};

export default function TranscriptsPanel({ refreshKey }: { refreshKey: number }) {
  const [calls, setCalls] = useState<CallSessionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const { toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await api<{ calls: CallSessionDto[] }>("/api/calls");
    if (error) toast({ title: "Failed to load calls", description: error, variant: "destructive" });
    setCalls(data?.calls ?? []);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load, refreshKey]);

  const open = openId ? calls.find((c) => c.session_id === openId) : null;

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className="lg:col-span-2">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileAudio2 className="h-4 w-4 text-emerald-600" />
            Call sessions
            <Badge variant="outline">{calls.length}</Badge>
          </CardTitle>
          <Button variant="ghost" size="icon" onClick={load} aria-label="Refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-14 animate-pulse rounded bg-stone-100" />
              ))}
            </div>
          ) : calls.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No calls yet — start one in the Voice Registration tab.
            </p>
          ) : (
            <ScrollArea className="h-[520px] pr-2">
              <div className="space-y-2">
                {calls.map((c) => (
                  <button
                    key={c.session_id}
                    onClick={() => setOpenId(c.session_id)}
                    className={`w-full rounded-lg border p-3 text-left transition hover:border-emerald-300 hover:bg-emerald-50/50 ${
                      openId === c.session_id ? "border-emerald-400 bg-emerald-50" : "border-stone-200"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[11px] text-stone-500">{c.session_id.slice(0, 13)}…</span>
                      <Badge variant="outline" className={OUTCOME_STYLES[c.outcome ?? ""] ?? "border-stone-200 bg-stone-50 text-stone-600"}>
                        {c.outcome ?? c.status}
                      </Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-stone-500">
                      <span>{new Date(c.started_at).toLocaleTimeString()}</span>
                      <span className="capitalize">{c.channel}</span>
                      {c.language === "es" && <span className="text-teal-600">Español</span>}
                      {c.duration_sec != null && <span>{c.duration_sec}s</span>}
                      {c.patient_id && <span className="text-emerald-600">→ patient linked</span>}
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-3">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Transcript</CardTitle>
        </CardHeader>
        <CardContent>
          {!open ? (
            <div className="flex h-[480px] items-center justify-center text-sm text-muted-foreground">
              Select a call to read its full transcript and the final data payload.
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="outline" className="capitalize">{open.channel}</Badge>
                <Badge variant="outline">{open.transcript.length} messages</Badge>
                {open.error_message && (
                  <Badge variant="outline" className="border-rose-200 bg-rose-50 text-rose-700">{open.error_message}</Badge>
                )}
              </div>
              <ScrollArea className="h-[380px] rounded-lg border p-3">
                <div className="space-y-2">
                  {open.transcript.map((t, i) => (
                    <div key={i} className={`flex ${t.role === "caller" ? "justify-end" : "justify-start"}`}>
                      <div
                        className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                          t.role === "caller"
                            ? "bg-stone-800 text-white"
                            : t.role === "agent"
                              ? "border border-emerald-100 bg-emerald-50"
                              : "bg-amber-50 border border-amber-100"
                        }`}
                      >
                        <span className="mb-0.5 block text-[9px] font-semibold uppercase opacity-60">
                          {t.role} · {new Date(t.at).toLocaleTimeString()}
                        </span>
                        {t.content}
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
              {open.collected_data && (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
                    Final collected payload (logged to DB + stdout)
                  </p>
                  <pre className="max-h-40 overflow-auto rounded-lg bg-stone-900 p-3 text-[11px] leading-relaxed text-emerald-300">
                    {JSON.stringify(open.collected_data, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
