// Invite share card: pasting a /join link into WhatsApp/iMessage unfurls as
// a branded "You're invited" poster instead of a bare URL. Invalid/expired
// tokens fall back to a generic card — the image route never leaks validity.
import { ImageResponse } from "next/og";
import { loadInvite } from "@/lib/invites";
import { ogTheme } from "@/server/og/model";
import { CardFrame, OG_SIZE } from "@/server/og/card";

export const alt = "You're invited to join a club on Seazn Club";
export const size = OG_SIZE;
export const contentType = "image/png";

const ROLE_LINE: Record<string, string> = {
  admin: "Help run competitions, entrants and settings",
  viewer: "Follow every fixture, table and result",
  scorer: "Score the matches assigned to you",
  owner: "Full control of the organisation",
};

type Props = { params: Promise<{ token: string }> };

export default async function Image({ params }: Props) {
  const { token } = await params;
  const invite = await loadInvite(token);
  const theme = ogTheme();
  const orgName = invite?.org_name ?? "a club";

  return new ImageResponse(
    (
      <CardFrame theme={theme} orgName={invite?.org_name ?? "Seazn Club"} logo={null}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            justifyContent: "center",
            padding: "0 56px 40px",
            gap: 18,
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 26,
              letterSpacing: 8,
              color: theme.accent,
              fontWeight: 700,
            }}
          >
            YOU&apos;RE INVITED
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 72,
              fontWeight: 800,
              lineHeight: 1.05,
            }}
          >
            Join {orgName}
          </div>
          {invite && (
            <div style={{ display: "flex", fontSize: 30, color: theme.muted }}>
              {ROLE_LINE[invite.role] ?? "Take your place in the club"}
            </div>
          )}
        </div>
      </CardFrame>
    ),
    size,
  );
}
