"use client";

// ============================================================================
// Voice Call Simulator — browser stand-in for the phone line.
// Uses the SAME agent backend as the Twilio/Vapi telephony webhooks
// (POST /api/voice/chat), so what you hear here is exactly what a caller
// experiences when dialing the provisioned number.
//
// STT: Web Speech API (webkitSpeechRecognition) — Chrome/Edge/Safari
// TTS: SpeechSynthesis — speaks every agent reply (barge-in supported:
//      speaking is cancelled the moment the mic opens)
// Fallback: type into the text box if mic is unavailable.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  CheckCircle2, Circle, Mic, MicOff, Phone, PhoneOff, Send, Volume2, VolumeX, Sparkles,
} from "lucide-react";
import { api, AgentTurnDto } from "@/lib/client-api";

interface TranscriptLine {
  role: "caller" | "agent";
  content: string;
  at: string;
}

const REQUIRED_FIELDS = [
  ["first_name", "First name"],
  ["last_name", "Last name"],
  ["date_of_birth", "Date of birth"],
  ["sex", "Sex"],
  ["phone_number", "Phone number"],
  ["address_line_1", "Street address"],
  ["city", "City"],
  ["state", "State"],
  ["zip_code", "ZIP code"],
] as const;

const OPTIONAL_FIELDS = [
  ["email", "Email"],
  ["address_line_2", "Apt / Suite"],
  ["insurance_provider", "Insurance provider"],
  ["insurance_member_id", "Member ID"],
  ["preferred_language", "Preferred language"],
  ["emergency_contact_name", "Emergency contact"],
  ["emergency_contact_phone", "Emergency phone"],
] as const;

