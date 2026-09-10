// ============================================================================
// Unit tests — field validation rules transcribed from the challenge PDF.
// Run: bun test tests/validation.test.ts
// ============================================================================

import { describe, it, expect } from "bun:test";
import {
  normalizePhone,
  normalizeZip,
  normalizeState,
  parseDateOfBirth,
  validateDateOfBirth,
  validateAgentField,
  normalizeLanguage,
  formatPhone,
} from "@/lib/validation/patient";

describe("normalizePhone (valid U.S. 10-digit requirement)", () => {
  it("accepts common formats", () => {
    expect(normalizePhone("(415) 555-0101")).toBe("4155550101");
    expect(normalizePhone("415.555.0101")).toBe("4155550101");
    expect(normalizePhone("+1 415 555 0101")).toBe("4155550101");
    expect(normalizePhone("14155550101")).toBe("4155550101");
    expect(normalizePhone("4155550101")).toBe("4155550101");
  });
  it("rejects the challenge's 3-digit phone example and malformed numbers", () => {
    expect(normalizePhone("555")).toBeNull();
    expect(normalizePhone("555 1234")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("0155550101")).toBeNull(); // NANP: area code can't start 0/1
    expect(normalizePhone("4151550101")).toBeNull(); // exchange can't start 1
  });
  it("formats for speech", () => {
    expect(formatPhone("4155550101")).toBe("(415) 555-0101");
  });
});

describe("normalizeZip (5-digit or ZIP+4)", () => {
  it("accepts 5-digit", () => expect(normalizeZip("94103")).toBe("94103"));
  it("accepts ZIP+4 forms", () => {
    expect(normalizeZip("94103-4180")).toBe("94103-4180");
    expect(normalizeZip("941034180")).toBe("94103-4180");
  });
  it("rejects short/invalid", () => {
    expect(normalizeZip("123")).toBeNull();
    expect(normalizeZip("abcde")).toBeNull();
  });
});

describe("normalizeState (2-letter abbreviation, accepts full names)", () => {
  it("accepts codes and full names", () => {
    expect(normalizeState("CA")).toBe("CA");
    expect(normalizeState("ca")).toBe("CA");
    expect(normalizeState("Colorado")).toBe("CO");
    expect(normalizeState("new york")).toBe("NY");
  });
  it("rejects non-states", () => {
    expect(normalizeState("ZZ")).toBeNull();
    expect(normalizeState("Ontario")).toBeNull();
  });
});

describe("validateDateOfBirth (valid, not in future, MM/DD/YYYY)", () => {
  it("accepts supported formats", () => {
    expect(validateDateOfBirth("04/12/1990").valid).toBe(true);
    expect(validateDateOfBirth("1990-04-12").valid).toBe(true);
    expect(validateDateOfBirth("April 12, 1990").valid).toBe(true);
    expect(validateDateOfBirth("15 de marzo de 1979").valid).toBe(true); // Spanish
    expect(parseDateOfBirth("02/14/2001")).not.toBeNull();
  });
  it("rejects the challenge's future-DOB example and garbage", () => {
    expect(validateDateOfBirth("01/15/2030").valid).toBe(false); // future
    expect(validateDateOfBirth("02/31/1990").valid).toBe(false); // rollover
    expect(validateDateOfBirth("not a date").valid).toBe(false);
    expect(validateDateOfBirth("").valid).toBe(false);
  });
});

describe("validateAgentField (drives per-field re-prompting)", () => {
  it("sex maps synonyms into the enum", () => {
    expect(validateAgentField("sex", "female").value).toBe("Female");
    expect(validateAgentField("sex", "I'd rather not say").value).toBe("Decline to Answer");
    expect(validateAgentField("sex", "banana").valid).toBe(false);
  });
  it("names allow hyphens/apostrophes but reject digits", () => {
    expect(validateAgentField("last_name", "O'Neil-Smith").valid).toBe(true);
    expect(validateAgentField("first_name", "A1").valid).toBe(false);
  });
  it("email rejects malformed", () => {
    expect(validateAgentField("email", "a@b.co").valid).toBe(true);
    expect(validateAgentField("email", "no-at-sign").valid).toBe(false);
  });
  it("state converts spoken names", () => {
    expect(validateAgentField("state", "Florida").value).toBe("FL");
  });
});

describe("normalizeLanguage", () => {
  it("maps spoken variants", () => {
    expect(normalizeLanguage("Hablo español")).toBe("Spanish");
    expect(normalizeLanguage("english")).toBe("English");
  });
});
