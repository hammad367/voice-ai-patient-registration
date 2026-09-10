"use client";

// ============================================================================
// Appointments panel — bonus feature. Lists bookings (created conversationally
// by the agent after registration, or via POST /api/appointments).
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { CalendarClock, RefreshCw } from "lucide-react";
import { api, AppointmentDto, formatPhoneClient } from "@/lib/client-api";

export default function AppointmentsPanel({ refreshKey }: { refreshKey: number }) {
  const [appointments, setAppointments] = useState<AppointmentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await api<{ appointments: AppointmentDto[] }>("/api/appointments");
    if (error) toast({ title: "Failed to load appointments", description: error, variant: "destructive" });
    setAppointments(data?.appointments ?? []);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load, refreshKey]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock className="h-4 w-4 text-emerald-600" />
          Scheduled appointments
          <Badge variant="outline">{appointments.length}</Badge>
        </CardTitle>
        <Button variant="ghost" size="icon" onClick={load} aria-label="Refresh">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded bg-stone-100" />
            ))}
          </div>
        ) : appointments.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No appointments yet — the agent offers booking right after a successful registration.
          </p>
        ) : (
          <ScrollArea className="max-h-[480px]">
            <div className="space-y-2 pr-2">
              {appointments.map((a) => (
                <div key={a.id} className="flex flex-col gap-1 rounded-lg border border-stone-200 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium">{a.patient_name ?? "Unknown patient"}</p>
                    <p className="text-xs text-stone-500">
                      {a.patient_phone ? formatPhoneClient(a.patient_phone) : ""} · {a.reason}
                    </p>
                  </div>
                  <div className="text-left sm:text-right">
                    <p className="text-sm font-medium text-emerald-700">
                      {new Date(a.appointment_date).toLocaleString([], {
                        weekday: "short", month: "short", day: "numeric",
                        hour: "numeric", minute: "2-digit",
                      })}
                    </p>
                    <p className="text-xs text-stone-500">{a.provider}</p>
                  </div>
                  <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700 sm:ml-3">
                    {a.status}
                  </Badge>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
