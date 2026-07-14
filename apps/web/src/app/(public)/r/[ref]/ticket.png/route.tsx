// "Save ticket" PNG (v3/05 §3) — the tear-off stub as an image, rendered
// with next/og ImageResponse (the seed of the v3/10 OG renderer). Shows
// exactly what /r/[ref] shows: masked name, ref, status — nothing more.
// Brand frame: night masthead with the wordmark + ball over the lime pitch
// line, and an ADMIT ONE stub behind a perforation for the QR.
import { ImageResponse } from "next/og";
import QRCode from "qrcode";
import { publicRegistrationStatusByRef } from "@/server/usecases/registrations";
import { HttpError } from "@/lib/errors";
import { baseUrl } from "@/lib/oauth";

export const dynamic = "force-dynamic";

const NIGHT = "#150b36";
const CREAM = "#f5f0e8";
const LIME = "#a3e635";
const BALL = "#ef4444";

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
          background: NIGHT,
          padding: 28,
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            background: "#ffffff",
            borderRadius: 20,
            flex: 1,
            overflow: "hidden",
          }}
        >
          {/* Masthead: the mark — wordmark, ball, pitch line */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              background: NIGHT,
              padding: "16px 32px 4px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", fontSize: 24, fontWeight: 800, letterSpacing: 3, color: CREAM }}>
                SEAZN&nbsp;<span style={{ color: LIME }}>CLUB</span>
              </div>
              <div
                style={{
                  fontSize: 15,
                  letterSpacing: 3,
                  color: "rgba(245,240,232,0.64)",
                  textTransform: "uppercase",
                }}
              >
                {view.org_name}
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 2 }}>
              <div style={{ width: 12, height: 12, borderRadius: 6, background: BALL }} />
            </div>
          </div>
          <div style={{ display: "flex", height: 5, background: LIME }} />

          <div style={{ display: "flex", flex: 1 }}>
            {/* Main panel */}
            <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: "22px 32px" }}>
              <div style={{ fontSize: 38, fontWeight: 800, color: "#18181b", textTransform: "uppercase" }}>
                {view.competition_name}
              </div>
              <div style={{ fontSize: 20, color: "#52525b" }}>
                {`${view.division_name}${dates ? ` · ${dates}` : ""}`}
              </div>

              <div style={{ display: "flex", flexDirection: "column", marginTop: "auto" }}>
                <div style={{ fontSize: 15, letterSpacing: 3, color: "#71717a", textTransform: "uppercase" }}>
                  Entrant
                </div>
                <div style={{ fontSize: 28, fontWeight: 700, color: "#18181b" }}>{view.display_name}</div>
                <div style={{ fontSize: 15, letterSpacing: 3, color: "#71717a", textTransform: "uppercase", marginTop: 14 }}>
                  Your reference
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
                  <div style={{ fontSize: 36, fontWeight: 800, color: "#18181b", fontFamily: "monospace", letterSpacing: 2 }}>
                    {view.ref_code}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      fontSize: 22,
                      fontWeight: 800,
                      letterSpacing: 4,
                      color: stamp.color,
                      border: `3px solid ${stamp.color}`,
                      borderRadius: 8,
                      padding: "3px 12px",
                      transform: "rotate(-4deg)",
                    }}
                  >
                    {stamp.label}
                  </div>
                </div>
              </div>
            </div>

            {/* Tear-off stub: perforation + QR + ADMIT ONE */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                width: 240,
                borderLeft: "3px dashed #d4d4d8",
                gap: 12,
                padding: "16px 20px",
              }}
            >
              {/* next/og ImageResponse (satori) renderer — the next/image
                  component isn't supported inside it, stays <img> */}
              {/* eslint-disable-next-line @next/next/no-img-element -- OG renderer */}
              <img src={qr} alt="" width={150} height={150} style={{ borderRadius: 10 }} />
              <div style={{ fontSize: 13, letterSpacing: 2, color: "#71717a", textTransform: "uppercase" }}>
                Scan at the desk
              </div>
              <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: 6, color: NIGHT }}>
                ADMIT ONE
              </div>
            </div>
          </div>
        </div>
      </div>
    ),
    { width: 900, height: 470 },
  );
}
