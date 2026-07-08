// Player photo upload validation. The MIME guard runs before any DB/storage
// I/O, so this regression test needs no database.
import { describe, expect, it } from "vitest";
import type { AuthCtx } from "@/server/api-v1/auth";
import { setPersonPhoto } from "../persons";

const auth: AuthCtx = {
  orgId: "00000000-0000-0000-0000-000000000000",
  via: "session",
  userId: null,
  role: "owner",
  keyId: null,
};

describe("setPersonPhoto", () => {
  it("rejects unsupported image types with 415 before touching the DB", async () => {
    await expect(
      setPersonPhoto(auth, "any-id", { contentType: "text/plain", bytes: Buffer.from("x") }),
    ).rejects.toMatchObject({ status: 415 });
  });
});
