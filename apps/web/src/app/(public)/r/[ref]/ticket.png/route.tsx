// "Save ticket" PNG (v3/05 §3) — the tear-off stub as an image, rendered
// with next/og ImageResponse (the seed of the v3/10 OG renderer). Shows
// exactly what /r/[ref] shows: masked name, ref, status — nothing more.
import { ImageResponse } from "next/og";
import QRCode from "qrcode";
import { publicRegistrationStatusByRef } from "@/server/usecases/registrations";
import { HttpError } from "@/lib/errors";
import { baseUrl } from "@/lib/oauth";

export const dynamic = "force-dynamic";

const STAMP: Record<string, { label: string; color: string }> = {
  pending: { label: "RECEIVED", color: "#b45309" },
  paid: { label: "PAID", color: "#047857" },
  confirmed: { label: "CONFIRMED", color: "#047857" },
  waitlisted: { label: "WAITLIST", color: "#0369a1" },
  withdrawn: { label: "WITHDRAWN", color: "#71717a" },
};

export async function GET(req: Request, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  let view;
  try {
    view = await publicRegistrationStatusByRef(decodeURIComponent(ref));
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      return new Response("not found", { status: 404 });
    }
    throw err;
  }
  const stamp = STAMP[view.status] ?? STAMP.pending!;
  const qr = await QRCode.toDataURL(`${baseUrl(req)}/r/${view.ref_code}`, {
    margin: 1,
    width: 180,
  });
  const dates = view.starts_on
    ? `${view.starts_on}${view.ends_on && view.ends_on !== view.starts_on ? ` – ${view.ends_on}` : ""}`
    : "";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#f6f5f8",
          padding: 40,
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            background: "#ffffff",
            borderRadius: 24,
            border: "1px solid #d4d4d8",
            flex: 1,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              padding: "28px 36px",
              borderBottom: "1px solid #e4e4e7",
            }}
          >
            <div style={{ fontSize: 18, letterSpacing: 4, color: "#71717a", textTransform: "uppercase" }}>
              {view.org_name}
            </div>
            <div style={{ fontSize: 44, fontWeight: 800, color: "#18181b", textTransform: "uppercase" }}>
              {view.competition_name}
            </div>
            <div style={{ fontSize: 22, color: "#52525b" }}>
              {`${view.division_name}${dates ? ` · ${dates}` : ""}`}
            </div>
          </div>
          <div style={{ display: "flex", flex: 1, alignItems: "center", padding: "20px 36px", gap: 32 }}>
            <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
              <div style={{ fontSize: 16, letterSpacing: 3, color: "#71717a", textTransform: "uppercase" }}>
                Entrant
              </div>
              <div style={{ fontSize: 30, fontWeight: 700, color: "#18181b" }}>{view.display_name}</div>
              <div style={{ fontSize: 16, letterSpacing: 3, color: "#71717a", textTransform: "uppercase", marginTop: 18 }}>
                Your reference
              </div>
              <div style={{ fontSize: 52, fontWeight: 800, color: "#18181b", fontFamily: "monospace", letterSpacing: 3 }}>
                {view.ref_code}
              </div>
              <div
                style={{
                  display: "flex",
                  marginTop: 14,
                  fontSize: 26,
                  fontWeight: 800,
                  letterSpacing: 5,
                  color: stamp.color,
                  border: `3px solid ${stamp.color}`,
                  borderRadius: 8,
                  padding: "4px 14px",
                  transform: "rotate(-4deg)",
                  alignSelf: "flex-start",
                }}
              >
                {stamp.label}
              </div>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element -- OG renderer */}
            <img src={qr} alt="" width={180} height={180} style={{ borderRadius: 12 }} />
          </div>
        </div>
      </div>
    ),
    { width: 900, height: 470 },
  );
}
