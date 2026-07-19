// Downloadable story card (SPEC-2): the "auto-post to social" replacement — a
// 1080×1350 portrait PNG (IG/WhatsApp-story friendly) the organiser downloads
// and posts themselves, so the platform takes on no OAuth liability. Same satori
// rail as r/[ref]/ticket.png; same PostShareCard layout as the OG image, just
// portrait. Stable route path (not hashed) — the "Download image card" button
// links it directly.
import { ImageResponse } from "next/og";
import { getPublicOrg } from "@/server/public-site/data";
import { publicPost } from "@/server/usecases/org-posts";
import { HttpError } from "@/lib/errors";
import { postCardModel, PostShareCard, STORY_SIZE } from "@/server/og/post-card";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale, DEFAULT_LOCALE } from "@/lib/i18n-constants";

export const contentType = "image/png";
export const revalidate = 300;

type Ctx = { params: Promise<{ orgSlug: string; postSlug: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { orgSlug, postSlug } = await params;
  const data = await getPublicOrg(orgSlug);
  if (!data) return new Response("not found", { status: 404 });
  const org = data.org;
  let post;
  try {
    post = await publicPost(orgSlug, postSlug);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      return new Response("not found", { status: 404 });
    }
    throw err;
  }
  const locale = hasLocale(org.default_locale) ? org.default_locale : DEFAULT_LOCALE;
  const dict = await getDictionary(locale, "public");
  const model = postCardModel({
    branding: [org.branding],
    branded: org.branded,
    orgName: org.name,
    logo: org.logo,
    kind: post.kind,
    title: post.title,
  });
  return new ImageResponse(
    <PostShareCard model={model} eyebrow={t(dict, model.eyebrowKey)} size="story" />,
    STORY_SIZE,
  );
}