const STAGE_LABELS: Record<string, { label: string; className: string }> = {
  collect: { label: "Collecting information", className: "bg-amber-100 text-amber-800 border-amber-200" },
  duplicate: { label: "Duplicate detected", className: "bg-orange-100 text-orange-800 border-orange-200" },
  offer_optional: { label: "Offering optional fields", className: "bg-teal-100 text-teal-800 border-teal-200" },
  optional_collect: { label: "Collecting optionals", className: "bg-teal-100 text-teal-800 border-teal-200" },
  confirm: { label: "Confirming read-back", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  saving: { label: "Saving…", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  appointment_offer: { label: "Offering appointment", className: "bg-violet-100 text-violet-800 border-violet-200" },
  appointment_time: { label: "Picking a slot", className: "bg-violet-100 text-violet-800 border-violet-200" },
  done: { label: "Call complete", className: "bg-stone-100 text-stone-700 border-stone-200" },
};

const QUICK_LINES = [
  "Hi, I'd like to register a new patient",
  "Hablo español",
  "No, that's all",
  "Yes, that's all correct",
  "Start over",
];

export default function VoiceSimulator({ onRegistration }: { onRegistration: () => void }) {
  const [inCall, setInCall] = useState(false);
  const [starting, setStarting] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [stage, setStage] = useState<string>("collect");
  const [language, setLanguage] = useState("en");
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [collected, setCollected] = useState<Record<string, unknown>>({});
  const [reprompt, setReprompt] = useState<Record<string, string>>({});
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [ttsOn, setTtsOn] = useState(true);
  const [listening, setListening] = useState(false);
  const [micSupported, setMicSupported] = useState(false);

  const recognitionRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const ttsOnRef = useRef(ttsOn);

  useEffect(() => {
    ttsOnRef.current = ttsOn;
  }, [ttsOn]);

  useEffect(() => {
    const w = window as any;
    const t = setTimeout(() => {
      setMicSupported(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition));
    }, 0);
    return () => {
      clearTimeout(t);
      try { recognitionRef.current?.stop(); } catch {}
      window.speechSynthesis?.cancel();
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [transcript, thinking]);

  const speak = useCallback((text: string, lang: string) => {
    if (!ttsOnRef.current || typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === "es" ? "es-ES" : "en-US";
    u.rate = 1.02;
    u.pitch = 1.05;
    window.speechSynthesis.speak(u);
  }, []);

  const sendTurn = useCallback(
    async (message: string) => {
      if (!sessionId || !message.trim()) return;
      setTranscript((t) => [...t, { role: "caller", content: message, at: new Date().toISOString() }]);
      setThinking(true);
      const { data, error } = await api<AgentTurnDto>("/api/voice/chat", {
        method: "POST",
        body: JSON.stringify({ session_id: sessionId, message }),
      });
      setThinking(false);
      if (error || !data) {
        setTranscript((t) => [...t, { role: "agent", content: `⚠ Technical problem: ${error ?? "unknown"}`, at: new Date().toISOString() }]);
        return;
      }
      setTranscript((t) => [...t, { role: "agent", content: data.reply, at: new Date().toISOString() }]);
      setStage(data.stage);
      setLanguage(data.language);
      setCollected(data.collected ?? {});
      setReprompt(data.reprompt ?? {});
      speak(data.reply, data.language);
      if (data.done) {
        setInCall(false);
        setSessionId(null);
        onRegistration();
      }
    },
    [sessionId, speak, onRegistration]
  );

  const startCall = useCallback(async () => {
    setStarting(true);
    const { data, error } = await api<{ session_id: string; greeting: string; stage: string }>("/api/voice/session", {
      method: "POST",
      body: JSON.stringify({ channel: "web" }),
    });
    setStarting(false);
    if (error || !data) return;
    setSessionId(data.session_id);
    setStage(data.stage);
    setInCall(true);
    setTranscript([{ role: "agent", content: data.greeting, at: new Date().toISOString() }]);
    setCollected({});
    setReprompt({});
    speak(data.greeting, "en");
  }, [speak]);

  const endCall = useCallback(async () => {
    window.speechSynthesis?.cancel();
    try { recognitionRef.current?.stop(); } catch {}
    if (sessionId) await api(`/api/voice/session/${sessionId}`, { method: "DELETE" });
    setInCall(false);
    setSessionId(null);
    setListening(false);
    onRegistration();
  }, [sessionId, onRegistration]);

  // ---- Microphone (Web Speech API) ----
  const toggleMic = useCallback(() => {
    const w = window as any;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) return;
    if (listening) {
      try { recognitionRef.current?.stop(); } catch {}
      setListening(false);
      return;
    }
    window.speechSynthesis?.cancel(); // barge-in: stop TTS when caller speaks
    const rec = new SR();
    rec.lang = language === "es" ? "es-ES" : "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e: any) => {
      const final = Array.from(e.results as ArrayLike<any>)
        .map((r: any) => r[0].transcript)
        .join(" ")
        .trim();
      setInput(final);
      if (e.results[e.results.length - 1].isFinal) {
        const msg = final;
        setInput("");
        setTimeout(() => sendTurn(msg), 150);
      }
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  }, [listening, language, sendTurn]);

  const stageInfo = STAGE_LABELS[stage] ?? STAGE_LABELS.collect;
  const filled = (k: string) => {
    const v = collected[k];
    return v !== undefined && v !== null && v !== "";
  };

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      {/* ---------------- Call panel ---------------- */}
      <Card className="lg:col-span-3 flex flex-col">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">Live Call Simulator</CardTitle>
            <Badge variant="outline" className={stageInfo.className}>{stageInfo.label}</Badge>
            {language === "es" && <Badge className="bg-teal-600">Español</Badge>}
          </div>
          <div className="flex items-center gap-2">
            <Volume2 className="h-4 w-4 text-muted-foreground" />
            <Switch checked={ttsOn} onCheckedChange={setTtsOn} aria-label="Toggle voice playback" />
            <VolumeX className="h-4 w-4 text-muted-foreground" />
          </div>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-3">
          <div
            className={`relative flex-1 overflow-hidden rounded-lg border bg-gradient-to-b from-stone-50 to-white ${
              inCall ? "border-emerald-200" : "border-stone-200"
            }`}
          >
            {inCall && (
              <div className="absolute right-3 top-3 z-10 flex items-center gap-2 rounded-full bg-emerald-600 px-3 py-1 text-xs font-medium text-white shadow">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
                </span>
                On call · Maya
              </div>
            )}
            <ScrollArea className="h-[420px] p-4">
              <div ref={scrollRef} className="flex max-h-[420px] flex-col gap-3 pr-3">
                {!inCall && transcript.length === 0 && (
                  <div className="flex h-72 flex-col items-center justify-center gap-3 text-center">
                    <div className="rounded-full bg-emerald-50 p-5">
                      <Phone className="h-8 w-8 text-emerald-600" />
                    </div>
                    <p className="max-w-sm text-sm text-muted-foreground">
                      Start a call and speak naturally with <b>Maya</b>, the AI intake coordinator —
                      the exact same conversational engine answers the real phone line.
                    </p>
                    {micSupported ? (
                      <p className="text-xs text-stone-400">Microphone supported — speak or type.</p>
                    ) : (
                      <p className="text-xs text-amber-600">
                        Mic not supported in this browser — use the text box (Chrome recommended for voice).
                      </p>
                    )}
                  </div>
                )}
                {transcript.map((line, i) => (
                  <div key={i} className={`flex ${line.role === "caller" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm ${
                        line.role === "caller"
                          ? "rounded-br-sm bg-stone-800 text-white"
                          : "rounded-bl-sm border border-emerald-100 bg-emerald-50 text-stone-800"
                      }`}
                    >
                      <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide opacity-60">
                        {line.role === "caller" ? "You (caller)" : "Maya · AI agent"}
                      </span>
                      {line.content}
                    </div>
                  </div>
                ))}
                {thinking && (
                  <div className="flex justify-start">
                    <div className="rounded-2xl rounded-bl-sm border border-emerald-100 bg-emerald-50 px-4 py-2.5">
                      <span className="flex gap-1">
                        <span className="h-2 w-2 animate-bounce rounded-full bg-emerald-400 [animation-delay:0ms]" />
                        <span className="h-2 w-2 animate-bounce rounded-full bg-emerald-400 [animation-delay:120ms]" />
                        <span className="h-2 w-2 animate-bounce rounded-full bg-emerald-400 [animation-delay:240ms]" />
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Controls */}
          <div className="flex flex-col gap-2">
            {inCall ? (
              <>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={toggleMic}
                    variant={listening ? "default" : "outline"}
                    size="icon"
                    className={`h-11 w-11 shrink-0 rounded-full ${listening ? "animate-pulse bg-rose-600 hover:bg-rose-700" : ""}`}
                    disabled={!micSupported}
                    aria-label={listening ? "Stop microphone" : "Start microphone"}
                  >
                    {listening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                  </Button>
                  <Input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && input.trim()) {
                        const m = input;
                        setInput("");
                        sendTurn(m);
                      }
                    }}
                    placeholder={listening ? "Listening… (or type here)" : "Type what you'd say on the phone…"}
                    className="h-11"
                  />
                  <Button
                    onClick={() => { if (input.trim()) { const m = input; setInput(""); sendTurn(m); } }}
                    size="icon"
                    className="h-11 w-11 shrink-0 rounded-full bg-emerald-600 hover:bg-emerald-700"
                    disabled={!input.trim() || thinking}
                    aria-label="Send"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                  <Button
                    onClick={endCall}
                    size="icon"
                    variant="destructive"
                    className="h-11 w-11 shrink-0 rounded-full"
                    aria-label="Hang up"
                  >
                    <PhoneOff className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {QUICK_LINES.map((q) => (
                    <button
                      key={q}
                      onClick={() => sendTurn(q)}
                      disabled={thinking}
                      className="rounded-full border border-stone-200 bg-stone-50 px-3 py-1 text-xs text-stone-600 transition hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-50"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <Button
                onClick={startCall}
                disabled={starting}
                size="lg"
                className="mx-auto h-12 gap-2 rounded-full bg-emerald-600 px-8 text-base hover:bg-emerald-700"
              >
                <Phone className="h-5 w-5" />
                {starting ? "Dialing…" : "Start registration call"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ---------------- Live data panel ---------------- */}
      <Card className="lg:col-span-2">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-emerald-600" />
            Live patient record
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Fields fill in real time as the agent validates each answer server-side.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">Required</p>
            <div className="space-y-1.5">
              {REQUIRED_FIELDS.map(([key, label]) => (
                <div key={key} className="flex items-center gap-2 text-sm">
                  {filled(key) ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                  ) : (
                    <Circle className="h-4 w-4 shrink-0 text-stone-300" />
                  )}
                  <span className={filled(key) ? "font-medium text-stone-800" : "text-stone-400"}>{label}</span>
                  {reprompt[key] && (
                    <Badge variant="outline" className="ml-auto border-rose-200 bg-rose-50 text-[10px] text-rose-700">
                      re-asking
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          </div>
          <Separator />
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">Optional</p>
            <div className="space-y-1.5">
              {OPTIONAL_FIELDS.map(([key, label]) => (
                <div key={key} className="flex items-center gap-2 text-sm">
                  {filled(key) ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-teal-600" />
                  ) : (
                    <Circle className="h-4 w-4 shrink-0 text-stone-200" />
                  )}
                  <span className={filled(key) ? "font-medium text-stone-800" : "text-stone-400"}>{label}</span>
                </div>
              ))}
            </div>
          </div>
          {Object.keys(collected).length > 0 && (
            <>
              <Separator />
              <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg bg-stone-50 p-3 font-mono text-[11px] leading-relaxed text-stone-600">
                {Object.entries(collected)
                  .filter(([, v]) => v !== undefined && v !== null && v !== "")
                  .map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-2">
                      <span className="text-stone-400">{k}</span>
                      <span className="truncate text-right">{String(v instanceof Date ? v.toISOString().slice(0, 10) : v)}</span>
                    </div>
                  ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
