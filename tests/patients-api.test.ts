// ============================================================================
// Integration tests — REST API contract (challenge §4).
// Exercises the actual route handlers: envelope shape, status codes,
// server-side validation, partial updates, and SOFT delete semantics.
// Run: bun test tests/patients-api.test.ts
// ============================================================================

import { describe, it, expect, afterAll } from "bun:test";
import { NextRequest } from "next/server";
import { GET as listPatients, POST as createPatient } from "@/app/api/patients/route";
import { GET as getPatient, PUT as updatePatient, DELETE as deletePatient } from "@/app/api/patients/[id]/route";

const BASE = "http://localhost:3000";
const createdIds: string[] = [];

function req(path: string, init?: RequestInit) {
  return new NextRequest(BASE + path, init);
}

async function body(res: Response) {
  return (await res.json()) as { data: Record<string, unknown> | null; error: { message: string; details?: unknown } | string | null };
}

const VALID_PATIENT = {
  first_name: "Testy",
  last_name: "McTestface",
  date_of_birth: "05/05/1995",
  sex: "Other",
  phone_number: "2015550199",
  address_line_1: "1 Test Way",
  city: "Jersey City",
  state: "NJ",
  zip_code: "07302",
};

afterAll(async () => {
  // Soft-delete everything we created so repeat runs stay clean.
  for (const id of createdIds) {
    await deletePatient(req(`/api/patients/${id}`), { params: Promise.resolve({ id }) });
  }
});

describe("POST /patients", () => {
  it("creates a patient → 201 + envelope + patient_id + normalizers applied", async () => {
    const res = await createPatient(req("/api/patients", {
      method: "POST",
      body: JSON.stringify({ ...VALID_PATIENT, state: "new jersey", phone_number: "(201) 555-0199" }),
      headers: { "Content-Type": "application/json" },
    }));
    expect(res.status).toBe(201);
    const json = await body(res);
    expect(json.error).toBeNull();
    expect(json.data!.patient_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(json.data!.phone_number).toBe("2015550199");
    expect(json.data!.state).toBe("NJ");
    expect(json.data!.preferred_language).toBe("English"); // default
    createdIds.push(json.data!.patient_id as string);
  });

  it("rejects invalid payload → 422 with per-field details", async () => {
    const res = await createPatient(req("/api/patients", {
      method: "POST",
      body: JSON.stringify({ ...VALID_PATIENT, phone_number: "555", date_of_birth: "01/01/2099", sex: "Banana" }),
      headers: { "Content-Type": "application/json" },
    }));
    expect(res.status).toBe(422);
    const json = await body(res);
    const details = (json.error as { details: { field: string }[] }).details as { field: string }[];
    const fields = details.map((d) => d.field);
    expect(fields).toContain("phone_number");
    expect(fields).toContain("date_of_birth");
    expect(fields).toContain("sex");
  });

  it("rejects malformed JSON → 400", async () => {
    const res = await createPatient(req("/api/patients", { method: "POST", body: "{oops", headers: { "Content-Type": "application/json" } }));
    expect(res.status).toBe(400);
  });
});

describe("GET /patients", () => {
  it("lists with envelope + count", async () => {
    const res = await listPatients(req("/api/patients"));
    expect(res.status).toBe(200);
    const json = await body(res);
    expect(json.error).toBeNull();
    expect(Array.isArray(json.data!.patients)).toBe(true);
  });
  it("filters by last_name / phone_number", async () => {
    const res = await listPatients(req("/api/patients?last_name=McTestface"));
    const json = await body(res);
    expect(json.data!.count).toBeGreaterThanOrEqual(1);
    const res2 = await listPatients(req("/api/patients?phone_number=2015550199"));
    const json2 = await body(res2);
    expect(json2.data!.count).toBe(1);
  });
  it("rejects bad date_of_birth filter → 400", async () => {
    const res = await listPatients(req("/api/patients?date_of_birth=not-a-date"));
    expect(res.status).toBe(400);
  });
});

describe("GET /patients/:id", () => {
  it("returns 404 for unknown UUID", async () => {
    const res = await getPatient(req("/api/patients/00000000-0000-4000-8000-000000000001"), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000001" }),
    });
    expect(res.status).toBe(404);
  });
  it("returns 400 for non-UUID", async () => {
    const res = await getPatient(req("/api/patients/not-a-uuid"), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(res.status).toBe(400);
  });
});

describe("PUT /patients/:id (partial updates)", () => {
  it("updates one field only", async () => {
    const created = await body(
      await createPatient(req("/api/patients", { method: "POST", body: JSON.stringify(VALID_PATIENT), headers: { "Content-Type": "application/json" } }))
    );
    const id = created.data!.patient_id as string;
    createdIds.push(id);
    const res = await updatePatient(req(`/api/patients/${id}`, {
      method: "PUT",
      body: JSON.stringify({ city: "Hoboken", zip_code: "07030" }),
      headers: { "Content-Type": "application/json" },
    }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const json = await body(res);
    expect(json.data!.city).toBe("Hoboken");
    expect(json.data!.first_name).toBe("Testy"); // untouched
  });
  it("422 on invalid partial value", async () => {
    const created = await body(
      await createPatient(req("/api/patients", { method: "POST", body: JSON.stringify(VALID_PATIENT), headers: { "Content-Type": "application/json" } }))
    );
    const id = created.data!.patient_id as string;
    createdIds.push(id);
    const res = await updatePatient(req(`/api/patients/${id}`, {
      method: "PUT",
      body: JSON.stringify({ state: "XX" }),
      headers: { "Content-Type": "application/json" },
    }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(422);
  });
});

describe("DELETE /patients/:id (soft delete)", () => {
  it("sets deleted_at, hides from list & GET → 404, row retained in DB", async () => {
    const uniquePhone = `206555${String(Math.floor(1000 + Math.random() * 8999))}`;
    const created = await body(
      await createPatient(req("/api/patients", { method: "POST", body: JSON.stringify({ ...VALID_PATIENT, phone_number: uniquePhone }), headers: { "Content-Type": "application/json" } }))
    );
    const id = created.data!.patient_id as string;
    const del = await body(await deletePatient(req(`/api/patients/${id}`), { params: Promise.resolve({ id }) }));
    expect(del.data!.deleted).toBe(true);
    expect((del.data!.deleted_at as string).length).toBeGreaterThan(0);

    const get = await getPatient(req(`/api/patients/${id}`), { params: Promise.resolve({ id }) });
    expect(get.status).toBe(404);

    const list = await body(await listPatients(req(`/api/patients?phone_number=${uniquePhone}`)));
    expect(list.data!.count).toBe(0);
  });
  it("404 when deleting twice", async () => {
    const created = await body(
      await createPatient(req("/api/patients", { method: "POST", body: JSON.stringify(VALID_PATIENT), headers: { "Content-Type": "application/json" } }))
    );
    const id = created.data!.patient_id as string;
    await deletePatient(req(`/api/patients/${id}`), { params: Promise.resolve({ id }) });
    const again = await deletePatient(req(`/api/patients/${id}`), { params: Promise.resolve({ id }) });
    expect(again.status).toBe(404);
  });
});
