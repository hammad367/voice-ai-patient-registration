"use client";

// ============================================================================
// Patients panel — list / filter / detail / edit / soft-delete / create.
// Talks exclusively to the REST API (same endpoints the voice agent uses).
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  Download, Plus, Search, Trash2, UserRound, Pencil,
} from "lucide-react";
import { api, Patient, formatPhoneClient } from "@/lib/client-api";

const SEX_OPTIONS = ["Male", "Female", "Other", "Decline to Answer"];
const EMPTY_FORM = {
  first_name: "", last_name: "", date_of_birth: "", sex: "", phone_number: "",
  email: "", address_line_1: "", address_line_2: "", city: "", state: "", zip_code: "",
  insurance_provider: "", insurance_member_id: "", preferred_language: "",
  emergency_contact_name: "", emergency_contact_phone: "",
};

export default function PatientsPanel({ refreshKey }: { refreshKey: number }) {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [qLastName, setQLastName] = useState("");
  const [qPhone, setQPhone] = useState("");
  const [qDob, setQDob] = useState("");
  const [selected, setSelected] = useState<Patient | null>(null);
  const [editing, setEditing] = useState<Patient | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (qLastName.trim()) params.set("last_name", qLastName.trim());
    if (qPhone.trim()) params.set("phone_number", qPhone.trim());
    if (qDob) params.set("date_of_birth", qDob);
    const { data } = await api<{ patients: Patient[] }>(`/api/patients?${params}`);
    setPatients(data?.patients ?? []);
    setLoading(false);
  }, [qLastName, qPhone, qDob]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load, refreshKey]);

  const openEdit = (p: Patient) => {
    setForm({
      first_name: p.first_name, last_name: p.last_name,
      date_of_birth: p.date_of_birth, sex: p.sex,
      phone_number: formatPhoneClient(p.phone_number),
      email: p.email ?? "", address_line_1: p.address_line_1,
      address_line_2: p.address_line_2 ?? "", city: p.city, state: p.state,
      zip_code: p.zip_code, insurance_provider: p.insurance_provider ?? "",
      insurance_member_id: p.insurance_member_id ?? "",
      preferred_language: p.preferred_language ?? "",
      emergency_contact_name: p.emergency_contact_name ?? "",
      emergency_contact_phone: p.emergency_contact_phone
        ? formatPhoneClient(p.emergency_contact_phone) : "",
    });
    setFormError(null);
    setEditing(p);
  };

  const submitForm = async () => {
    setSaving(true);
    setFormError(null);
    const payload: Record<string, unknown> = {};
    Object.entries(form).forEach(([k, v]) => {
      if (String(v).trim() !== "") payload[k] = String(v).trim();
    });
    const res = editing
      ? await api<Patient>(`/api/patients/${editing.patient_id}`, { method: "PUT", body: JSON.stringify(payload) })
      : await api<Patient>("/api/patients", { method: "POST", body: JSON.stringify(payload) });
    setSaving(false);
    if (res.error) {
      setFormError(res.error);
      return;
    }
    toast({
      title: editing ? "Patient updated" : "Patient created",
      description: `${res.data?.first_name} ${res.data?.last_name} saved successfully.`,
    });
    setEditing(null);
    setCreating(false);
    load();
  };

  const softDelete = async (p: Patient) => {
    const { error } = await api(`/api/patients/${p.patient_id}`, { method: "DELETE" });
    if (error) {
      toast({ title: "Delete failed", description: error, variant: "destructive" });
      return;
    }
    toast({ title: "Patient archived", description: `${p.first_name} ${p.last_name} was soft-deleted (retained in DB).` });
    setSelected(null);
    load();
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(patients, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "patients-export.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const formFields = useMemo(
    () =>
      [
        ["first_name", "First name *"],
        ["last_name", "Last name *"],
        ["phone_number", "Phone * e.g. (415) 555-0123"],
        ["date_of_birth", "DOB * (MM/DD/YYYY)"],
        ["email", "Email"],
        ["address_line_1", "Street address *"],
        ["address_line_2", "Apt / Suite / Unit"],
        ["city", "City *"],
        ["state", "State * (e.g. CA)"],
        ["zip_code", "ZIP * (12345 or 12345-6789)"],
        ["insurance_provider", "Insurance provider"],
        ["insurance_member_id", "Insurance member ID"],
        ["preferred_language", "Preferred language"],
        ["emergency_contact_name", "Emergency contact name"],
        ["emergency_contact_phone", "Emergency contact phone"],
      ] as readonly (keyof typeof EMPTY_FORM)[][],
    []
  );

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <Card>
        <CardContent className="flex flex-col gap-3 pt-4 md:flex-row md:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="f-last" className="text-xs text-stone-500">Last name</Label>
            <Input id="f-last" placeholder="e.g. Doe" value={qLastName} onChange={(e) => setQLastName(e.target.value)} />
          </div>
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="f-phone" className="text-xs text-stone-500">Phone</Label>
            <Input id="f-phone" placeholder="e.g. 4155550101" value={qPhone} onChange={(e) => setQPhone(e.target.value)} />
          </div>
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="f-dob" className="text-xs text-stone-500">Date of birth (YYYY-MM-DD)</Label>
            <Input id="f-dob" placeholder="e.g. 1990-04-12" value={qDob} onChange={(e) => setQDob(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => { setQLastName(""); setQPhone(""); setQDob(""); }}>
              <Search className="mr-1 h-4 w-4" /> Reset
            </Button>
            <Button onClick={() => { setForm({ ...EMPTY_FORM }); setFormError(null); setCreating(true); }}>
              <Plus className="mr-1 h-4 w-4" /> New patient
            </Button>
            <Button variant="outline" size="icon" onClick={exportJson} aria-label="Export JSON" title="Export as JSON">
              <Download className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <UserRound className="h-4 w-4 text-emerald-600" />
            Registered patients
            <Badge variant="outline" className="ml-1">{patients.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-10 animate-pulse rounded bg-stone-100" />
              ))}
            </div>
          ) : patients.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No patients found. Register one via a phone call or the “New patient” button.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-stone-50">
                    <TableHead>Name</TableHead>
                    <TableHead>Date of birth</TableHead>
                    <TableHead>Sex</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead className="hidden md:table-cell">City, State</TableHead>
                    <TableHead className="hidden lg:table-cell">Insurance</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {patients.map((p) => (
                    <TableRow key={p.patient_id} className="cursor-pointer" onClick={() => setSelected(p)}>
                      <TableCell className="font-medium">{p.first_name} {p.last_name}</TableCell>
                      <TableCell>{p.date_of_birth_display}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="border-stone-200 bg-stone-50 text-stone-600">{p.sex}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{formatPhoneClient(p.phone_number)}</TableCell>
                      <TableCell className="hidden md:table-cell">{p.city}, {p.state}</TableCell>
                      <TableCell className="hidden lg:table-cell">{p.insurance_provider ?? <span className="text-stone-300">—</span>}</TableCell>
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        <Button variant="ghost" size="icon" onClick={() => openEdit(p)} aria-label={`Edit ${p.first_name}`}>
                          <Pencil className="h-4 w-4 text-stone-500" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => softDelete(p)} aria-label={`Delete ${p.first_name}`}>
                          <Trash2 className="h-4 w-4 text-rose-500" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Detail dialog */}
      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-lg">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle>{selected.first_name} {selected.last_name}</DialogTitle>
                <DialogDescription className="font-mono text-xs">patient_id: {selected.patient_id}</DialogDescription>
              </DialogHeader>
              <div className="grid max-h-[55vh] grid-cols-1 gap-x-6 gap-y-1 overflow-y-auto rounded-lg border p-4 text-sm sm:grid-cols-2">
                {[
                  ["Date of birth", selected.date_of_birth_display],
                  ["Sex", selected.sex],
                  ["Phone", formatPhoneClient(selected.phone_number)],
                  ["Email", selected.email],
                  ["Address", `${selected.address_line_1}${selected.address_line_2 ? `, ${selected.address_line_2}` : ""}`],
                  ["City / State / ZIP", `${selected.city}, ${selected.state} ${selected.zip_code}`],
                  ["Insurance", selected.insurance_provider],
                  ["Member ID", selected.insurance_member_id],
                  ["Language", selected.preferred_language],
                  ["Emergency contact", selected.emergency_contact_name],
                  ["Emergency phone", selected.emergency_contact_phone ? formatPhoneClient(selected.emergency_contact_phone) : null],
                  ["Created", new Date(selected.created_at).toLocaleString()],
                  ["Updated", new Date(selected.updated_at).toLocaleString()],
                ].map(([k, v]) => (
                  <div key={k as string} className="flex justify-between gap-3 border-b border-stone-100 py-1 last:border-0">
                    <span className="shrink-0 text-stone-400">{k}</span>
                    <span className="text-right font-medium text-stone-700">{(v as string) || "—"}</span>
                  </div>
                ))}
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => { openEdit(selected); setSelected(null); }}>
                  <Pencil className="mr-1 h-4 w-4" /> Edit
                </Button>
                <Button variant="destructive" onClick={() => softDelete(selected)}>
                  <Trash2 className="mr-1 h-4 w-4" /> Soft-delete
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Create / Edit dialog */}
      <Dialog open={!!editing || creating} onOpenChange={(o) => { if (!o) { setEditing(null); setCreating(false); } }}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.first_name} ${editing.last_name}` : "Register a patient manually"}</DialogTitle>
            <DialogDescription>
              Same server-side validation as the phone line — invalid fields come back with specific messages (HTTP 422).
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {formFields.map(([key, label]) =>
              key === "sex" ? (
                <div key={key} className="space-y-1.5">
                  <Label className="text-xs text-stone-500">Sex *</Label>
                  <Select value={form.sex} onValueChange={(v) => setForm((f) => ({ ...f, sex: v }))}>
                    <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                    <SelectContent>
                      {SEX_OPTIONS.map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div key={key} className="space-y-1.5">
                  <Label className="text-xs text-stone-500">{label}</Label>
                  <Input
                    value={form[key]}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  />
                </div>
              )
            )}
          </div>
          {formError && (
            <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
              <Textarea readOnly value={formError} className="h-24 resize-none border-0 bg-transparent p-0 font-mono text-[11px]" />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setEditing(null); setCreating(false); }}>Cancel</Button>
            <Button onClick={submitForm} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700">
              {saving ? "Saving…" : editing ? "Save changes" : "Create patient"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
